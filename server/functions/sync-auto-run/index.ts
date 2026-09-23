import { randomUUID } from "node:crypto";
import { serve } from "../../runtime.js";
import { getPool } from "../../db.js";
import { claimScheduledRun, finishScheduledRun, type ScheduledAttemptOutcome } from "../../scheduler.js";
// Scheduler automático: recorre todas las tiendas con schedule activo y ejecuta
// sync de stock y/o precios si ha pasado el intervalo configurado.
// El servidor Node lo invoca periódicamente; también puede llamarse por HTTP.
import { corsHeaders, getAdminClient } from "../_shared/zoho.js";

const INTERVALS_MS: Record<string, number> = {
  hourly:   1 * 60 * 60 * 1000,
  every6h:  6 * 60 * 60 * 1000,
  daily:   24 * 60 * 60 * 1000,
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function callFunction(name: string, body: unknown) {
  const baseUrl = process.env.INTERNAL_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  const url = `${baseUrl}/api/functions/v1/${name}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.ok ? await r.json() : null;
}

async function sendAlert(storeId: string, operation: string, errorMessage: string) {
  try {
    await callFunction("send-alert-email", { storeId, operation, errorMessage });
  } catch {
    // Silenciar errores del email para no interrumpir el scheduler
  }
}

interface ScheduledOperation {
  storeId: string;
  operation: "stock_sync_run" | "price_sync_run";
  childFunction: "sync-stock-run" | "sync-prices-run";
  intervalMs: number;
}

// Runs one scheduled operation only after atomically claiming its attempt in
// `scheduled_sync_state`. A failed, partial, or still-running attempt stays
// anchored at its claim time and is retried after the configured interval, not
// on the next tick. A 200 response with errors is recorded as a failure. A
// child that reports `already_running` is neutral: the attempt is recorded as
// `skipped`, no alert is sent, and the success anchor is left untouched.
async function runScheduledOperation({
  storeId,
  operation,
  childFunction,
  intervalMs,
}: ScheduledOperation): Promise<string> {
  const pool = getPool();
  const attemptToken = randomUUID();
  const claimed = await claimScheduledRun(pool, { storeId, operation, intervalMs, attemptToken });
  if (!claimed) return "skip (not yet due)";

  let response: any = null;
  let errorMessage: string | null = null;
  try {
    response = await callFunction(childFunction, { storeId });
    if (!response) {
      errorMessage = "La función no respondió correctamente";
    } else if (response.errors > 0) {
      errorMessage = `${response.errors} error(s) · ${response.updated} actualizados`;
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Error inesperado";
  }

  // A child that refused to start because another real run holds the
  // per-(store, operation) advisory lock is neither a success nor a failure:
  // recording it as `skipped` keeps the retry anchored at the claim time and
  // avoids a duplicate alert for a run that is already in progress.
  const skippedReason = response?.skipped === true ? String(response.reason || "skipped") : null;
  const outcome: ScheduledAttemptOutcome = skippedReason
    ? "skipped"
    : errorMessage
      ? "error"
      : "success";
  const recorded = await finishScheduledRun(pool, {
    storeId,
    operation,
    attemptToken,
    outcome,
    errorMessage: skippedReason ? null : errorMessage,
  });

  // A superseded attempt must not overwrite the newer attempt's state or send
  // a duplicate alert.
  if (!recorded) return "skip (attempt superseded)";
  if (skippedReason) {
    return skippedReason === "already_running" ? "skip (already running)" : `skip (${skippedReason})`;
  }
  if (errorMessage) {
    await sendAlert(storeId, operation, errorMessage);
    return `error (${errorMessage})`;
  }
  return `ok (updated:${response.updated ?? "?"}, errors:${response.errors ?? 0})`;
}

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const t0 = Date.now();
  try {
    const admin = getAdminClient();

    // Fetch configured schedules, then remove suspended stores. This replaces
    // the PostgREST embedded join previously used by the edge runtime.
    const { data: schedules, error } = await admin
      .from("sync_settings")
      .select("store_id, stock_enabled, stock_schedule, prices_enabled, prices_schedule")
      .or("stock_schedule.neq.disabled,prices_schedule.neq.disabled");

    if (error) throw error;
    const storeIds = (schedules || []).map((item: any) => item.store_id);
    const { data: activeStores, error: storesError } = await admin
      .from("stores")
      .select("store_id")
      .eq("suspended", false)
      .in("store_id", storeIds);
    if (storesError) throw storesError;
    const activeIds = new Set((activeStores || []).map((item: any) => item.store_id));
    const stores = (schedules || []).filter((item: any) => activeIds.has(item.store_id));
    if (!stores || stores.length === 0) return json({ ran: 0, skipped: 0, elapsed_ms: Date.now() - t0 });

    const results: { store_id: string; stock?: string; prices?: string }[] = [];

    for (const s of stores) {
      const result: { store_id: string; stock?: string; prices?: string } = { store_id: s.store_id };

      // ── Stock ────────────────────────────────────────────────────────────────
      if (s.stock_enabled && s.stock_schedule !== "disabled" && INTERVALS_MS[s.stock_schedule]) {
        result.stock = await runScheduledOperation({
          storeId: s.store_id,
          operation: "stock_sync_run",
          childFunction: "sync-stock-run",
          intervalMs: INTERVALS_MS[s.stock_schedule],
        });
      }

      // ── Prices ───────────────────────────────────────────────────────────────
      if (s.prices_enabled && s.prices_schedule !== "disabled" && INTERVALS_MS[s.prices_schedule]) {
        result.prices = await runScheduledOperation({
          storeId: s.store_id,
          operation: "price_sync_run",
          childFunction: "sync-prices-run",
          intervalMs: INTERVALS_MS[s.prices_schedule],
        });
      }

      results.push(result);
    }

    return json({ ran: results.length, elapsed_ms: Date.now() - t0, results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    console.error("sync-auto-run error", msg);
    return json({ error: msg }, 500);
  }
});

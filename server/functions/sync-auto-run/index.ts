import { serve } from "../../runtime.js";
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

async function getLastRunTime(
  admin: ReturnType<typeof getAdminClient>,
  storeId: string,
  operation: string,
): Promise<number> {
  const { data } = await admin
    .from("sync_logs")
    .select("created_at")
    .eq("store_id", storeId)
    .eq("operation", operation)
    .eq("status", "success")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? new Date(data.created_at).getTime() : 0;
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
    const now = Date.now();

    for (const s of stores) {
      const result: { store_id: string; stock?: string; prices?: string } = { store_id: s.store_id };

      // ── Stock ────────────────────────────────────────────────────────────────
      if (s.stock_enabled && s.stock_schedule !== "disabled" && INTERVALS_MS[s.stock_schedule]) {
        const lastRun = await getLastRunTime(admin, s.store_id, "stock_sync_run");
        if (now - lastRun >= INTERVALS_MS[s.stock_schedule]) {
          const r = await callFunction("sync-stock-run", { storeId: s.store_id });
          if (r && r.errors > 0) {
            await sendAlert(s.store_id, "stock_sync_run", `${r.errors} error(s) · ${r.updated} actualizados`);
          }
          result.stock = r ? `ok (updated:${r.updated ?? "?"}, errors:${r.errors ?? 0})` : "error (null response)";
          if (!r) await sendAlert(s.store_id, "stock_sync_run", "La función no respondió correctamente");
        } else {
          result.stock = "skip (not yet due)";
        }
      }

      // ── Prices ───────────────────────────────────────────────────────────────
      if (s.prices_enabled && s.prices_schedule !== "disabled" && INTERVALS_MS[s.prices_schedule]) {
        const lastRun = await getLastRunTime(admin, s.store_id, "price_sync_run");
        if (now - lastRun >= INTERVALS_MS[s.prices_schedule]) {
          const r = await callFunction("sync-prices-run", { storeId: s.store_id });
          if (r && r.errors > 0) {
            await sendAlert(s.store_id, "price_sync_run", `${r.errors} error(s) · ${r.updated} actualizados`);
          }
          result.prices = r ? `ok (updated:${r.updated ?? "?"}, errors:${r.errors ?? 0})` : "error (null response)";
          if (!r) await sendAlert(s.store_id, "price_sync_run", "La función no respondió correctamente");
        } else {
          result.prices = "skip (not yet due)";
        }
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

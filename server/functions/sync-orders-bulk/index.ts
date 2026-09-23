import { serve } from "../../runtime.js";
// Sincroniza en lote a Zoho todas las órdenes recientes de Tiendanube que no
// estén marcadas como "success" en order_sync_map. Útil para back-fill de
// órdenes manuales o cuando los webhooks no estaban registrados.
import { corsHeaders, getAdminClient, logSync } from "../_shared/zoho.js";
import { getStore, tnFetchJson } from "../_shared/tiendanube.js";
import createSalesorder from "../zoho-create-salesorder/index.js";

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const t0 = Date.now();
  try {
    const { storeId, pages = 2, perPage = 50, onlyMissing = true } = await req.json();
    if (!storeId) return json({ error: "storeId requerido" }, 400);

    const admin = getAdminClient();
    const store = await getStore(admin, storeId);

    // Recolectar órdenes recientes
    const allOrders: any[] = [];
    for (let p = 1; p <= pages; p++) {
      try {
        const list = await tnFetchJson<any[]>(
          store,
          `/orders?page=${p}&per_page=${perPage}`,
        );
        if (!list || list.length === 0) break;
        allOrders.push(...list);
        if (list.length < perPage) break;
      } catch (e) {
        console.error("TN orders fetch page", p, e);
        break;
      }
    }

    // Filtrar las que no están en success
    const ids = allOrders.map((o) => o.id);
    const { data: maps } = await admin
      .from("order_sync_map")
      .select("tiendanube_order_id, status")
      .eq("store_id", storeId)
      .in("tiendanube_order_id", ids.length ? ids : [-1]);

    const successSet = new Set(
      (maps || [])
        .filter((m: any) => m.status === "success")
        .map((m: any) => Number(m.tiendanube_order_id)),
    );

    const toSync = onlyMissing
      ? allOrders.filter((o) => !successSet.has(o.id))
      : allOrders;

    let okCount = 0;
    let errCount = 0;
    let skipCount = 0;
    const errors: Array<{ id: number; error: string }> = [];

    for (const o of toSync) {
      try {
        const r = await createSalesorder(new Request("http://internal/functions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storeId, orderId: o.id, event: "bulk" }),
        }));
        const j = await r.json();
        if (j?.skipped) skipCount++;
        else if (j?.ok || j?.salesorder_id) okCount++;
        else {
          errCount++;
          errors.push({ id: o.id, error: j?.error || "unknown" });
        }
      } catch (e) {
        errCount++;
        errors.push({ id: o.id, error: e instanceof Error ? e.message : "error" });
      }
    }

    await logSync(admin, storeId, {
      operation: "orders_bulk_sync",
      status: errCount === 0 ? "success" : "error",
      message: `Bulk órdenes: ${okCount} ok, ${skipCount} omitidas, ${errCount} error`,
      duration_ms: Date.now() - t0,
      payload: { total: toSync.length, errors: errors.slice(0, 20) },
    });

    return json({
      ok: true,
      total_checked: allOrders.length,
      attempted: toSync.length,
      success: okCount,
      skipped: skipCount,
      errors: errCount,
      error_samples: errors.slice(0, 10),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    console.error("sync-orders-bulk error", msg);
    return json({ error: msg }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

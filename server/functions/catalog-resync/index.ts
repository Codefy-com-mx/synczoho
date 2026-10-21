import { serve } from "../../runtime.js";
// Estado y resincronización del catálogo local de Tiendanube.
// POST { storeId, action?: "status" | "resync" } → { catalog_status, catalog_synced_at, missing_scopes }
import { getPool } from "../../db.js";
import { corsHeaders } from "../_shared/zoho.js";
import { enqueueBackfill } from "../_shared/tn-catalog.js";
import { missingScopes } from "../_shared/scopes.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { storeId, action = "status" } = await req.json();
    if (!storeId) return json({ error: "storeId requerido" }, 400);
    if (action !== "status" && action !== "resync") return json({ error: "action inválida" }, 400);

    const id = String(storeId);
    const pool = getPool();
    if (action === "resync") {
      // Primero encolar: si falla, el estado no cambia y la tienda no queda en 'pending' sin evento.
      const queued = await enqueueBackfill(id);
      // Ya había un backfill sin procesar (quizá en backoff): adelantarlo para que el clic tenga efecto.
      if (!queued) {
        await pool.query(
          "UPDATE webhook_events SET next_attempt_at = now() WHERE store_id = $1 AND event_type = 'internal/backfill' AND processed = false",
          [id],
        );
      }
    }
    const { rows } = action === "resync"
      ? await pool.query(
          "UPDATE stores SET catalog_status = 'pending' WHERE store_id = $1 RETURNING catalog_status, catalog_synced_at, scopes",
          [id],
        )
      : await pool.query("SELECT catalog_status, catalog_synced_at, scopes FROM stores WHERE store_id = $1", [id]);
    if (!rows[0]) return json({ error: "Tienda no encontrada" }, 404);
    return json({
      catalog_status: rows[0].catalog_status,
      catalog_synced_at: rows[0].catalog_synced_at,
      missing_scopes: missingScopes(rows[0].scopes),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    console.error("catalog-resync error", msg);
    return json({ error: "No se pudo iniciar la resincronización" }, 500);
  }
});

import { serve } from "../../runtime.js";
// Estado y resincronización del catálogo local de Tiendanube.
// POST { storeId, action?: "status" | "resync" } → { catalog_status, catalog_synced_at }
import { getPool } from "../../db.js";
import { corsHeaders } from "../_shared/zoho.js";
import { enqueueBackfill } from "../_shared/tn-catalog.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { storeId, action = "status" } = await req.json();
    if (!storeId) return json({ error: "storeId requerido" }, 400);
    if (action !== "status" && action !== "resync") return json({ error: "action inválida" }, 400);

    const id = String(storeId);
    const { rows } = action === "resync"
      ? await getPool().query(
          "UPDATE stores SET catalog_status = 'pending' WHERE store_id = $1 RETURNING catalog_status, catalog_synced_at",
          [id],
        )
      : await getPool().query("SELECT catalog_status, catalog_synced_at FROM stores WHERE store_id = $1", [id]);
    if (!rows[0]) return json({ error: "Tienda no encontrada" }, 404);
    if (action === "resync") await enqueueBackfill(id);
    return json({ catalog_status: rows[0].catalog_status, catalog_synced_at: rows[0].catalog_synced_at });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    console.error("catalog-resync error", msg);
    return json({ error: msg }, 500);
  }
});

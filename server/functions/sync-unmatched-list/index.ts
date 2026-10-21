import { serve } from "../../runtime.js";
// Devuelve SKUs que existen en Zoho pero no en Tiendanube, y viceversa.
// Útil para detectar productos huérfanos en ambas plataformas.
import {
  corsHeaders,
  getAdminClient,
  getZohoConnection,
  zohoFetch,
} from "../_shared/zoho.js";
import { getCatalogStatus, loadCatalog } from "../_shared/tn-catalog.js";

function norm(s: unknown) {
  return (s ?? "").toString().trim().toUpperCase();
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const t0 = Date.now();
  try {
    const { storeId } = await req.json();
    if (!storeId) return json({ error: "storeId requerido" }, 400);

    if ((await getCatalogStatus(storeId)) === "pending") {
      return json({ skipped: true, reason: "catalog_not_ready" });
    }

    const admin = getAdminClient();
    const conn = await getZohoConnection(admin, storeId);

    // 1) SKUs de Zoho
    const zohoItems: { item_id: string; name: string; sku: string; rate: number; stock_on_hand: number }[] = [];
    let page = 1;
    while (true) {
      const r = await zohoFetch(admin, conn, `/inventory/v1/items?per_page=200&page=${page}`);
      const j = await r.json();
      if (!r.ok) throw new Error(`Zoho items ${r.status}`);
      for (const it of j.items || []) {
        if (norm(it.sku)) {
          zohoItems.push({
            item_id: it.item_id,
            name: it.name,
            sku: norm(it.sku),
            rate: Number(it.rate ?? 0),
            stock_on_hand: Number(it.stock_on_hand ?? 0),
          });
        }
      }
      if (!j.page_context?.has_more_page) break;
      if (++page > 50) break;
    }

    // 2) SKUs de Tiendanube desde la caché local. La caché no guarda el nombre del producto.
    const tnItems: { product_id: number; product_name: string; variant_id: number; sku: string; price: number; stock: number }[] = [];
    for (const v of await loadCatalog(storeId)) {
      const sku = norm(v.sku);
      if (!sku) continue;
      tnItems.push({
        product_id: v.product_id,
        product_name: "",
        variant_id: v.variant_id,
        sku,
        price: v.price,
        stock: v.inventory_levels.reduce((sum, l) => sum + l.stock, 0),
      });
    }

    // 3) Cruzar
    const zohoSkus = new Set(zohoItems.map((i) => i.sku));
    const tnSkus = new Set(tnItems.map((i) => i.sku));

    // En Zoho pero no en TN (potencial importación pendiente)
    const zohoOnly = zohoItems.filter((i) => !tnSkus.has(i.sku));
    // En TN pero no en Zoho (productos huérfanos en TN)
    const tnOnly = tnItems.filter((i) => !zohoSkus.has(i.sku));

    return json({
      elapsed_ms: Date.now() - t0,
      zoho_total: zohoItems.length,
      tn_total: tnItems.length,
      zoho_only: {
        count: zohoOnly.length,
        items: zohoOnly.slice(0, 200),
      },
      tn_only: {
        count: tnOnly.length,
        items: tnOnly.slice(0, 200),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    console.error("sync-unmatched-list error", msg);
    return json({ error: msg }, 500);
  }
});

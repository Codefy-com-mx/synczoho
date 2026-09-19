import { serve } from "../../runtime.js";
// Lista órdenes de Tiendanube enriquecidas con estado de sync a Zoho.
import { corsHeaders, getAdminClient } from "../_shared/zoho.js";
import { getStore, tnFetchJson } from "../_shared/tiendanube.js";

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { storeId, page = 1, perPage = 25, status } = await req.json();
    if (!storeId) {
      return new Response(JSON.stringify({ error: "storeId requerido" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const admin = getAdminClient();
    const store = await getStore(admin, storeId);
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
    });
    if (status) params.set("status", status);
    const orders = await tnFetchJson<any[]>(store, `/orders?${params.toString()}`);

    const ids = orders.map((o) => o.id);
    const { data: maps } = await admin
      .from("order_sync_map")
      .select("tiendanube_order_id, status, zoho_salesorder_id, zoho_invoice_id, last_error, last_synced_at")
      .eq("store_id", storeId)
      .in("tiendanube_order_id", ids.length ? ids : [-1]);

    const mapById = new Map<number, any>();
    (maps || []).forEach((m: any) => mapById.set(Number(m.tiendanube_order_id), m));

    const enriched = orders.map((o) => {
      const m = mapById.get(o.id);
      return {
        id: o.id,
        number: o.number,
        contact_name: o.contact_name,
        contact_email: o.contact_email,
        status: o.status,
        payment_status: o.payment_status,
        total: o.total,
        currency: o.currency,
        created_at: o.created_at,
        sync_status: m?.status || "not_synced",
        zoho_salesorder_id: m?.zoho_salesorder_id || null,
        zoho_invoice_id: m?.zoho_invoice_id || null,
        last_error: m?.last_error || null,
        last_synced_at: m?.last_synced_at || null,
      };
    });

    return new Response(JSON.stringify({ orders: enriched, page, perPage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

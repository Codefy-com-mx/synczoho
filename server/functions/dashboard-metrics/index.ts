import { serve } from "../../runtime.js";
import { corsHeaders, getAdminClient } from "../_shared/zoho.js";

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { store_id } = await req.json().catch(() => ({}));
    if (!store_id) {
      return new Response(JSON.stringify({ error: "store_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = getAdminClient();

    const [products, orders, customers, stock, lastLog] = await Promise.all([
      admin.from("product_sync_map").select("status").eq("store_id", store_id),
      admin.from("order_sync_map").select("status").eq("store_id", store_id),
      admin.from("customer_sync_map").select("status").eq("store_id", store_id),
      admin.from("stock_sync_state").select("id", { count: "exact", head: true }).eq("store_id", store_id),
      admin
        .from("sync_logs")
        .select("created_at")
        .eq("store_id", store_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const isOk = (s: string) =>
      s === "success" || s === "synced" || s === "linked" || s === "imported";

    const metrics = {
      productsSynced: (products.data || []).filter((p: any) => isOk(p.status)).length,
      productsPending: (products.data || []).filter((p: any) => p.status === "pending").length,
      ordersSynced: (orders.data || []).filter((o: any) => isOk(o.status)).length,
      ordersError: (orders.data || []).filter((o: any) => o.status === "error").length,
      customersSynced: (customers.data || []).filter((c: any) => isOk(c.status)).length,
      stockSynced: stock.count || 0,
      lastActivity: lastLog.data?.created_at || null,
    };

    return new Response(JSON.stringify({ metrics }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

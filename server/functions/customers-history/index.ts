import { serve } from "../../runtime.js";
import { corsHeaders, getAdminClient } from "../_shared/zoho.js";

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { store_id, limit = 50 } = await req.json().catch(() => ({}));
    if (!store_id) {
      return new Response(JSON.stringify({ error: "store_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const admin = getAdminClient();
    const { data, error } = await admin
      .from("customer_sync_map")
      .select("id, email, zoho_contact_id, status, last_error, last_synced_at")
      .eq("store_id", store_id)
      .order("last_synced_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return new Response(JSON.stringify({ customers: data || [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

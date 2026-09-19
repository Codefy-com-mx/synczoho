import { serve } from "../../runtime.js";
// Devuelve los últimos logs de sincronización de una tienda.
// Soporta filtros por operation y status.
import { corsHeaders, getAdminClient } from "../_shared/zoho.js";

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const admin = getAdminClient();
    const body = await req.json().catch(() => ({}));
    const storeId: string = body.store_id;
    const limit = Math.min(200, Number(body.limit) || 50);
    const operation: string | null = body.operation || null; // filtro opcional
    const status: string | null = body.status || null;       // 'success' | 'error'

    if (!storeId) {
      return new Response(JSON.stringify({ error: "store_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let query = admin
      .from("sync_logs")
      .select("id, operation, status, message, duration_ms, payload, created_at")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (operation) query = query.eq("operation", operation);
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw error;

    return new Response(JSON.stringify({ logs: data || [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

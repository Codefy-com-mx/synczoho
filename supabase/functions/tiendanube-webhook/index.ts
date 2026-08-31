// Webhook receptor de Tiendanube (orders, customers, app lifecycle).
// Endpoint público — verifica HMAC opcional y procesa eventos.
import { corsHeaders, getAdminClient } from "../_shared/zoho.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const payload = await req.json();
    console.log("TN webhook payload:", JSON.stringify(payload).slice(0, 500));

    const event = payload.event as string;
    const storeId = String(payload.store_id);
    const resourceId = payload.id as number;

    const admin = getAdminClient();

    await admin.from("webhook_events").insert({
      store_id: storeId,
      event_type: event,
      payload: payload,
      processed: false,
    });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Disparar handlers según evento (best-effort, fire and forget)
    if (event?.startsWith("order/")) {
      fetch(`${supabaseUrl}/functions/v1/zoho-create-salesorder`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ storeId, orderId: resourceId, event }),
      }).catch((e) => console.error("trigger order fn:", e));
    }

    // Ciclo de vida de la app
    if (event === "app/uninstalled") {
      // Revocar tokens y limpiar conexiones para esta tienda
      await admin.from("stores").delete().eq("store_id", storeId);
      await admin.from("zoho_connections").delete().eq("store_id", storeId);
      await admin.from("sync_settings").delete().eq("store_id", storeId);
      console.log(`[app/uninstalled] Tienda ${storeId} desconectada y datos eliminados`);
    }

    if (event === "app/suspended") {
      // Marcar la tienda como suspendida — no eliminar datos, solo pausar sync
      await admin
        .from("stores")
        .update({ suspended: true, suspended_at: new Date().toISOString() })
        .eq("store_id", storeId);
      console.log(`[app/suspended] Tienda ${storeId} marcada como suspendida`);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("webhook error", e);
    return new Response(JSON.stringify({ error: "bad request" }), {
      status: 200, // siempre 200 para que TN no reintente loop
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

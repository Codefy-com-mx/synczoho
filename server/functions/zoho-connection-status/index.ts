import { serve } from "../../runtime.js";
// Edge function: devuelve el estado de la conexión Zoho de una tienda.
// También verifica que el token de Tiendanube siga siendo válido:
// si fue revocado (app desinstalada), limpia la DB y devuelve store_found: false.
import { TN_API, TN_USER_AGENT } from "../_shared/tiendanube.js";
import { corsHeaders, getAdminClient } from "../_shared/zoho.js";

function gone(reason: string) {
  return new Response(
    JSON.stringify({ connection: null, store_found: false, reason }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

export default serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const admin = getAdminClient();

    const body = await req.json().catch(() => ({}));
    const storeId: string | undefined = body.store_id;
    if (!storeId) {
      return new Response(
        JSON.stringify({ error: "store_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 1. Verificar que la tienda existe en la DB
    const { data: store } = await admin
      .from("stores")
      .select("store_id, access_token")
      .eq("store_id", storeId)
      .maybeSingle();

    if (!store) {
      return gone("store_not_found");
    }

    // 2. Verificar que el token de TN sigue siendo válido
    //    GET /store es el endpoint más liviano disponible.
    //    Un 401 significa que el token fue revocado (app desinstalada desde TN admin).
    try {
      const tnResp = await fetch(`${TN_API}/${storeId}/store`, {
        headers: {
          "Authentication": `bearer ${store.access_token}`,
          "User-Agent": TN_USER_AGENT,
        },
      });

      if (tnResp.status === 401 || tnResp.status === 403) {
        // Token inválido → limpiar todos los datos de la tienda
        console.warn(`[session-check] Token revocado para tienda ${storeId} — limpiando DB`);
        await Promise.allSettled([
          admin.from("zoho_connections").delete().eq("store_id", storeId),
          admin.from("sync_settings").delete().eq("store_id", storeId),
          admin.from("sync_logs").delete().eq("store_id", storeId),
        ]);
        await admin.from("stores").delete().eq("store_id", storeId);
        return gone("token_revoked");
      }
      // Cualquier otro error de TN (5xx, timeout) lo ignoramos — no queremos
      // desloguear al usuario por un problema temporal del lado de TN.
    } catch (tnError) {
      console.warn(`[session-check] Error verificando token TN (ignorado):`, tnError);
    }

    // 3. Obtener estado de la conexión Zoho
    const { data: connection } = await admin
      .from("zoho_connections")
      .select("organization_id, organization_name, status, dc, updated_at")
      .eq("store_id", storeId)
      .maybeSingle();

    return new Response(
      JSON.stringify({ connection: connection || null, store_found: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("zoho-connection-status error", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

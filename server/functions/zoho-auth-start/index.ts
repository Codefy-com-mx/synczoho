import { serve } from "../../runtime.js";
// Edge function: inicia el flujo OAuth de Zoho Inventory
// Devuelve la URL de autorización para que el frontend redireccione al usuario.
import { ACCOUNTS_DOMAINS, corsHeaders, getAdminClient } from "../_shared/zoho.js";

const SCOPES = "ZohoInventory.FullAccess.ALL";

export default serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const clientId = Deno.env.get("ZOHO_CLIENT_ID");

    if (!clientId) {
      return new Response(
        JSON.stringify({ error: "ZOHO_CLIENT_ID not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const storeId: string | undefined = body.store_id;
    const dc: string = body.dc || "com";
    const redirectUri: string = body.redirect_uri;

    if (!storeId || !redirectUri) {
      return new Response(
        JSON.stringify({ error: "store_id and redirect_uri are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Verificar que la tienda existe (usando service role, sin requerir sesión)
    const admin = getAdminClient();
    const { data: store, error: storeErr } = await admin
      .from("stores")
      .select("store_id, user_id")
      .eq("store_id", storeId)
      .maybeSingle();

    if (storeErr || !store) {
      return new Response(JSON.stringify({ error: "Store not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accountsBase = ACCOUNTS_DOMAINS[dc] || ACCOUNTS_DOMAINS.com;

    // El state lleva store_id + dc + user_id (si existe)
    const statePayload = JSON.stringify({
      s: storeId,
      d: dc,
      u: store.user_id || null,
      t: Date.now(),
    });
    const state = btoa(statePayload);

    const authUrl = new URL(`${accountsBase}/oauth/v2/auth`);
    authUrl.searchParams.set("scope", SCOPES);
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", state);

    return new Response(
      JSON.stringify({ auth_url: authUrl.toString(), state }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("zoho-auth-start error", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

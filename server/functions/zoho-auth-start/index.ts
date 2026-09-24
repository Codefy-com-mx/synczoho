import { serve } from "../../runtime.js";
// Edge function: inicia el flujo OAuth de Zoho Inventory
// Devuelve la URL de autorización para que el frontend redireccione al usuario.
import { ACCOUNTS_DOMAINS, corsHeaders, getAdminClient } from "../_shared/zoho.js";
import { createOAuthState } from "../_shared/oauth-state.js";
import { getPool } from "../../db.js";

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
    const appUrl = process.env.APP_URL?.replace(/\/$/, "");
    const redirectUri = appUrl && `${appUrl}/zoho/callback`;

    if (!storeId || !redirectUri || !Object.prototype.hasOwnProperty.call(ACCOUNTS_DOMAINS, dc)) {
      return new Response(
        JSON.stringify({ error: "store_id, APP_URL and valid dc are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // La ruta exige sesión Nexo de esta tienda antes de llegar aquí.
    const admin = getAdminClient();
    const { data: store, error: storeErr } = await admin
      .from("stores")
      .select("store_id")
      .eq("store_id", storeId)
      .maybeSingle();

    if (storeErr || !store) {
      return new Response(JSON.stringify({ error: "Store not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accountsBase = ACCOUNTS_DOMAINS[dc];
    const { state, nonce, expiresAt } = createOAuthState(storeId, dc);
    await getPool().query(
      "INSERT INTO zoho_oauth_states (nonce, store_id, expires_at) VALUES ($1, $2, $3)",
      [nonce, storeId, expiresAt],
    );

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
    console.error("zoho-auth-start error", e instanceof Error ? e.name : "unknown");
    return new Response(
      JSON.stringify({ error: "Could not start Zoho authorization" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

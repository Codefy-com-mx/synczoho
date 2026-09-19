import { serve } from "../../runtime.js";
// Edge function: intercambia code -> tokens, lista organizations y guarda la conexión.
import {
  ACCOUNTS_DOMAINS,
  corsHeaders,
  getAdminClient,
  INVENTORY_DOMAINS,
} from "../_shared/zoho.js";

export default serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const clientId = Deno.env.get("ZOHO_CLIENT_ID");
    const clientSecret = Deno.env.get("ZOHO_CLIENT_SECRET");

    if (!clientId || !clientSecret) {
      return new Response(
        JSON.stringify({ error: "Zoho client credentials not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const adminClient = getAdminClient();

    const body = await req.json().catch(() => ({}));
    const code: string | undefined = body.code;
    const state: string | undefined = body.state;
    const redirectUri: string | undefined = body.redirect_uri;
    const organizationId: string | undefined = body.organization_id;
    const organizationName: string | undefined = body.organization_name;

    if (!code || !state || !redirectUri) {
      return new Response(
        JSON.stringify({ error: "code, state and redirect_uri required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let parsedState: { s: string; d: string; u: string | null; t: number };
    try {
      parsedState = JSON.parse(atob(state));
    } catch {
      return new Response(JSON.stringify({ error: "Invalid state" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const storeId = parsedState.s;
    const dc = parsedState.d || "com";
    const accountsBase = ACCOUNTS_DOMAINS[dc] || ACCOUNTS_DOMAINS.com;
    const inventoryBase = INVENTORY_DOMAINS[dc] || INVENTORY_DOMAINS.com;

    // Verificar que la tienda existe (usando service role)
    const { data: store } = await adminClient
      .from("stores")
      .select("store_id")
      .eq("store_id", storeId)
      .maybeSingle();

    if (!store) {
      return new Response(JSON.stringify({ error: "Store not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Caso 1: aún no se eligió organization → intercambiar code y devolver lista
    if (!organizationId) {
      const tokenResp = await fetch(`${accountsBase}/oauth/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code,
        }),
      });

      const tokenData = await tokenResp.json();
      if (!tokenResp.ok || tokenData.error) {
        console.error("Zoho token error", tokenData);
        return new Response(
          JSON.stringify({ error: tokenData.error || "Token exchange failed", details: tokenData }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const accessToken: string = tokenData.access_token;
      const refreshToken: string = tokenData.refresh_token;
      const expiresIn: number = tokenData.expires_in || 3600;
      const scope: string = tokenData.scope || "";

      // Listar organizations
      const orgsResp = await fetch(`${inventoryBase}/inventory/v1/organizations`, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      });
      const orgsData = await orgsResp.json();

      if (!orgsResp.ok) {
        console.error("Zoho orgs error", orgsData);
        return new Response(
          JSON.stringify({ error: "Failed to list organizations", details: orgsData }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const organizations = (orgsData.organizations || []).map((o: any) => ({
        organization_id: String(o.organization_id),
        name: o.name,
        currency_code: o.currency_code,
        country: o.country,
      }));

      // Guardar tokens temporalmente (sin org aún) para poder elegir org sin re-OAuth
      const expiresAt = new Date(Date.now() + (expiresIn - 60) * 1000).toISOString();
      await adminClient
        .from("zoho_connections")
        .upsert(
          {
            store_id: storeId,
            access_token: accessToken,
            refresh_token: refreshToken,
            token_expires_at: expiresAt,
            scope,
            dc,
            status: "pending_org",
          },
          { onConflict: "store_id" },
        );

      return new Response(
        JSON.stringify({
          step: "select_organization",
          organizations,
          dc,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Caso 2: ya se eligió organization → actualizar registro existente
    const { data: existing } = await adminClient
      .from("zoho_connections")
      .select("id, refresh_token, dc")
      .eq("store_id", storeId)
      .maybeSingle();

    if (!existing) {
      return new Response(
        JSON.stringify({ error: "No pending connection found. Restart OAuth." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { error: updateErr } = await adminClient
      .from("zoho_connections")
      .update({
        organization_id: organizationId,
        organization_name: organizationName || null,
        status: "active",
      })
      .eq("store_id", storeId);

    if (updateErr) {
      console.error("Update error", updateErr);
      return new Response(
        JSON.stringify({ error: updateErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ step: "connected", organization_id: organizationId }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("zoho-auth-callback error", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

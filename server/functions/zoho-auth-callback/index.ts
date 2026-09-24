import { serve } from "../../runtime.js";
import { getPool } from "../../db.js";
import { ACCOUNTS_DOMAINS, corsHeaders, INVENTORY_DOMAINS } from "../_shared/zoho.js";
import { verifyOAuthState } from "../_shared/oauth-state.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface Organization { organization_id: string; name: string; currency_code?: string; country?: string }

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const state = typeof body.state === "string" ? verifyOAuthState(body.state) : null;
    if (!state || !Object.prototype.hasOwnProperty.call(ACCOUNTS_DOMAINS, state.d)) return json({ error: "Invalid or expired state" }, 400);
    const pool = getPool();

    if (body.organization_id) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const store = await client.query("SELECT 1 FROM stores WHERE store_id=$1 FOR SHARE", [state.s]);
        if (!store.rowCount) throw new Error("Store not installed");
        const pending = await client.query<{ organizations: Organization[] }>(
          "SELECT organizations FROM zoho_oauth_states WHERE nonce=$1 AND store_id=$2 AND phase='pending_org' AND expires_at>now() FOR UPDATE",
          [state.n, state.s],
        );
        const org = pending.rows[0]?.organizations?.find((item) => item.organization_id === String(body.organization_id));
        if (!org) {
          await client.query("ROLLBACK");
          return json({ error: "Invalid organization or consumed state" }, 400);
        }
        const updated = await client.query(
          "UPDATE zoho_connections SET organization_id=$1, organization_name=$2, status='active', oauth_nonce=NULL WHERE store_id=$3 AND status='pending_org' AND oauth_nonce=$4",
          [org.organization_id, org.name, state.s, state.n],
        );
        if (!updated.rowCount) throw new Error("Pending connection missing");
        await client.query("UPDATE zoho_oauth_states SET phase='complete', organizations=NULL WHERE nonce=$1", [state.n]);
        await client.query("COMMIT");
        return json({ step: "connected", organization_id: org.organization_id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    if (typeof body.code !== "string" || !body.code) return json({ error: "Authorization code required" }, 400);
    const claimed = await pool.query(
      "UPDATE zoho_oauth_states SET phase='exchanging' WHERE nonce=$1 AND store_id=$2 AND phase='issued' AND expires_at>now() RETURNING nonce",
      [state.n, state.s],
    );
    if (!claimed.rowCount) return json({ error: "State already used or expired" }, 400);

    const clientId = process.env.ZOHO_CLIENT_ID;
    const clientSecret = process.env.ZOHO_CLIENT_SECRET;
    const appUrl = process.env.APP_URL?.replace(/\/$/, "");
    if (!clientId || !clientSecret || !appUrl) return json({ error: "OAuth not configured" }, 500);
    const tokenResp = await fetch(`${ACCOUNTS_DOMAINS[state.d]}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret,
        redirect_uri: `${appUrl}/zoho/callback`, code: body.code,
      }),
    });
    const token = await tokenResp.json();
    if (!tokenResp.ok || !token.access_token || !token.refresh_token) return json({ error: "Zoho token exchange failed" }, 400);

    const orgResp = await fetch(`${INVENTORY_DOMAINS[state.d]}/inventory/v1/organizations`, {
      headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` },
    });
    const orgData = await orgResp.json();
    if (!orgResp.ok || !Array.isArray(orgData.organizations)) return json({ error: "Failed to list organizations" }, 502);
    const organizations: Organization[] = orgData.organizations.map((org: Record<string, unknown>) => ({
      organization_id: String(org.organization_id), name: String(org.name || ""),
      currency_code: typeof org.currency_code === "string" ? org.currency_code : undefined,
      country: typeof org.country === "string" ? org.country : undefined,
    }));
    const single = organizations.length === 1 ? organizations[0] : null;
    const expiresAt = new Date(Date.now() + Math.max(60, Number(token.expires_in || 3600) - 60) * 1000);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const store = await client.query("SELECT 1 FROM stores WHERE store_id=$1 FOR SHARE", [state.s]);
      if (!store.rowCount) throw new Error("Store not installed");
      await client.query(`
        INSERT INTO zoho_connections (store_id, access_token, refresh_token, token_expires_at, scope, dc, status, organization_id, organization_name, oauth_nonce)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (store_id) DO UPDATE SET access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
          token_expires_at=EXCLUDED.token_expires_at, scope=EXCLUDED.scope, dc=EXCLUDED.dc,
          status=EXCLUDED.status, organization_id=EXCLUDED.organization_id, organization_name=EXCLUDED.organization_name,
          oauth_nonce=EXCLUDED.oauth_nonce`,
        [state.s, token.access_token, token.refresh_token, expiresAt, token.scope || "", state.d,
          single ? "active" : "pending_org", single?.organization_id || null, single?.name || null,
          single ? null : state.n],
      );
      await client.query("UPDATE zoho_oauth_states SET phase=$1, organizations=$2 WHERE nonce=$3", [
        single ? "complete" : "pending_org", single ? null : JSON.stringify(organizations), state.n,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return single
      ? json({ step: "connected", organization_id: single.organization_id })
      : json({ step: "select_organization", organizations, dc: state.d });
  } catch (error) {
    console.error("zoho-auth-callback error", error instanceof Error ? error.name : "unknown");
    return json({ error: "OAuth callback failed" }, 500);
  }
});

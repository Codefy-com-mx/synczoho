// Helpers compartidos para llamar a Zoho Inventory desde la API Node.
// Maneja refresh automático del access_token cuando está vencido.
import { getDatabase, type DatabaseClient } from "../../db.js";

export const ACCOUNTS_DOMAINS: Record<string, string> = {
  com: "https://accounts.zoho.com",
  eu: "https://accounts.zoho.eu",
  in: "https://accounts.zoho.in",
  "com.au": "https://accounts.zoho.com.au",
  jp: "https://accounts.zoho.jp",
  "com.cn": "https://accounts.zoho.com.cn",
};

export const INVENTORY_DOMAINS: Record<string, string> = {
  com: "https://www.zohoapis.com",
  eu: "https://www.zohoapis.eu",
  in: "https://www.zohoapis.in",
  "com.au": "https://www.zohoapis.com.au",
  jp: "https://www.zohoapis.jp",
  "com.cn": "https://www.zohoapis.com.cn",
};

export const corsHeaders = {
  "Access-Control-Allow-Origin": process.env.APP_ORIGIN || "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export interface ZohoConnection {
  store_id: string;
  organization_id: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  dc: string;
}

export function getAdminClient(): DatabaseClient {
  return getDatabase();
}

export async function getZohoConnection(
  admin: DatabaseClient,
  storeId: string,
): Promise<ZohoConnection> {
  const { data, error } = await admin
    .from("zoho_connections")
    .select("store_id, organization_id, access_token, refresh_token, token_expires_at, dc, status")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(`DB error: ${error.message}`);
  if (!data || data.status !== "active" || !data.organization_id) {
    throw new Error("Zoho no está conectado para esta tienda");
  }
  return data as ZohoConnection;
}

async function refreshAccessToken(
  admin: DatabaseClient,
  conn: ZohoConnection,
): Promise<string> {
  const clientId = Deno.env.get("ZOHO_CLIENT_ID")!;
  const clientSecret = Deno.env.get("ZOHO_CLIENT_SECRET")!;
  const accountsBase = ACCOUNTS_DOMAINS[conn.dc] || ACCOUNTS_DOMAINS.com;

  const resp = await fetch(`${accountsBase}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: conn.refresh_token,
    }),
  });
  const data = await resp.json();
  if (!resp.ok || data.error) {
    throw new Error(`Zoho refresh failed: ${data.error || resp.statusText}`);
  }
  const accessToken = data.access_token as string;
  const expiresIn = (data.expires_in as number) || 3600;
  const expiresAt = new Date(Date.now() + (expiresIn - 60) * 1000).toISOString();

  await admin
    .from("zoho_connections")
    .update({ access_token: accessToken, token_expires_at: expiresAt })
    .eq("store_id", conn.store_id);

  return accessToken;
}

export async function getValidAccessToken(
  admin: DatabaseClient,
  conn: ZohoConnection,
): Promise<string> {
  const expiresAt = new Date(conn.token_expires_at).getTime();
  if (Date.now() < expiresAt - 30_000) return conn.access_token;
  return await refreshAccessToken(admin, conn);
}

export async function zohoFetch(
  admin: DatabaseClient,
  conn: ZohoConnection,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let token = await getValidAccessToken(admin, conn);
  const inventoryBase = INVENTORY_DOMAINS[conn.dc] || INVENTORY_DOMAINS.com;
  const url = `${inventoryBase}${path}${path.includes("?") ? "&" : "?"}organization_id=${conn.organization_id}`;
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Zoho-oauthtoken ${token}`);
  let resp = await fetch(url, { ...init, headers });

  if (resp.status === 401) {
    // Forzar refresh y reintentar 1 vez
    token = await refreshAccessToken(admin, { ...conn, token_expires_at: "1970-01-01" });
    headers.set("Authorization", `Zoho-oauthtoken ${token}`);
    resp = await fetch(url, { ...init, headers });
  }
  return resp;
}

export async function logSync(
  admin: DatabaseClient,
  storeId: string,
  fields: {
    operation: string;
    zoho_item_id?: string | null;
    tiendanube_product_id?: number | null;
    status: "success" | "error" | "skipped";
    message?: string | null;
    duration_ms?: number;
    payload?: unknown;
  },
) {
  try {
    await admin.from("sync_logs").insert({
      store_id: storeId,
      ...fields,
    });
  } catch (e) {
    console.error("logSync error", e);
  }
}

import { createHmac, timingSafeEqual } from "node:crypto";

const publicFunctions = new Set([
  "tiendanube-auth", "tiendanube-webhook", "zoho-auth-callback",
  "privacy-store-redact", "privacy-customer-redact", "privacy-data-request",
]);
const internalFunctions = new Set(["sync-auto-run", "send-alert-email"]);

export function verifySessionToken(token: string, secret: string, now = Date.now()): string | null {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (header.alg !== "HS256") return null;
    const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
    const actual = Buffer.from(parts[2], "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const seconds = now / 1000;
    if (typeof claims.exp !== "number" || claims.exp <= seconds ||
        (typeof claims.nbf === "number" && claims.nbf > seconds)) return null;
    // Tiendanube calls the store ID user_id in its OAuth response.
    const id = claims.store_id ?? claims.storeId ?? claims.user_id;
    return /^[0-9]+$/.test(String(id ?? "")) ? String(id) : null;
  } catch {
    return null;
  }
}

export async function authorizeFunction(name: string, request: Request): Promise<Response | null> {
  if (internalFunctions.has(name)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  if (publicFunctions.has(name)) return null;
  if (request.method === "OPTIONS") {
    const origin = request.headers.get("origin");
    const allowed = process.env.APP_ORIGIN || process.env.APP_URL;
    return new Response(null, {
      status: 204,
      headers: {
        ...(origin && allowed && origin === allowed ? { "Access-Control-Allow-Origin": origin } : {}),
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  const bearer = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") || "");
  const storeId = bearer && verifySessionToken(bearer[1], process.env.TIENDANUBE_CLIENT_SECRET || "");
  if (!storeId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await request.clone().json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      (body.storeId !== undefined && String(body.storeId) !== storeId) ||
      (body.store_id !== undefined && String(body.store_id) !== storeId)) {
    return new Response(JSON.stringify({ error: "Forbidden store" }), { status: 403 });
  }
  // Every merchant endpoint must explicitly name its store; never infer it from localStorage.
  if (body.storeId === undefined && body.store_id === undefined) {
    return new Response(JSON.stringify({ error: "Store ID required" }), { status: 400 });
  }
  return null;
}

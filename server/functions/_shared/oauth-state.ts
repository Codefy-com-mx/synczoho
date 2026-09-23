import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface OAuthState { s: string; d: string; n: string; e: number }

function key(): string {
  const secret = process.env.TIENDANUBE_CLIENT_SECRET;
  if (!secret) throw new Error("TIENDANUBE_CLIENT_SECRET not configured");
  return secret;
}

function mac(value: string): Buffer {
  return createHmac("sha256", key()).update(`zoho-oauth-state:${value}`).digest();
}

export function createOAuthState(storeId: string, dc: string, now = Date.now()): { state: string; nonce: string; expiresAt: Date } {
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now + 10 * 60_000);
  const payload = Buffer.from(JSON.stringify({ s: storeId, d: dc, n: nonce, e: expiresAt.getTime() })).toString("base64url");
  return { state: `${payload}.${mac(payload).toString("base64url")}`, nonce, expiresAt };
}

export function verifyOAuthState(state: string, now = Date.now()): OAuthState | null {
  const parts = state.split(".");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const expected = mac(parts[0]);
  const actual = Buffer.from(parts[1], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (typeof value.s !== "string" || !/^[0-9]+$/.test(value.s) ||
        typeof value.n !== "string" || value.n.length < 32 ||
        typeof value.d !== "string" || typeof value.e !== "number" || value.e <= now) return null;
    return value as OAuthState;
  } catch {
    return null;
  }
}

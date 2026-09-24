import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeFunction, verifySessionToken } from "../../server/auth";
import { createOAuthState, verifyOAuthState } from "../../server/functions/_shared/oauth-state";
import { verifyWebhookSignature } from "../../server/functions/tiendanube-webhook";

const secret = "test-secret";
function jwt(claims: Record<string, unknown>, alg = "HS256"): string {
  const header = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

afterEach(() => { delete process.env.TIENDANUBE_CLIENT_SECRET; });

describe("tenant authorization", () => {
  it("accepts only signed, unexpired merchant sessions for the requested store", async () => {
    process.env.TIENDANUBE_CLIENT_SECRET = secret;
    const token = jwt({ store_id: 123, exp: Math.floor(Date.now() / 1000) + 60 });
    const request = (storeId: string, bearer = token) => new Request("http://localhost/api/functions/v1/sync-settings", {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ storeId }),
    });
    expect(await authorizeFunction("sync-settings", request("123"))).toBeNull();
    expect((await authorizeFunction("sync-settings", request("456")))?.status).toBe(403);
    expect((await authorizeFunction("sync-settings", request("123", token.slice(0, -2) + "xx")))?.status).toBe(401);
    expect(verifySessionToken(jwt({ store_id: 123, exp: 1 }), secret)).toBeNull();
    expect(verifySessionToken(jwt({ store_id: 123, exp: 9999999999 }, "none"), secret)).toBeNull();
    expect((await authorizeFunction("sync-auto-run", request("123")))?.status).toBe(404);
  });
});

describe("webhook and OAuth signatures", () => {
  it("checks Tiendanube HMAC against exact raw bytes", () => {
    const bytes = Buffer.from('{"store_id":123,"event":"order/paid","id":45}');
    const signature = createHmac("sha256", secret).update(bytes).digest("hex");
    expect(verifyWebhookSignature(bytes, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(Buffer.concat([bytes, Buffer.from(" ")]), signature, secret)).toBe(false);
    expect(verifyWebhookSignature(bytes, null, secret)).toBe(false);
  });

  it("rejects modified and expired Zoho state", () => {
    process.env.TIENDANUBE_CLIENT_SECRET = secret;
    const { state } = createOAuthState("123", "com", 1000);
    expect(verifyOAuthState(state, 2000)?.s).toBe("123");
    expect(verifyOAuthState(state, 700_001)).toBeNull();
    expect(verifyOAuthState(state.slice(0, -2) + "xx", 2000)).toBeNull();
  });
});

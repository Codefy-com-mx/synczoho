import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { poolQuery, clientQuery, connect } = vi.hoisted(() => ({
  poolQuery: vi.fn(), clientQuery: vi.fn(), connect: vi.fn(),
}));
vi.mock("../../server/db", () => ({ getPool: () => ({ query: poolQuery, connect }) }));
import callback from "../../server/functions/zoho-auth-callback";
import { createOAuthState } from "../../server/functions/_shared/oauth-state";

function request(state: string, code = "oauth-code", organizationId?: string): Request {
  return new Request("https://app.example.com/api/functions/v1/zoho-auth-callback", {
    method: "POST",
    body: JSON.stringify({ state, code, organization_id: organizationId }),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.TIENDANUBE_CLIENT_SECRET = "test-secret";
  process.env.ZOHO_CLIENT_ID = "client";
  process.env.ZOHO_CLIENT_SECRET = "secret";
  process.env.APP_URL = "https://app.example.com";
  poolQuery.mockReset();
  clientQuery.mockReset().mockResolvedValue({ rowCount: 1, rows: [] });
  connect.mockReset().mockResolvedValue({ query: clientQuery, release: vi.fn() });
});
afterEach(() => vi.restoreAllMocks());

describe("Zoho OAuth callback", () => {
  it("exchanges the code once and rejects replayed state", async () => {
    const { state } = createOAuthState("123", "com");
    poolQuery.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access", refresh_token: "refresh", expires_in: 3600,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        organizations: [{ organization_id: "org-1", name: "Mi negocio" }],
      })));
    expect((await callback(request(state))).status).toBe(200);
    expect((await callback(request(state))).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO zoho_connections"), expect.any(Array));
  });

  it("rejects an organization not in the server-side list", async () => {
    const { state } = createOAuthState("123", "com");
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT organizations")) {
        return { rows: [{ organizations: [{ organization_id: "allowed", name: "Mi negocio" }] }] };
      }
      return { rowCount: 1, rows: [] };
    });
    expect((await callback(request(state, "noop", "other"))).status).toBe(400);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE zoho_connections"))).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  writes: [] as Array<{ op: string; values: any }>,
  existing: false,
  syncStoreWebhooks: vi.fn(),
  enqueueBackfill: vi.fn(),
  logs: [] as any[],
}));

vi.mock("../../server/functions/_shared/zoho.js", () => ({
  corsHeaders: {},
  getAdminClient: () => ({
    from: () => {
      const builder: Record<string, any> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.maybeSingle = async () => ({ data: h.existing ? { id: 1 } : null, error: null });
      builder.insert = async (values: any) => { h.writes.push({ op: "insert", values }); return { error: null }; };
      builder.update = (values: any) => { h.writes.push({ op: "update", values }); return builder; };
      return builder;
    },
  }),
  logSync: async (_admin: any, storeId: string, fields: any) => {
    h.logs.push({ storeId, ...fields });
  },
}));

vi.mock("../../server/functions/_shared/webhooks.js", () => ({
  syncStoreWebhooks: h.syncStoreWebhooks,
}));

vi.mock("../../server/functions/_shared/tn-catalog.js", () => ({
  enqueueBackfill: h.enqueueBackfill,
}));

import handler from "../../server/functions/tiendanube-auth/index";

let tokenScope: unknown;

function install() {
  return handler(new Request("https://app.example.com/api/functions/v1/tiendanube-auth", {
    method: "POST",
    body: JSON.stringify({ code: "valid-code" }),
  }));
}

beforeEach(() => {
  process.env.TIENDANUBE_CLIENT_ID = "40863";
  process.env.TIENDANUBE_CLIENT_SECRET = "secret";
  process.env.APP_URL = "https://app.example.com/";
  h.logs = [];
  h.writes = [];
  h.existing = false;
  tokenScope = undefined;
  h.syncStoreWebhooks.mockReset().mockResolvedValue({ created: [], deleted: 0, errors: [] });
  h.enqueueBackfill.mockReset().mockResolvedValue(true);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input.endsWith("/apps/authorize/token")) {
      return Response.json({ access_token: "tn-token", user_id: 123, scope: tokenScope });
    }
    return Response.json({ name: { es: "Demo" }, original_domain: "demo" });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("tiendanube-auth", () => {
  it("registers the store webhooks as part of the installation", async () => {
    const response = await install();

    expect(response.status).toBe(200);
    expect(h.syncStoreWebhooks).toHaveBeenCalledWith(
      expect.objectContaining({ store_id: "123", access_token: "tn-token" }),
      "https://app.example.com",
    );
  });

  it("still completes the installation when webhook registration fails", async () => {
    h.syncStoreWebhooks.mockRejectedValue(new Error("Tiendanube API 500"));

    const response = await install();

    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    expect(h.logs).toEqual([
      expect.objectContaining({ storeId: "123", operation: "webhooks_register", status: "error" }),
    ]);
  });

  it("enqueues a catalog backfill after installing", async () => {
    await install();

    expect(h.enqueueBackfill).toHaveBeenCalledWith("123");
  });

  it("enqueues the backfill even when webhook registration fails", async () => {
    h.syncStoreWebhooks.mockRejectedValue(new Error("Tiendanube API 500"));

    await install();

    expect(h.enqueueBackfill).toHaveBeenCalledWith("123");
  });

  it("does not block the installation when the backfill cannot be enqueued", async () => {
    h.enqueueBackfill.mockRejectedValue(new Error("db down"));

    const response = await install();

    expect(response.status).toBe(200);
    expect(h.logs).toEqual([
      expect.objectContaining({ storeId: "123", operation: "catalog_backfill", status: "error" }),
    ]);
  });

  it("saves the granted scopes when inserting a new store", async () => {
    tokenScope = "read_products,write_products";

    await install();

    expect(h.writes).toEqual([{ op: "insert", values: expect.objectContaining({ scopes: "read_products,write_products" }) }]);
  });

  it("saves the granted scopes when re-installing an existing store", async () => {
    h.existing = true;
    tokenScope = "read_products,write_products,read_locations";

    await install();

    expect(h.writes).toEqual([{ op: "update", values: expect.objectContaining({ scopes: "read_products,write_products,read_locations" }) }]);
  });

  it("stores null, never the string 'undefined', when the token has no scope", async () => {
    await install();
    h.existing = true;
    await install();

    expect(h.writes.map((w) => w.values.scopes)).toEqual([null, null]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enqueueBackfill: vi.fn(),
  syncStoreWebhooks: vi.fn(),
  order: [] as string[],
  queries: [] as Array<{ text: string; values: any[] }>,
  stores: [] as any[],
  logs: [] as any[],
  scopes: null as string | null,
}));

vi.mock("../../server/db.js", () => ({
  getPool: () => ({
    query: async (text: string, values: any[] = []) => {
      h.order.push(`sql:${text.trim().split(/\s+/)[0]}`);
      h.queries.push({ text, values });
      if (/SELECT store_id, access_token/.test(text)) return { rows: h.stores, rowCount: h.stores.length };
      if (/^UPDATE/.test(text)) return { rows: [{ catalog_status: "pending", catalog_synced_at: null, scopes: h.scopes }], rowCount: 1 };
      return { rows: [{ catalog_status: "ready", catalog_synced_at: "2026-10-21T10:00:00Z", scopes: h.scopes }], rowCount: 1 };
    },
  }),
}));

vi.mock("../../server/functions/_shared/tn-catalog.js", () => ({ enqueueBackfill: h.enqueueBackfill }));
vi.mock("../../server/functions/_shared/webhooks.js", () => ({ syncStoreWebhooks: h.syncStoreWebhooks }));
vi.mock("../../server/functions/_shared/zoho.js", () => ({
  corsHeaders: {},
  getAdminClient: () => ({}),
  logSync: async (_admin: any, storeId: string, fields: any) => {
    h.logs.push({ storeId, ...fields });
  },
}));

import handler from "../../server/functions/catalog-resync/index";
import { resyncAllStores } from "../../server/functions/_shared/catalog-bootstrap";

const call = (body: unknown) =>
  handler(new Request("https://app.example.com/api/functions/v1/catalog-resync", {
    method: "POST",
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  h.queries.length = 0;
  h.order = [];
  h.logs = [];
  h.stores = [];
  h.scopes = null;
  h.enqueueBackfill.mockReset().mockImplementation(async () => { h.order.push("enqueue"); return true; });
  h.syncStoreWebhooks.mockReset().mockResolvedValue({ created: [], deleted: 0, errors: [] });
});

describe("catalog-resync", () => {
  it("resync marks the catalog pending and enqueues a backfill", async () => {
    const response = await call({ storeId: "s1", action: "resync" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ catalog_status: "pending" });
    expect(h.enqueueBackfill).toHaveBeenCalledWith("s1");
    expect(h.queries.some((q) => /UPDATE stores SET catalog_status = 'pending'/.test(q.text))).toBe(true);
  });

  it("status only reads and never enqueues", async () => {
    const response = await call({ storeId: "s1", action: "status" });

    expect(await response.json()).toEqual({
      catalog_status: "ready",
      catalog_synced_at: "2026-10-21T10:00:00Z",
      missing_scopes: ["read_products", "write_products", "read_locations", "read_fulfillment_orders"],
    });
    expect(h.enqueueBackfill).not.toHaveBeenCalled();
    expect(h.queries.every((q) => !/UPDATE/.test(q.text))).toBe(true);
    expect(h.order).toEqual(["sql:SELECT"]);
  });

  it("status reports the scopes missing from stores.scopes", async () => {
    h.scopes = "read_products,write_products";
    expect((await (await call({ storeId: "s1", action: "status" })).json()).missing_scopes).toEqual([
      "read_locations",
      "read_fulfillment_orders",
    ]);
    expect(h.queries[0].text).toMatch(/SELECT [^;]*\bscopes\b/);

    h.scopes = "read_products,write_products,read_locations,read_fulfillment_orders";
    expect((await (await call({ storeId: "s1", action: "status" })).json()).missing_scopes).toEqual([]);
  });

  it("resync also reports the missing scopes", async () => {
    h.scopes = "read_products,write_products,read_locations";
    const body = await (await call({ storeId: "s1", action: "resync" })).json();

    expect(body.missing_scopes).toEqual(["read_fulfillment_orders"]);
    expect(h.queries.find((q) => /UPDATE stores/.test(q.text))!.text).toMatch(/RETURNING [^;]*\bscopes\b/);
  });

  it("does not touch the status when the enqueue throws", async () => {
    h.enqueueBackfill.mockRejectedValue(new Error("db down"));

    const response = await call({ storeId: "s1", action: "resync" });

    expect(response.status).toBe(500);
    expect(h.queries.some((q) => /UPDATE stores/.test(q.text))).toBe(false);
  });

  it("sets pending only after a successful enqueue", async () => {
    await call({ storeId: "s1", action: "resync" });

    expect(h.order).toEqual(["enqueue", "sql:UPDATE"]);
    expect(h.queries.some((q) => /next_attempt_at/.test(q.text))).toBe(false);
  });

  it("pulls forward an existing unprocessed backfill, scoped to the store, then sets pending", async () => {
    h.enqueueBackfill.mockImplementation(async () => { h.order.push("enqueue"); return false; });

    const response = await call({ storeId: "s1", action: "resync" });

    expect(response.status).toBe(200);
    const pull = h.queries.find((q) => /next_attempt_at = now\(\)/.test(q.text))!;
    expect(pull.text).toMatch(/store_id = \$1 AND event_type = 'internal\/backfill' AND processed = false/);
    expect(pull.values).toEqual(["s1"]);
    expect(h.queries.map((q) => q.text.match(/UPDATE (\w+)/)?.[1])).toEqual(["webhook_events", "stores"]);
    expect(h.order).toEqual(["enqueue", "sql:UPDATE", "sql:UPDATE"]);
  });

  it("rejects a missing storeId", async () => {
    expect((await call({ action: "status" })).status).toBe(400);
  });
});

describe("resyncAllStores", () => {
  it("re-registers webhooks for every store, survives failures and backfills only pending ones", async () => {
    h.stores = [
      { store_id: "a", access_token: "ta", store_name: "A", catalog_status: "pending" },
      { store_id: "b", access_token: "tb", store_name: "B", catalog_status: "ready" },
      { store_id: "c", access_token: "tc", store_name: "C", catalog_status: "pending" },
    ];
    h.syncStoreWebhooks.mockImplementation(async (store: any) => {
      if (store.store_id === "a") throw new Error("Tiendanube API 500");
      return { created: [], deleted: 0, errors: [] };
    });

    const result = await resyncAllStores("https://app.example.com");

    expect(result).toEqual({ stores: 3, failed: 1 });
    expect(h.syncStoreWebhooks).toHaveBeenCalledTimes(3);
    expect(h.enqueueBackfill.mock.calls.map((c) => c[0])).toEqual(["a", "c"]);
    expect(h.logs).toEqual([expect.objectContaining({ storeId: "a", operation: "webhooks_register", status: "error" })]);
  });
});

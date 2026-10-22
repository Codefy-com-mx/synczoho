import { beforeEach, describe, expect, it, vi } from "vitest";
import { RELEASE_SYNC_LOCK_SQL, TRY_SYNC_LOCK_SQL, syncLockKey } from "../../server/sync-lock";

const h = vi.hoisted(() => ({
  enqueueBackfill: vi.fn(),
  pool: null as any,
  lockPoolRequests: 0,
  settings: null as any,
  zohoItems: [] as any[],
  catalog: [] as any[],
  catalogStatus: "ready" as string,
  mappings: [] as any[],
  zohoDetails: {} as Record<string, any>,
  adjustments: [] as any[],
  zohoItemsStatus: 200,
  stockPriceStatus: 200,
  events: [] as string[],
  fetchCalls: [] as Array<{ path: string; method: string }>,
  logCalls: [] as any[],
  upsertCalls: [] as Array<{ table: string; values: any }>,
  stockPriceBodies: [] as any[],
}));

vi.mock("../../server/db.js", () => ({
  getLockPool: () => {
    h.lockPoolRequests++;
    return h.pool;
  },
}));

vi.mock("../../server/functions/_shared/zoho.js", () => ({
  corsHeaders: {},
  getAdminClient: () => ({
    from: (table: string) => {
      const builder: Record<string, any> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.maybeSingle = async () => ({
        data: table === "sync_settings" ? h.settings : null,
        error: null,
      });
      builder.upsert = async (values: any) => {
        h.upsertCalls.push({ table, values });
        return { error: null };
      };
      return builder;
    },
  }),
  getZohoConnection: async () => ({
    store_id: "store-1",
    organization_id: "org-1",
    access_token: "token",
    refresh_token: "refresh",
    token_expires_at: "2999-01-01T00:00:00.000Z",
    dc: "com",
  }),
  zohoFetch: async (_admin: any, _conn: any, path: string, init?: RequestInit) => {
    const detail = path.match(/^\/inventory\/v1\/items\/([^?]+)$/);
    if (detail) {
      h.events.push(`zoho:item:${detail[1]}`);
      return Response.json({ item: h.zohoDetails[detail[1]] });
    }
    if (path === "/inventory/v1/inventoryadjustments") {
      h.events.push("zoho:adjust");
      h.adjustments.push(JSON.parse(String(init?.body)));
      return Response.json({ code: 0 });
    }
    if (path.startsWith("/inventory/v1/items")) {
      h.events.push("zoho:items");
      if (h.zohoItemsStatus !== 200) {
        return Response.json({ error: "zoho down" }, { status: h.zohoItemsStatus });
      }
      return Response.json({ items: h.zohoItems, page_context: { has_more_page: false } });
    }
    throw new Error(`Unexpected Zoho request: ${path}`);
  },
  logSync: async (_admin: any, storeId: string, fields: any) => {
    h.logCalls.push({ storeId, ...fields });
  },
}));

vi.mock("../../server/functions/_shared/tiendanube.js", () => ({
  getStore: async () => ({ store_id: "store-1", access_token: "tn-token", store_name: "Test" }),
  tnFetchWithRetry: async (_store: any, path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    h.fetchCalls.push({ path, method });
    if (path.startsWith("/products?")) throw new Error(`Unexpected polling: ${path}`);
    if (path === "/products/stock-price") {
      h.events.push("tn:stock-price");
      h.stockPriceBodies.push(JSON.parse(String(init?.body)));
      if (h.stockPriceStatus !== 200) {
        return new Response("chunk failed", { status: h.stockPriceStatus });
      }
      return Response.json({ ok: true });
    }
    if (path.includes("/variants/")) {
      h.events.push("tn:variant");
      return Response.json({ id: 1 });
    }
    return new Response("not found", { status: 404 });
  },
}));

vi.mock("../../server/functions/_shared/tn-catalog.js", () => ({
  getCatalogStatus: async () => h.catalogStatus,
  enqueueBackfill: h.enqueueBackfill,
  loadCatalog: async () => {
    h.events.push("catalog:load");
    return h.catalog;
  },
}));

vi.mock("../../server/functions/_shared/locations.js", () => ({
  ZOHO_TOTAL: "__total__",
  loadOrSeedLocationMappings: async () => h.mappings,
}));

import syncStockRun from "../../server/functions/sync-stock-run/index";

class FakeLockClient {
  readonly owned = new Set<string>();
  released = 0;
  releaseError: Error | undefined;

  constructor(private readonly pool: FakeLockPool) {}

  async query(text: string, values: unknown[] = []) {
    const key = String(values[0]);
    if (text === TRY_SYNC_LOCK_SQL) {
      h.events.push("lock:try");
      if (this.pool.held.has(key)) return { rows: [{ locked: false }] };
      this.pool.held.add(key);
      this.owned.add(key);
      return { rows: [{ locked: true }] };
    }
    if (text === RELEASE_SYNC_LOCK_SQL) {
      h.events.push("lock:release");
      this.pool.held.delete(key);
      this.owned.delete(key);
      return { rows: [{ unlocked: true }] };
    }
    throw new Error(`Unexpected lock SQL: ${text}`);
  }

  release(error?: Error): void {
    this.released++;
    this.releaseError = error;
    for (const key of this.owned) this.pool.held.delete(key);
  }
}

class FakeLockPool {
  readonly held = new Set<string>();
  readonly clients: FakeLockClient[] = [];
  connectCount = 0;

  async connect(): Promise<FakeLockClient> {
    this.connectCount++;
    const client = new FakeLockClient(this);
    this.clients.push(client);
    return client;
  }
}

let pool: FakeLockPool;

async function runHandler(
  body: Record<string, unknown> = {},
): Promise<{ response: Response; payload: any }> {
  const response = await syncStockRun(
    new Request("http://localhost/api/functions/v1/sync-stock-run", {
      method: "POST",
      body: JSON.stringify({ storeId: "store-1", ...body }),
    }),
  );
  return { response, payload: await response.json() };
}

beforeEach(() => {
  h.enqueueBackfill.mockReset().mockResolvedValue(true);
  pool = new FakeLockPool();
  h.pool = pool;
  h.lockPoolRequests = 0;
  h.settings = { stock_enabled: true, stock_direction: "zoho_to_tn", stock_priority: "zoho" };
  h.zohoItems = [{ item_id: "z-1", sku: "SKU-1", stock_on_hand: 5 }];
  h.catalog = [{ product_id: 10, variant_id: 100, sku: "SKU-1", price: 0, promotional_price: null, inventory_levels: [{ location_id: "L1", stock: 3 }] }];
  h.catalogStatus = "ready";
  h.mappings = [{ tn_location_id: "L1", tn_location_name: "Central", zoho_location_id: "ZA", zoho_location_name: "Central" }];
  h.zohoItems = [{ item_id: "z-1", sku: "SKU-1", stock_on_hand: 5, locations: [{ location_id: "ZA", location_stock_on_hand: 5 }] }];
  h.zohoDetails = {};
  h.adjustments = [];
  h.zohoItemsStatus = 200;
  h.stockPriceStatus = 200;
  h.events = [];
  h.fetchCalls = [];
  h.logCalls = [];
  h.upsertCalls = [];
  h.stockPriceBodies = [];
});

describe("sync-stock-run single flight", () => {
  it("holds the advisory lock for the whole real run and releases it after success", async () => {
    const { response, payload } = await runHandler();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ dry_run: false, total: 1, updated: 1, errors: 0 });
    expect(h.events).toEqual([
      "lock:try",
      "zoho:items",
      "catalog:load",
      "tn:stock-price",
      "lock:release",
    ]);
    expect(pool.held.size).toBe(0);
    expect(pool.clients[0].released).toBe(1);
    expect(h.lockPoolRequests).toBe(1);
    expect(h.logCalls).toEqual([
      expect.objectContaining({ operation: "stock_sync_run", status: "success" }),
    ]);
  });

  it("returns a neutral already-running response without any outbound call or write", async () => {
    const key = syncLockKey("store-1", "stock_sync_run");
    pool.held.add(key);

    const { response, payload } = await runHandler();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ skipped: true, reason: "already_running" });
    expect(h.events).toEqual(["lock:try"]);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.upsertCalls).toHaveLength(0);
    expect(h.logCalls).toHaveLength(0);
    expect(pool.held.has(key)).toBe(true);
    expect(pool.clients[0].released).toBe(1);
    expect(h.lockPoolRequests).toBe(1);
  });

  it("releases the lock and writes one terminal error log when the run fails hard", async () => {
    h.zohoItemsStatus = 500;

    const { response } = await runHandler();

    expect(response.status).toBe(500);
    expect(pool.held.size).toBe(0);
    expect(pool.clients[0].released).toBe(1);
    expect(h.events[h.events.length - 1]).toBe("lock:release");
    expect(h.logCalls).toHaveLength(1);
    expect(h.logCalls[0]).toMatchObject({
      storeId: "store-1",
      operation: "stock_sync_run",
      status: "error",
    });
    expect(String(h.logCalls[0].message)).toContain("Zoho items 500");
  });

  it("records a single error log for partial failures without a duplicate terminal row", async () => {
    h.stockPriceStatus = 500;

    const { response, payload } = await runHandler();

    expect(response.status).toBe(200);
    expect(payload.errors).toBe(1);
    expect(h.logCalls).toHaveLength(1);
    expect(h.logCalls[0]).toMatchObject({ operation: "stock_sync_run", status: "error" });
    expect(pool.held.size).toBe(0);
    expect(pool.clients[0].released).toBe(1);
  });

  it("keeps dry runs lock-free with no sync writes", async () => {
    const { response, payload } = await runHandler({ dryRun: true });

    expect(response.status).toBe(200);
    expect(payload.dry_run).toBe(true);
    expect(h.lockPoolRequests).toBe(0);
    expect(pool.connectCount).toBe(0);
    expect(h.events).toEqual(["zoho:items", "catalog:load"]);
    expect(h.upsertCalls).toHaveLength(0);
    expect(h.logCalls).toHaveLength(0);
  });

  it("does not lock or fetch when stock sync is disabled", async () => {
    h.settings = { stock_enabled: false };

    const { response } = await runHandler();

    expect(response.status).toBe(400);
    expect(pool.connectCount).toBe(0);
    expect(h.lockPoolRequests).toBe(0);
    expect(h.events).toHaveLength(0);
  });
});

describe("sync-stock-run Tiendanube writes", () => {
  it("never writes variants one by one: Tiendanube manages stock_management itself", async () => {
    await runHandler();

    expect(h.fetchCalls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("sends at most 50 variants per stock-price request", async () => {
    h.zohoItems = Array.from({ length: 60 }, (_, i) => ({
      item_id: `z-${i}`, sku: `SKU-${i}`, locations: [{ location_id: "ZA", location_stock_on_hand: 5 }],
    }));
    h.catalog = Array.from({ length: 60 }, (_, i) => ({
      product_id: 10, variant_id: 100 + i, sku: `SKU-${i}`, price: 0, promotional_price: null,
      inventory_levels: [{ location_id: "L1", stock: 3 }],
    }));

    const { payload } = await runHandler();

    expect(payload).toMatchObject({ updated: 60, errors: 0 });
    expect(h.stockPriceBodies.map((body) => body.flatMap((p: any) => p.variants).length)).toEqual([50, 10]);
  });
});

describe("sync-stock-run per location", () => {
  it("sends explicit location_id for each mapped location in one PATCH", async () => {
    h.mappings.push({ tn_location_id: "L2", tn_location_name: "Norte", zoho_location_id: "ZB", zoho_location_name: "Norte" });
    h.zohoItems = [{ item_id: "z-1", sku: "SKU-1", locations: [
      { location_id: "ZA", location_stock_on_hand: 5 }, { location_id: "ZB", location_stock_on_hand: 2 },
    ] }];

    const { payload } = await runHandler();

    expect(payload).toMatchObject({ updated: 2, errors: 0, blocked: null });
    expect(h.stockPriceBodies).toEqual([[{
      id: 10,
      variants: [{ id: 100, inventory_levels: [{ location_id: "L1", stock: 5 }, { location_id: "L2", stock: 2 }] }],
    }]]);
    expect(h.upsertCalls.filter((c) => c.table === "stock_sync_state")).toHaveLength(1);
  });

  it("fetches Zoho item detail only for matched items when the list lacks locations", async () => {
    h.zohoItems = [{ item_id: "z-1", sku: "SKU-1", stock_on_hand: 99 }, { item_id: "z-2", sku: "OTHER", stock_on_hand: 1 }];
    h.zohoDetails = { "z-1": { item_id: "z-1", sku: "SKU-1", locations: [{ location_id: "ZA", location_stock_on_hand: 4 }] } };

    const { payload } = await runHandler();

    expect(h.events.filter((e) => e.startsWith("zoho:item:"))).toEqual(["zoho:item:z-1"]);
    expect(payload).toMatchObject({ updated: 1, unmatched: 1 });
    expect(h.stockPriceBodies[0][0].variants[0].inventory_levels).toEqual([{ location_id: "L1", stock: 4 }]);
  });

  it("blocks without PATCH when Tiendanube has 2+ locations and none is mapped", async () => {
    h.mappings = [
      { tn_location_id: "L1", tn_location_name: "Central", zoho_location_id: null, zoho_location_name: null },
      { tn_location_id: "L2", tn_location_name: "Norte", zoho_location_id: null, zoho_location_name: null },
    ];
    h.zohoItems = [{ item_id: "z-1", sku: "SKU-1", stock_on_hand: 5 }];

    const { response, payload } = await runHandler();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ blocked: "locations_unmapped", updated: 0, errors: 0 });
    expect(h.stockPriceBodies).toHaveLength(0);
    expect(h.upsertCalls).toHaveLength(0);
    expect(h.logCalls).toEqual([expect.objectContaining({ operation: "stock_sync_run", status: "error" })]);
    expect(h.logCalls[0].message).toContain(
      "Hay varias ubicaciones en Tiendanube: elige en Configuración cuál recibe el stock total o vincúlalas con Zoho",
    );
    expect(pool.held.size).toBe(0);
  });

  it("reports the unlinked Tiendanube locations when at least one is linked", async () => {
    h.mappings.push({ tn_location_id: "L2", tn_location_name: "Norte", zoho_location_id: null, zoho_location_name: null });

    const { payload } = await runHandler();

    expect(payload).toMatchObject({ blocked: null, unmapped_locations: ["L2"] });
    expect(h.logCalls.at(-1).payload).toMatchObject({ unmapped_locations: ["L2"] });
  });

  it("sends Zoho's total to the ZOHO_TOTAL location only, without fetching item details", async () => {
    h.mappings = [
      { tn_location_id: "L1", tn_location_name: "Central", zoho_location_id: null, zoho_location_name: null },
      { tn_location_id: "L2", tn_location_name: "Norte", zoho_location_id: "__total__", zoho_location_name: "Stock total de Zoho" },
    ];
    h.catalog[0].inventory_levels = [{ location_id: "L1", stock: 3 }, { location_id: "L2", stock: 0 }];
    h.zohoItems = [{ item_id: "z-1", sku: "SKU-1", stock_on_hand: 7 }];

    const { payload } = await runHandler();

    expect(payload).toMatchObject({ blocked: null, updated: 1, errors: 0, unmapped_locations: ["L1"] });
    expect(h.events.filter((e) => e.startsWith("zoho:item:"))).toEqual([]);
    expect(h.stockPriceBodies).toEqual([[{ id: 10, variants: [{ id: 100, inventory_levels: [{ location_id: "L2", stock: 7 }] }] }]]);
  });

  it.each(["zoho_to_tn", "tn_to_zoho", "bidirectional"])("blocks a mixed total + real link state without PATCH or adjustments (%s)", async (direction) => {
    h.settings = { stock_enabled: true, stock_direction: direction, stock_priority: "zoho" };
    h.mappings = [
      { tn_location_id: "L1", tn_location_name: "Central", zoho_location_id: "ZA", zoho_location_name: "Central" },
      { tn_location_id: "L2", tn_location_name: "Norte", zoho_location_id: "__total__", zoho_location_name: "Stock total de Zoho" },
    ];

    const { payload } = await runHandler();

    expect(payload).toMatchObject({ blocked: "locations_mixed", updated: 0, errors: 0 });
    expect(h.stockPriceBodies).toHaveLength(0);
    expect(h.adjustments).toHaveLength(0);
    expect(h.logCalls).toEqual([expect.objectContaining({ status: "error" })]);
    expect(h.logCalls[0].message).toContain(
      "La configuración de ubicaciones mezcla el stock total con vínculos a ubicaciones de Zoho: deja solo uno de los dos en Configuración",
    );
  });

  it("adjusts the Zoho org total without location_id in ZOHO_TOTAL mode", async () => {
    h.settings = { stock_enabled: true, stock_direction: "tn_to_zoho", stock_priority: "zoho" };
    h.mappings = [
      { tn_location_id: "L1", tn_location_name: "Central", zoho_location_id: null, zoho_location_name: null },
      { tn_location_id: "L2", tn_location_name: "Norte", zoho_location_id: "__total__", zoho_location_name: "Stock total de Zoho" },
    ];
    h.catalog[0].inventory_levels = [{ location_id: "L1", stock: 3 }, { location_id: "L2", stock: 2 }];
    h.zohoItems = [{ item_id: "z-1", sku: "SKU-1", stock_on_hand: 7 }];

    await runHandler();

    expect(h.adjustments[0].line_items).toEqual([{ item_id: "z-1", quantity_adjusted: -5 }]);
  });

  it("uses the legacy path without location_id when the locations scope is missing", async () => {
    h.mappings = [];
    h.zohoItems = [{ item_id: "z-1", sku: "SKU-1", stock_on_hand: 5 }];

    await runHandler();

    expect(h.stockPriceBodies[0][0].variants[0].inventory_levels).toEqual([{ stock: 5 }]);
  });

  it("adjusts the mapped Zoho location when Tiendanube is the source", async () => {
    h.settings = { stock_enabled: true, stock_direction: "tn_to_zoho", stock_priority: "zoho" };

    const { payload } = await runHandler();

    expect(payload).toMatchObject({ updated: 1, errors: 0 });
    expect(h.stockPriceBodies).toHaveLength(0);
    expect(h.adjustments).toHaveLength(1);
    expect(h.adjustments[0].line_items).toEqual([{ item_id: "z-1", quantity_adjusted: -2, location_id: "ZA" }]);
  });

  it("pending ensures a backfill is queued and keeps the skip response", async () => {
    h.catalogStatus = "pending";
    const { payload } = await runHandler({});
    expect(payload).toEqual({ skipped: true, reason: "catalog_not_ready" });
    expect(h.enqueueBackfill).toHaveBeenCalledOnce();
    expect(h.enqueueBackfill).toHaveBeenCalledWith("store-1");
  });

  it("a failing backfill enqueue does not change the skip response", async () => {
    h.catalogStatus = "pending";
    h.enqueueBackfill.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { response, payload } = await runHandler({});
    err.mockRestore();
    expect(response.status).toBe(200);
    expect(payload).toEqual({ skipped: true, reason: "catalog_not_ready" });
  });

  it.each(["ready", "stale"] as const)("%s catalog does not enqueue a backfill", async (status) => {
    h.catalogStatus = status;
    await runHandler({});
    expect(h.enqueueBackfill).not.toHaveBeenCalled();
  });

  it("skips with catalog_not_ready before any network call, dry runs included", async () => {
    h.catalogStatus = "pending";

    for (const dryRun of [false, true]) {
      const { payload } = await runHandler({ dryRun });
      expect(payload).toEqual({ skipped: true, reason: "catalog_not_ready" });
    }
    expect(h.events).toEqual([]);
    expect(h.fetchCalls).toHaveLength(0);
  });

  describe("without Tiendanube locations known from location_mappings", () => {
    beforeEach(() => {
      h.zohoItems = [{ item_id: "z-1", sku: "SKU-1", stock_on_hand: 8 }];
    });

    it("(1) blocks with 2 stored unlinked mappings instead of guessing", async () => {
      h.mappings = [
        { tn_location_id: "L1", tn_location_name: "Central", zoho_location_id: null, zoho_location_name: null },
        { tn_location_id: "L2", tn_location_name: "Norte", zoho_location_id: null, zoho_location_name: null },
      ];
      const { payload } = await runHandler();
      expect(payload).toMatchObject({ blocked: "locations_unmapped", updated: 0, errors: 0 });
      expect(h.stockPriceBodies).toHaveLength(0);
    });

    it("(2) blocks when the catalog shows 2 locations and there are no mappings", async () => {
      h.mappings = [];
      h.catalog[0].inventory_levels = [{ location_id: "L1", stock: 3 }, { location_id: "L2", stock: 4 }];
      const { payload } = await runHandler();
      expect(payload).toMatchObject({ blocked: "locations_unmapped" });
      expect(h.stockPriceBodies).toHaveLength(0);
    });

    it("(3) keeps the legacy path when the catalog shows a single location", async () => {
      h.mappings = [];
      await runHandler();
      expect(h.stockPriceBodies[0][0].variants[0].inventory_levels).toEqual([{ stock: 8 }]);
    });

    it("(4) keeps the legacy path when no location is known at all", async () => {
      h.mappings = [];
      h.catalog[0].inventory_levels = [];
      await runHandler();
      expect(h.stockPriceBodies[0][0].variants[0].inventory_levels).toEqual([{ stock: 8 }]);
    });
  });
});

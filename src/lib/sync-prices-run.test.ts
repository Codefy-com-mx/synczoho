import { beforeEach, describe, expect, it, vi } from "vitest";
import { RELEASE_SYNC_LOCK_SQL, TRY_SYNC_LOCK_SQL, syncLockKey } from "../../server/sync-lock";

const h = vi.hoisted(() => ({
  pool: null as any,
  lockPoolRequests: 0,
  zohoItems: [] as any[],
  catalog: [] as any[],
  catalogStatus: "ready" as "pending" | "ready" | "stale",
  zohoItemsStatus: 200,
  stockPriceStatus: 200,
  events: [] as string[],
  fetchCalls: [] as Array<{ path: string; method: string }>,
  logCalls: [] as any[],
  stockPriceBodies: [] as any[],
  settings: { prices_direction: "zoho_to_tn" } as any,
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
    from: () => {
      const b: any = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: h.settings, error: null });
      return b;
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
  zohoFetch: async (_admin: any, _conn: any, path: string) => {
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
    return new Response("not found", { status: 404 });
  },
  getTnDefaultLocationId: async () => 1,
}));

vi.mock("../../server/functions/_shared/tn-catalog.js", () => ({
  getCatalogStatus: async () => h.catalogStatus,
  loadCatalog: async () => {
    h.events.push("catalog:load");
    return h.catalog;
  },
}));

import syncPricesRun from "../../server/functions/sync-prices-run/index";

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
  const response = await syncPricesRun(
    new Request("http://localhost/api/functions/v1/sync-prices-run", {
      method: "POST",
      body: JSON.stringify({ storeId: "store-1", ...body }),
    }),
  );
  return { response, payload: await response.json() };
}

beforeEach(() => {
  pool = new FakeLockPool();
  h.pool = pool;
  h.lockPoolRequests = 0;
  h.zohoItems = [{ item_id: "z-1", sku: "SKU-1", rate: 15, sales_rate: null }];
  h.catalog = [{ product_id: 10, variant_id: 100, sku: "SKU-1", price: 10, promotional_price: null, inventory_levels: [] }];
  h.catalogStatus = "ready";
  h.zohoItemsStatus = 200;
  h.stockPriceStatus = 200;
  h.events = [];
  h.fetchCalls = [];
  h.logCalls = [];
  h.stockPriceBodies = [];
  h.settings = { prices_direction: "zoho_to_tn" };
});

describe("sync-prices-run single flight", () => {
  it("holds the advisory lock for the whole real run and releases it after success", async () => {
    const { response, payload } = await runHandler();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ dry_run: false, updated: 1, errors: 0 });
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
      expect.objectContaining({ operation: "price_sync_run", status: "success" }),
    ]);
  });

  it("returns a neutral already-running response without any outbound call or write", async () => {
    const key = syncLockKey("store-1", "price_sync_run");
    pool.held.add(key);

    const { response, payload } = await runHandler();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ skipped: true, reason: "already_running" });
    expect(h.events).toEqual(["lock:try"]);
    expect(h.fetchCalls).toHaveLength(0);
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
      operation: "price_sync_run",
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
    expect(h.logCalls[0]).toMatchObject({ operation: "price_sync_run", status: "error" });
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
    expect(h.logCalls).toHaveLength(0);
  });
});

describe("sync-prices-run direction", () => {
  it("rejects a real run with 400 when prices flow Tiendanube → Zoho, before any lock or call", async () => {
    h.settings = { prices_direction: "tn_to_zoho" };

    const { response, payload } = await runHandler();

    expect(response.status).toBe(400);
    expect(payload).toEqual({ error: "La dirección de precios es Tiendanube → Zoho" });
    expect(h.events).toEqual([]);
    expect(h.lockPoolRequests).toBe(0);
    expect(h.logCalls).toHaveLength(0);
  });

  it("leaves dry runs unchanged when prices flow Tiendanube → Zoho", async () => {
    h.settings = { prices_direction: "tn_to_zoho" };

    const { response, payload } = await runHandler({ dryRun: true });

    expect(response.status).toBe(200);
    expect(payload.dry_run).toBe(true);
  });
});

describe("sync-prices-run catalog cache", () => {
  it("never polls /products and PATCHes the same prices from the cache", async () => {
    await runHandler();

    expect(h.fetchCalls.map((c) => c.path)).toEqual(["/products/stock-price"]);
    expect(h.stockPriceBodies).toEqual([
      [{ id: 10, variants: [{ id: 100, price: "15.00", promotional_price: null }] }],
    ]);
  });

  it("skips with catalog_not_ready without touching Zoho, Tiendanube or the lock", async () => {
    h.catalogStatus = "pending";

    const { response, payload } = await runHandler();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ skipped: true, reason: "catalog_not_ready" });
    expect(h.events).toEqual([]);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.lockPoolRequests).toBe(0);
    expect(h.logCalls).toHaveLength(0);
  });

  it("still runs when the catalog is stale", async () => {
    h.catalogStatus = "stale";

    const { payload } = await runHandler();

    expect(payload).toMatchObject({ updated: 1, errors: 0 });
  });
});

describe("sync-prices-run batching", () => {
  it("sends at most 50 variants per stock-price request", async () => {
    h.zohoItems = Array.from({ length: 60 }, (_, i) => ({ item_id: `z-${i}`, sku: `SKU-${i}`, rate: 15, sales_rate: null }));
    h.catalog = Array.from({ length: 60 }, (_, i) => ({ product_id: 10, variant_id: 100 + i, sku: `SKU-${i}`, price: 10, promotional_price: null, inventory_levels: [] }));

    const { payload } = await runHandler();

    expect(payload).toMatchObject({ updated: 60, errors: 0 });
    expect(h.stockPriceBodies.map((body) => body.flatMap((p: any) => p.variants).length)).toEqual([50, 10]);
  });
});

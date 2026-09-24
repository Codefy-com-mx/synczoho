import { beforeEach, describe, expect, it, vi } from "vitest";
import { RELEASE_SYNC_LOCK_SQL, TRY_SYNC_LOCK_SQL, syncLockKey } from "../../server/sync-lock";

const h = vi.hoisted(() => ({
  pool: null as any,
  lockPoolRequests: 0,
  zohoItems: [] as any[],
  tnProducts: [] as any[],
  zohoItemsStatus: 200,
  stockPriceStatus: 200,
  events: [] as string[],
  fetchCalls: [] as Array<{ path: string; method: string }>,
  logCalls: [] as any[],
}));

vi.mock("../../server/db.js", () => ({
  getLockPool: () => {
    h.lockPoolRequests++;
    return h.pool;
  },
}));

vi.mock("../../server/functions/_shared/zoho.js", () => ({
  corsHeaders: {},
  getAdminClient: () => ({ from: () => ({}) }),
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
    if (path.startsWith("/products?")) {
      h.events.push("tn:products");
      return Response.json(h.tnProducts);
    }
    if (path === "/products/stock-price") {
      h.events.push("tn:stock-price");
      if (h.stockPriceStatus !== 200) {
        return new Response("chunk failed", { status: h.stockPriceStatus });
      }
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
  getTnDefaultLocationId: async () => 1,
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
  h.tnProducts = [
    { id: 10, variants: [{ id: 100, sku: "SKU-1", price: 10, promotional_price: null }] },
  ];
  h.zohoItemsStatus = 200;
  h.stockPriceStatus = 200;
  h.events = [];
  h.fetchCalls = [];
  h.logCalls = [];
});

describe("sync-prices-run single flight", () => {
  it("holds the advisory lock for the whole real run and releases it after success", async () => {
    const { response, payload } = await runHandler();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ dry_run: false, updated: 1, errors: 0 });
    expect(h.events).toEqual([
      "lock:try",
      "zoho:items",
      "tn:products",
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
    expect(h.events).toEqual(["zoho:items", "tn:products"]);
    expect(h.logCalls).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  zohoItems: [] as any[],
  catalog: [] as any[],
  catalogStatus: "ready" as "pending" | "ready" | "stale",
  zohoCalls: 0,
  tnCalls: [] as string[],
}));

vi.mock("../../server/functions/_shared/zoho.js", () => ({
  corsHeaders: {},
  getAdminClient: () => ({}),
  getZohoConnection: async () => ({ store_id: "store-1" }),
  zohoFetch: async () => {
    h.zohoCalls++;
    return Response.json({ items: h.zohoItems, page_context: { has_more_page: false } });
  },
}));

vi.mock("../../server/functions/_shared/tiendanube.js", () => ({
  getStore: async () => ({ store_id: "store-1", access_token: "tn-token" }),
  tnFetchWithRetry: async (_store: any, path: string) => {
    h.tnCalls.push(path);
    throw new Error(`Unexpected Tiendanube request: ${path}`);
  },
}));

vi.mock("../../server/functions/_shared/tn-catalog.js", () => ({
  getCatalogStatus: async () => h.catalogStatus,
  loadCatalog: async () => h.catalog,
}));

import syncUnmatchedList from "../../server/functions/sync-unmatched-list/index";

async function runHandler() {
  const response = await syncUnmatchedList(
    new Request("http://localhost/api/functions/v1/sync-unmatched-list", {
      method: "POST",
      body: JSON.stringify({ storeId: "store-1" }),
    }),
  );
  return { response, payload: await response.json() };
}

beforeEach(() => {
  h.zohoItems = [
    { item_id: "z-1", name: "Both", sku: "sku-1", rate: 10, stock_on_hand: 3 },
    { item_id: "z-2", name: "Only Zoho", sku: "SKU-2", rate: 5, stock_on_hand: 1 },
  ];
  h.catalog = [
    { product_id: 10, variant_id: 100, sku: "SKU-1", price: 10, promotional_price: null, inventory_levels: [] },
    {
      product_id: 11,
      variant_id: 110,
      sku: " sku-3 ",
      price: 7,
      promotional_price: null,
      inventory_levels: [{ location_id: "a", stock: 2 }, { location_id: "b", stock: 4 }],
    },
  ];
  h.catalogStatus = "ready";
  h.zohoCalls = 0;
  h.tnCalls = [];
});

describe("sync-unmatched-list", () => {
  it("cross-references Zoho with the cached catalog and never polls /products", async () => {
    const { response, payload } = await runHandler();

    expect(response.status).toBe(200);
    expect(h.tnCalls).toEqual([]);
    expect(payload.zoho_total).toBe(2);
    expect(payload.tn_total).toBe(2);
    expect(payload.zoho_only.items.map((i: any) => i.sku)).toEqual(["SKU-2"]);
    expect(payload.tn_only.items).toEqual([
      { product_id: 11, product_name: "", variant_id: 110, sku: "SKU-3", price: 7, stock: 6 },
    ]);
  });

  it("skips with catalog_not_ready without calling Zoho or Tiendanube", async () => {
    h.catalogStatus = "pending";

    const { response, payload } = await runHandler();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ skipped: true, reason: "catalog_not_ready" });
    expect(h.zohoCalls).toBe(0);
    expect(h.tnCalls).toEqual([]);
  });

  it("still runs when the catalog is stale", async () => {
    h.catalogStatus = "stale";

    const { payload } = await runHandler();

    expect(payload.tn_total).toBe(2);
  });
});

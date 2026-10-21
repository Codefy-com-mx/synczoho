import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: any[] }>,
  rowCountFor: (_text: string) => 1 as number,
  rowsFor: (_text: string) => [] as any[],
}));

vi.mock("../../server/db.js", () => ({
  getPool: () => ({
    query: async (text: string, values: any[] = []) => {
      h.queries.push({ text, values });
      return { rows: h.rowsFor(text), rowCount: h.rowCountFor(text) };
    },
  }),
}));

import {
  backfillCatalog,
  enqueueBackfill,
  getCatalogStatus,
  loadCatalog,
  refreshProduct,
  toCatalogVariants,
} from "../../server/functions/_shared/tn-catalog.js";

const store = { store_id: "s1", access_token: "tok", store_name: null };
const sqls = () => h.queries.map((q) => q.text);
const product = (id: number) => ({
  id,
  variants: [{ id: id * 10, sku: `SKU-${id}`, price: "10.50", promotional_price: null, inventory_levels: [{ location_id: "loc1", stock: 3 }] }],
});

beforeEach(() => {
  h.queries.length = 0;
  h.rowCountFor = () => 1;
  h.rowsFor = () => [];
  vi.unstubAllGlobals();
});

describe("toCatalogVariants", () => {
  it("omite variantes sin SKU y normaliza precios a número", () => {
    const out = toCatalogVariants({
      id: 5,
      variants: [
        { id: 1, sku: "A", price: "12.5", promotional_price: "9", inventory_levels: [{ location_id: 7, stock: 2 }] },
        { id: 2, sku: "", price: "1" },
        { id: 3, sku: null, price: "1" },
        { id: 4, sku: "B", price: 3, promotional_price: null },
      ],
    });
    expect(out).toEqual([
      { product_id: 5, variant_id: 1, sku: "A", price: 12.5, promotional_price: 9, inventory_levels: [{ location_id: "7", stock: 2 }] },
      { product_id: 5, variant_id: 4, sku: "B", price: 3, promotional_price: null, inventory_levels: [] },
    ]);
  });
});

describe("refreshProduct", () => {
  it("404 -> deleted y emite DELETE FROM tn_variants", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect(await refreshProduct(store, 9)).toBe("deleted");
    expect(sqls().some((s) => s.includes("DELETE FROM tn_variants"))).toBe(true);
    expect(sqls().some((s) => s.includes("INSERT INTO tn_variants"))).toBe(false);
  });

  it("200 -> upsert primero y luego poda; devuelve updated", async () => {
    const fetchMock = vi.fn(async () => Response.json(product(9)));
    vi.stubGlobal("fetch", fetchMock);
    expect(await refreshProduct(store, 9)).toBe("updated");
    const s = sqls();
    const ins = s.findIndex((x) => x.includes("INSERT INTO tn_variants"));
    const del = s.findIndex((x) => x.includes("DELETE FROM tn_variants"));
    expect(ins).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(ins);
    expect(s[ins]).toContain("ON CONFLICT (store_id, variant_id)");
    expect(String((fetchMock.mock.calls[0] as any)[0])).toContain("/products/9?fields=id,variants");
  });

  it("poda solo variantes ausentes y nunca antes del upsert", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: 9,
      variants: [{ id: 91, sku: "A", price: "1" }, { id: 92, sku: "B", price: "1" }],
    })));
    await refreshProduct(store, 9);
    const del = h.queries.filter((q) => q.text.includes("DELETE FROM tn_variants"));
    expect(del).toHaveLength(1);
    expect(del[0].text).toContain("NOT (variant_id = ANY($3::bigint[]))");
    expect(del[0].values).toEqual(["s1", 9, [91, 92]]);
    expect(h.queries.findIndex((q) => q === del[0])).toBeGreaterThan(
      h.queries.findIndex((q) => q.text.includes("INSERT INTO tn_variants")),
    );
  });

  it("sin variantes con SKU: omite el upsert y poda todo el producto", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: 9, variants: [{ id: 91, sku: "", price: "1" }] })));
    await refreshProduct(store, 9);
    expect(sqls().some((x) => x.includes("INSERT INTO tn_variants"))).toBe(false);
    const del = h.queries.find((q) => q.text.includes("DELETE FROM tn_variants"))!;
    expect(del.values[2]).toEqual([]);
  });
});

describe("backfillCatalog", () => {
  it("37 productos: una sola página corta, queda ready", async () => {
    const fetchMock = vi.fn(async () => Response.json(Array.from({ length: 37 }, (_, i) => product(i + 1))));
    vi.stubGlobal("fetch", fetchMock);
    expect(await backfillCatalog(store)).toEqual({ products: 37, variants: 37 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sqls().some((s) => s.includes("catalog_status = 'ready'"))).toBe(true);
    expect(sqls().some((s) => s.includes("DELETE FROM tn_variants"))).toBe(true);
  });

  it("200 + 37 hace 2 requests a /products?", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () =>
      Response.json(Array.from({ length: n++ === 0 ? 200 : 37 }, (_, i) => product(n * 1000 + i))),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await backfillCatalog(store)).toEqual({ products: 237, variants: 237 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const c of fetchMock.mock.calls) expect(String((c as any)[0])).toContain("/products?");
  });

  it("página de 200 seguida de vacía no entra en bucle", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () =>
      Response.json(n++ === 0 ? Array.from({ length: 200 }, (_, i) => product(i + 1)) : []),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect((await backfillCatalog(store)).products).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sqls().some((s) => s.includes("catalog_status = 'ready'"))).toBe(true);
  });

  it("error de API no marca ready ni purga", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 401 })));
    await expect(backfillCatalog(store)).rejects.toThrow();
    expect(sqls().some((s) => s.includes("catalog_status = 'ready'"))).toBe(false);
    expect(sqls().some((s) => s.includes("DELETE FROM tn_variants"))).toBe(false);
  });
});

describe("enqueueBackfill", () => {
  it("no inserta dos veces", async () => {
    let inserted = 0;
    h.rowCountFor = (text) => (text.includes("webhook_events") ? (inserted++ === 0 ? 1 : 0) : 1);
    expect(await enqueueBackfill("s1")).toBe(true);
    expect(await enqueueBackfill("s1")).toBe(false);
    expect(sqls()[0]).toContain("NOT EXISTS");
    expect(sqls()[0]).toContain("internal/backfill");
  });
});

describe("getCatalogStatus / loadCatalog", () => {
  it("status por defecto pending", async () => {
    expect(await getCatalogStatus("s1")).toBe("pending");
    h.rowsFor = () => [{ catalog_status: "ready" }];
    expect(await getCatalogStatus("s1")).toBe("ready");
  });
  it("loadCatalog convierte numeric a número", async () => {
    h.rowsFor = () => [{ product_id: "5", variant_id: "6", sku: "A", price: "1.5", promotional_price: null, inventory_levels: null }];
    expect(await loadCatalog("s1")).toEqual([
      { product_id: 5, variant_id: 6, sku: "A", price: 1.5, promotional_price: null, inventory_levels: [] },
    ]);
  });
});

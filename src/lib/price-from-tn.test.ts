import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  zohoFetch: vi.fn(),
  getZohoConnection: vi.fn(),
  logSync: vi.fn(),
}));

vi.mock("../../server/db.js", () => ({ getPool: () => ({ query: h.query }) }));
vi.mock("../../server/functions/_shared/zoho.js", () => ({
  getZohoConnection: h.getZohoConnection,
  zohoFetch: h.zohoFetch,
  logSync: h.logSync,
}));

import { applyPricesToZoho, diffPrices } from "../../server/functions/_shared/price-from-tn.js";
import type { CatalogVariant } from "../../server/functions/_shared/tn-catalog.js";

const v = (variant_id: number, price: number, promotional_price: number | null = null, sku = `SKU-${variant_id}`): CatalogVariant =>
  ({ product_id: 1, variant_id, sku, price, promotional_price, inventory_levels: [] });

describe("diffPrices", () => {
  it("devuelve [] si los precios son iguales (eco del webhook)", () => {
    expect(diffPrices([v(1, 10, 8)], [v(1, 10, 8)])).toEqual([]);
  });

  it("ignora diferencias menores a 0.01 y variantes nuevas", () => {
    expect(diffPrices([v(1, 10)], [v(1, 10.004), v(2, 99)])).toEqual([]);
  });

  it("detecta cambio de precio", () => {
    expect(diffPrices([v(1, 10)], [v(1, 12)])).toEqual([{ sku: "SKU-1", price: 12, promotional_price: null }]);
  });

  it("detecta que la promo pasa a null y que aparece una promo", () => {
    expect(diffPrices([v(1, 10, 8)], [v(1, 10, null)])).toEqual([{ sku: "SKU-1", price: 10, promotional_price: null }]);
    expect(diffPrices([v(1, 10)], [v(1, 10, 7)])).toEqual([{ sku: "SKU-1", price: 10, promotional_price: 7 }]);
  });
});

describe("applyPricesToZoho", () => {
  const admin = {} as any;
  beforeEach(() => {
    Object.values(h).forEach((f) => f.mockReset());
    h.getZohoConnection.mockResolvedValue({ store_id: "s1" });
    h.zohoFetch.mockResolvedValue(new Response("{}", { status: 200 }));
  });

  it("hace PUT con rate y sales_rate = promo ?? price", async () => {
    h.query.mockResolvedValue({ rows: [{ zoho_item_id: "z1" }] });
    const r = await applyPricesToZoho(admin, "s1", [
      { sku: "A", price: 10, promotional_price: 8 },
      { sku: "B", price: 20, promotional_price: null },
    ]);
    expect(r).toEqual({ updated: 2, errors: 0 });
    const [, , path, init] = h.zohoFetch.mock.calls[0];
    expect(path).toBe("/inventory/v1/items/z1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ rate: 10, sales_rate: 8 });
    expect(JSON.parse(h.zohoFetch.mock.calls[1][3].body)).toEqual({ rate: 20, sales_rate: 20 });
  });

  it("omite SKU sin mapeo (aviso en log) y no cuenta error", async () => {
    h.query.mockResolvedValue({ rows: [] });
    const r = await applyPricesToZoho(admin, "s1", [{ sku: "X", price: 1, promotional_price: null }]);
    expect(r).toEqual({ updated: 0, errors: 0 });
    expect(h.zohoFetch).not.toHaveBeenCalled();
    expect(h.logSync).toHaveBeenCalledWith(admin, "s1", expect.objectContaining({ operation: "price_from_tn", status: "skipped" }));
  });

  it("cuenta errores por SKU (respuesta no ok o excepción) sin lanzar", async () => {
    h.query.mockResolvedValue({ rows: [{ zoho_item_id: "z1" }] });
    h.zohoFetch.mockResolvedValueOnce(new Response("no", { status: 400 })).mockRejectedValueOnce(new Error("red"));
    const r = await applyPricesToZoho(admin, "s1", [
      { sku: "A", price: 1, promotional_price: null },
      { sku: "B", price: 2, promotional_price: null },
    ]);
    expect(r).toEqual({ updated: 0, errors: 2 });
    expect(h.logSync).toHaveBeenCalledWith(admin, "s1", expect.objectContaining({ operation: "price_from_tn", status: "error" }));
  });

  it("lanza si la conexión con Zoho no está disponible", async () => {
    h.getZohoConnection.mockRejectedValue(new Error("Zoho no está conectado"));
    await expect(applyPricesToZoho(admin, "s1", [{ sku: "A", price: 1, promotional_price: null }])).rejects.toThrow("Zoho");
  });

  it("sin cambios no toca Zoho", async () => {
    expect(await applyPricesToZoho(admin, "s1", [])).toEqual({ updated: 0, errors: 0 });
    expect(h.getZohoConnection).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_STOCK_PRICE_VARIANTS,
  chunkStockPriceBatch,
} from "../../server/functions/_shared/stock-price-batch";

const variants = (productId: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: productId * 1000 + i }));

const variantCount = (chunk: Array<{ variants: unknown[] }>) =>
  chunk.reduce((total, product) => total + product.variants.length, 0);

describe("chunkStockPriceBatch", () => {
  it("caps every request at the 50 variants Tiendanube accepts", () => {
    const products = [
      { id: 1, variants: variants(1, 30) },
      { id: 2, variants: variants(2, 30) },
      { id: 3, variants: variants(3, 5) },
    ];

    const chunks = chunkStockPriceBatch(products);

    expect(MAX_STOCK_PRICE_VARIANTS).toBe(50);
    expect(chunks.map(variantCount)).toEqual([50, 15]);
    expect(chunks.flatMap((chunk) => chunk.flatMap((p) => p.variants))).toHaveLength(65);
  });

  it("splits a single product with more than 50 variants across requests", () => {
    const chunks = chunkStockPriceBatch([{ id: 7, variants: variants(7, 120) }]);

    expect(chunks.map(variantCount)).toEqual([50, 50, 20]);
    expect(chunks.every((chunk) => chunk.every((p) => p.id === 7))).toBe(true);
  });

  it("returns no requests when there is nothing to update", () => {
    expect(chunkStockPriceBatch([])).toEqual([]);
  });
});

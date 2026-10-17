// PATCH /products/stock-price acepta como máximo 50 variantes por request,
// sumando todas las de los productos enviados.
export const MAX_STOCK_PRICE_VARIANTS = 50;

export interface StockPriceProduct<V> {
  id: number;
  variants: V[];
}

/**
 * Agrupa productos en requests de hasta 50 variantes. Un producto con más de
 * 50 variantes se reparte en varios requests.
 */
export function chunkStockPriceBatch<V>(
  products: StockPriceProduct<V>[],
  maxVariants = MAX_STOCK_PRICE_VARIANTS,
): StockPriceProduct<V>[][] {
  const chunks: StockPriceProduct<V>[][] = [];
  let current: StockPriceProduct<V>[] = [];
  let size = 0;
  for (const product of products) {
    for (let i = 0; i < product.variants.length; ) {
      if (size === maxVariants) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      const take = product.variants.slice(i, i + maxVariants - size);
      current.push({ id: product.id, variants: take });
      size += take.length;
      i += take.length;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

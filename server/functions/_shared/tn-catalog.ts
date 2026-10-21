// Caché local del catálogo de Tiendanube (tn_variants / tn_categories).
import { getPool } from "../../db.js";
import { tnFetchWithRetry, type RetryObserver, type TiendanubeStore } from "./tiendanube.js";

export interface CatalogVariant {
  product_id: number;
  variant_id: number;
  sku: string;
  price: number;
  promotional_price: number | null;
  inventory_levels: Array<{ location_id: string; stock: number }>;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 500;

const num = (v: unknown): number => Number(v ?? 0) || 0;

export function toCatalogVariants(product: any): CatalogVariant[] {
  const out: CatalogVariant[] = [];
  for (const v of product?.variants ?? []) {
    const sku = typeof v.sku === "string" ? v.sku.trim() : "";
    if (!sku) continue;
    out.push({
      product_id: Number(product.id),
      variant_id: Number(v.id),
      sku,
      price: num(v.price),
      promotional_price: v.promotional_price == null || v.promotional_price === "" ? null : num(v.promotional_price),
      inventory_levels: (v.inventory_levels ?? []).map((l: any) => ({
        location_id: String(l.location_id),
        stock: num(l.stock),
      })),
    });
  }
  return out;
}

async function upsertVariants(storeId: string, variants: CatalogVariant[]): Promise<void> {
  if (variants.length === 0) return;
  await getPool().query(
    `INSERT INTO tn_variants (store_id, product_id, variant_id, sku, price, promotional_price, inventory_levels, updated_at)
     SELECT $1, v.product_id, v.variant_id, v.sku, v.price, v.promotional_price, v.inventory_levels::jsonb, now()
     FROM unnest($2::bigint[], $3::bigint[], $4::text[], $5::numeric[], $6::numeric[], $7::text[])
       AS v(product_id, variant_id, sku, price, promotional_price, inventory_levels)
     ON CONFLICT (store_id, variant_id) DO UPDATE SET
       product_id = EXCLUDED.product_id, sku = EXCLUDED.sku, price = EXCLUDED.price,
       promotional_price = EXCLUDED.promotional_price, inventory_levels = EXCLUDED.inventory_levels,
       updated_at = now()`,
    [
      storeId,
      variants.map((v) => v.product_id),
      variants.map((v) => v.variant_id),
      variants.map((v) => v.sku),
      variants.map((v) => v.price),
      variants.map((v) => v.promotional_price),
      variants.map((v) => JSON.stringify(v.inventory_levels)),
    ],
  );
}

export async function deleteProduct(storeId: string, productId: number): Promise<void> {
  await getPool().query("DELETE FROM tn_variants WHERE store_id = $1 AND product_id = $2", [storeId, productId]);
}

export async function refreshProduct(store: TiendanubeStore, productId: number): Promise<"updated" | "deleted"> {
  const resp = await tnFetchWithRetry(store, `/products/${productId}?fields=id,variants`);
  if (resp.status === 404) {
    await deleteProduct(store.store_id, productId);
    return "deleted";
  }
  if (!resp.ok) throw new Error(`Tiendanube API ${resp.status} al leer producto ${productId}`);
  const variants = toCatalogVariants(await resp.json());
  // Upsert primero y podar después: el producto nunca queda sin filas para un lector concurrente.
  await upsertVariants(store.store_id, variants);
  await getPool().query(
    "DELETE FROM tn_variants WHERE store_id = $1 AND product_id = $2 AND NOT (variant_id = ANY($3::bigint[]))",
    [store.store_id, productId, variants.map((v) => v.variant_id)],
  );
  return "updated";
}

export async function backfillCatalog(
  store: TiendanubeStore,
  observer?: RetryObserver,
): Promise<{ products: number; variants: number }> {
  const seen: number[] = [];
  let products = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const resp = await tnFetchWithRetry(
      store,
      `/products?per_page=${PAGE_SIZE}&page=${page}&fields=id,variants`,
      {},
      undefined,
      observer,
    );
    if (resp.status === 404) {
      await resp.body?.cancel();
      break; // Tiendanube responde 404 al pasarse de la última página
    }
    if (!resp.ok) throw new Error(`Tiendanube API ${resp.status} al paginar productos`);
    const list: any[] = await resp.json();
    const variants = list.flatMap(toCatalogVariants);
    await upsertVariants(store.store_id, variants);
    for (const v of variants) seen.push(v.variant_id);
    products += list.length;
    if (list.length < PAGE_SIZE) break;
  }
  const pool = getPool();
  await pool.query("DELETE FROM tn_variants WHERE store_id = $1 AND NOT (variant_id = ANY($2::bigint[]))", [
    store.store_id,
    seen,
  ]);
  await pool.query("UPDATE stores SET catalog_status = 'ready', catalog_synced_at = now() WHERE store_id = $1", [
    store.store_id,
  ]);
  return { products, variants: seen.length };
}

export async function refreshCategory(store: TiendanubeStore, categoryId: number): Promise<void> {
  const resp = await tnFetchWithRetry(store, `/categories/${categoryId}`);
  if (resp.status === 404) {
    await getPool().query("DELETE FROM tn_categories WHERE store_id = $1 AND id = $2", [store.store_id, categoryId]);
    return;
  }
  if (!resp.ok) throw new Error(`Tiendanube API ${resp.status} al leer categoría ${categoryId}`);
  const cat = await resp.json();
  await getPool().query(
    `INSERT INTO tn_categories (store_id, id, name, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (store_id, id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
    [store.store_id, categoryId, JSON.stringify(cat.name ?? null)],
  );
}

export async function loadCatalog(storeId: string): Promise<CatalogVariant[]> {
  const { rows } = await getPool().query(
    `SELECT product_id, variant_id, sku, price, promotional_price, inventory_levels
     FROM tn_variants WHERE store_id = $1 AND sku IS NOT NULL
     ORDER BY product_id, variant_id`,
    [storeId],
  );
  return rows.map((r: any) => ({
    product_id: Number(r.product_id),
    variant_id: Number(r.variant_id),
    sku: r.sku,
    price: num(r.price),
    promotional_price: r.promotional_price == null ? null : num(r.promotional_price),
    inventory_levels: r.inventory_levels ?? [],
  }));
}

export async function getCatalogStatus(storeId: string): Promise<"pending" | "ready" | "stale"> {
  const { rows } = await getPool().query("SELECT catalog_status FROM stores WHERE store_id = $1", [storeId]);
  return rows[0]?.catalog_status ?? "pending";
}

export async function enqueueBackfill(storeId: string): Promise<boolean> {
  // ponytail: sin índice único, dos llamadas simultáneas podrían encolar dos; el backfill es idempotente.
  const r = await getPool().query(
    `INSERT INTO webhook_events (store_id, event_type, payload)
     SELECT $1::text, 'internal/backfill', '{}'::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM webhook_events WHERE store_id = $1 AND event_type = 'internal/backfill' AND processed = false
     )`,
    [storeId],
  );
  return (r.rowCount ?? 0) > 0;
}

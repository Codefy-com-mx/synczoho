// Precios Tiendanube → Zoho: detecta cambios entre dos instantáneas de un producto y los aplica al ítem de Zoho.
import { getPool } from "../../db.js";
import type { DatabaseClient } from "../../db.js";
import { logSync, zohoFetch, type ZohoConnection } from "./zoho.js";
import type { CatalogVariant } from "./tn-catalog.js";

const EPSILON = 0.01; // mismo umbral que sync-prices-run

export interface PriceChange {
  sku: string;
  price: number;
  promotional_price: number | null;
}

const differs = (a: number | null, b: number | null) =>
  a === null || b === null ? a !== b : Math.abs(a - b) >= EPSILON;

export function diffPrices(before: CatalogVariant[], after: CatalogVariant[]): PriceChange[] {
  const old = new Map(before.map((b) => [b.variant_id, b]));
  const out: PriceChange[] = [];
  for (const a of after) {
    const b = old.get(a.variant_id);
    if (!b) continue; // variante nueva: nada con qué comparar
    if (differs(a.price, b.price) || differs(a.promotional_price, b.promotional_price)) {
      out.push({ sku: a.sku, price: a.price, promotional_price: a.promotional_price });
    }
  }
  return out;
}

export async function applyPricesToZoho(
  admin: DatabaseClient,
  conn: ZohoConnection,
  storeId: string,
  changes: PriceChange[],
): Promise<{ updated: number; errors: number }> {
  let updated = 0;
  let errors = 0;
  if (changes.length === 0) return { updated, errors };
  for (const c of changes) {
    try {
      const { rows } = await getPool().query(
        "SELECT zoho_item_id FROM product_sync_map WHERE store_id = $1 AND zoho_sku = $2 AND zoho_item_id NOT LIKE 'group:%' LIMIT 1",
        [storeId, c.sku],
      );
      const itemId = rows[0]?.zoho_item_id;
      if (!itemId) {
        await logSync(admin, storeId, {
          operation: "price_from_tn", status: "skipped", message: `SKU ${c.sku} sin mapeo en Zoho`,
        });
        continue;
      }
      const resp = await zohoFetch(admin, conn, `/inventory/v1/items/${itemId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate: c.price, sales_rate: c.promotional_price ?? c.price }),
      });
      if (!resp.ok) throw new Error(`Zoho PUT ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      updated++;
      await logSync(admin, storeId, {
        operation: "price_from_tn", status: "success", zoho_item_id: itemId, message: `SKU ${c.sku}: ${c.price}`,
      });
    } catch (e) {
      errors++;
      await logSync(admin, storeId, {
        operation: "price_from_tn", status: "error", message: `SKU ${c.sku}: ${e instanceof Error ? e.message : "Error"}`,
      });
    }
  }
  return { updated, errors };
}

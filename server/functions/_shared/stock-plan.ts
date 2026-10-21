// Plan de stock por location (MultiCD): puro, sin red ni base de datos.
import type { CatalogVariant } from "./tn-catalog.js";
import type { LocationMapping } from "./locations.js";
import type { StockPriceProduct } from "./stock-price-batch.js";

export interface ZohoStockItem {
  item_id: string;
  sku?: string;
  stock_on_hand?: number;
  actual_available_stock?: number;
  locations?: Array<{ location_id: string; location_stock_on_hand?: number | string }>;
}

export interface StockChange {
  sku: string;
  zoho_item_id: string;
  product_id: number;
  variant_id: number;
  tn_location_id: string | null;
  zoho_location_id: string | null;
  from: number;
  to: number;
  target: "tn" | "zoho";
}

const norm = (s: unknown) => (s ?? "").toString().trim().toUpperCase();

/** Cruza ítems de Zoho con variantes del catálogo por SKU (la primera variante por SKU gana). */
export function matchBySku(zohoItems: ZohoStockItem[], catalog: CatalogVariant[]) {
  const bySku = new Map<string, CatalogVariant>();
  for (const v of catalog) {
    const sku = norm(v.sku);
    if (sku && !bySku.has(sku)) bySku.set(sku, v);
  }
  const pairs: Array<{ item: ZohoStockItem; variant: CatalogVariant }> = [];
  const unmatched: string[] = [];
  for (const item of zohoItems) {
    const sku = norm(item.sku);
    if (!sku) continue;
    const variant = bySku.get(sku);
    if (variant) pairs.push({ item, variant });
    else unmatched.push(item.sku || item.item_id);
  }
  return { pairs, unmatched };
}

/**
 * Cantidad de locations de Tiendanube. Si la consulta en vivo falló (null), usa lo ya conocido
 * (mapeos guardados e inventory_levels de la caché) para no caer al camino legado a ciegas.
 * `null` solo si ninguna fuente conoce una location.
 */
export function deriveTnLocationCount(
  fetched: unknown[] | null, mappings: LocationMapping[], catalog: CatalogVariant[],
): number | null {
  if (fetched) return fetched.length;
  const fromMappings = new Set(mappings.map((m) => m.tn_location_id)).size;
  const fromCatalog = new Set(catalog.flatMap((v) => v.inventory_levels.map((l) => l.location_id))).size;
  return Math.max(fromMappings, fromCatalog) || null;
}

export function planStockChanges(input: {
  zohoItems: ZohoStockItem[];
  catalog: CatalogVariant[];
  mappings: LocationMapping[];
  tnLocationCount: number | null;
  direction: "zoho_to_tn" | "tn_to_zoho" | "bidirectional";
  priority: "zoho" | "tiendanube";
}): { changes: StockChange[]; unmatched: string[]; inSync: number; blocked: "locations_unmapped" | null } {
  const { pairs, unmatched } = matchBySku(input.zohoItems, input.catalog);
  const linked = input.mappings.filter((m) => m.zoho_location_id);
  // Varias locations en Tiendanube y ninguna vinculada: nunca se reparte ni se adivina.
  if (linked.length === 0 && (input.tnLocationCount ?? 0) >= 2) {
    return { changes: [], unmatched, inSync: 0, blocked: "locations_unmapped" };
  }
  const target: "tn" | "zoho" =
    input.direction === "zoho_to_tn" || (input.direction === "bidirectional" && input.priority === "zoho")
      ? "tn"
      : "zoho";

  const changes: StockChange[] = [];
  let inSync = 0;
  const add = (
    item: ZohoStockItem, v: CatalogVariant, tnLoc: string | null, zohoLoc: string | null, zohoQty: number, tnQty: number,
  ) => {
    // Tiendanube exige enteros >= 0; Zoho puede tener fracciones o negativos.
    const from = target === "tn" ? tnQty : zohoQty;
    const to = Math.max(0, Math.floor(target === "tn" ? zohoQty : tnQty));
    if (from === to) { inSync++; return; }
    changes.push({
      sku: item.sku || item.item_id, zoho_item_id: item.item_id, product_id: v.product_id, variant_id: v.variant_id,
      tn_location_id: tnLoc, zoho_location_id: zohoLoc, from, to, target,
    });
  };

  for (const { item, variant } of pairs) {
    if (linked.length === 0) {
      // Camino legado (una sola location o sin scope): stock total, Tiendanube usa su primera location.
      const tnQty = variant.inventory_levels.reduce((sum, l) => sum + l.stock, 0);
      add(item, variant, null, null, Number(item.stock_on_hand ?? item.actual_available_stock ?? 0), tnQty);
      continue;
    }
    // Sin datos por location en Zoho no se sabe cuánto hay en cada almacén: no se toca.
    if (!Array.isArray(item.locations)) continue;
    for (const m of linked) {
      const zl = item.locations.find((l) => String(l.location_id) === m.zoho_location_id);
      const tl = variant.inventory_levels.find((l) => l.location_id === m.tn_location_id);
      add(item, variant, m.tn_location_id, m.zoho_location_id, Number(zl?.location_stock_on_hand ?? 0) || 0, tl?.stock ?? 0);
    }
  }
  return { changes, unmatched, inSync, blocked: null };
}

export function buildStockPatch(
  changes: StockChange[],
): StockPriceProduct<{ id: number; inventory_levels: Array<{ location_id?: string; stock: number }> }>[] {
  type V = { id: number; inventory_levels: Array<{ location_id?: string; stock: number }> };
  const products = new Map<number, Map<number, V>>();
  for (const c of changes) {
    if (c.target !== "tn") continue;
    const variants = products.get(c.product_id) ?? new Map<number, V>();
    products.set(c.product_id, variants);
    const v = variants.get(c.variant_id) ?? { id: c.variant_id, inventory_levels: [] };
    variants.set(c.variant_id, v);
    v.inventory_levels.push(c.tn_location_id == null ? { stock: c.to } : { location_id: c.tn_location_id, stock: c.to });
  }
  return [...products].map(([id, variants]) => ({ id, variants: [...variants.values()] }));
}

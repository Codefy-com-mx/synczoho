// Plan de stock por location (MultiCD): puro, sin red ni base de datos.
import type { CatalogVariant } from "./tn-catalog.js";
import { ZOHO_TOTAL, type LocationMapping } from "./locations.js";
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

const finite = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") return Number.isFinite(Number(v)) ? Number(v) : null;
  return null;
};

/** Stock total de Zoho, o null si el ítem no lo trae (servicios, no inventariables): nunca se asume 0. */
export function zohoTotal(item: { stock_on_hand?: unknown; actual_available_stock?: unknown }): number | null {
  return finite(item.stock_on_hand) ?? finite(item.actual_available_stock);
}

/** Cruza ítems de Zoho con variantes del catálogo por SKU (la primera variante por SKU gana). */
/** Stock por location de Zoho; `undefined` si falta la lista o algún valor viene vacío: nunca se asume 0. */
export function zohoLocationStock(locations: unknown): Array<{ location_id: string; stock: number }> | undefined {
  if (!Array.isArray(locations) || locations.length === 0) return undefined;
  const out: Array<{ location_id: string; stock: number }> = [];
  for (const l of locations) {
    const raw = l?.location_stock_on_hand;
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return undefined;
    out.push({ location_id: String(l.location_id), stock: n });
  }
  return out;
}

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
}): { changes: StockChange[]; unmatched: string[]; inSync: number; blocked: "locations_unmapped" | "locations_mixed" | null } {
  const { pairs, unmatched } = matchBySku(input.zohoItems, input.catalog);
  const linked = input.mappings.filter((m) => m.zoho_location_id);
  // Total y vínculos reales a la vez publicarían las mismas unidades dos veces: no se toca nada.
  if (linked.some((m) => m.zoho_location_id === ZOHO_TOTAL) && linked.some((m) => m.zoho_location_id !== ZOHO_TOTAL)) {
    return { changes: [], unmatched, inSync: 0, blocked: "locations_mixed" };
  }
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

  // Dos ítems de Zoho con el mismo SKU: gana el primero (como "la primera variante por SKU gana"),
  // si no, el mismo (variante, location) iría dos veces en el PATCH y saldría "actualizado" en cada corrida.
  const seenVariants = new Set<number>();
  for (const { item, variant } of pairs) {
    if (seenVariants.has(variant.variant_id)) continue;
    seenVariants.add(variant.variant_id);
    const total = zohoTotal(item);
    if (linked.length === 0) {
      // Camino legado (una sola location o sin scope): stock total, Tiendanube usa su primera location.
      // Sin stock en Zoho (servicio, no inventariable) no se toca: nunca se escribe 0 por falta de dato.
      if (total === null) continue;
      const tnQty = variant.inventory_levels.reduce((sum, l) => sum + l.stock, 0);
      add(item, variant, null, null, total, tnQty);
      continue;
    }
    for (const m of linked) {
      if (m.zoho_location_id === ZOHO_TOTAL) {
        // Org sin multi-almacén: esta location de Tiendanube lleva el total de Zoho (sin location de Zoho).
        if (total === null) continue;
        const tl = variant.inventory_levels.find((l) => l.location_id === m.tn_location_id);
        add(item, variant, m.tn_location_id, null, total, tl?.stock ?? 0);
        continue;
      }
      // Sin datos por location en Zoho no se sabe cuánto hay en cada almacén: no se toca.
      const zls = zohoLocationStock(item.locations);
      if (!zls) continue;
      // Una location ausente de la lista del ítem no tiene stock en Zoho.
      const zl = zls.find((l) => l.location_id === m.zoho_location_id);
      const tl = variant.inventory_levels.find((l) => l.location_id === m.tn_location_id);
      add(item, variant, m.tn_location_id, m.zoho_location_id, zl?.stock ?? 0, tl?.stock ?? 0);
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

/**
 * Stock inicial de una variante (alta o actualización desde Zoho) como `inventory_levels`.
 * Mismas reglas que planStockChanges: sin vínculos y 2+ locations no se envía nada; total y
 * vínculos reales a la vez tampoco. Si `levels` viene vacío, `warning` dice por qué.
 */
export function resolveInitialLevels(input: {
  total: number | null; // null = Zoho no trae stock (servicio, no inventariable)
  zohoLocations?: Array<{ location_id: string; stock: number }>;
  mappings: LocationMapping[];
  tnLocationCount: number | null;
}): { levels: Array<{ location_id?: string; stock: number }>; warning?: string } {
  const qty = (n: unknown) => Math.max(0, Math.floor(Number(n) || 0));
  const linked = input.mappings.filter((m) => m.zoho_location_id);
  const hasTotal = linked.some((m) => m.zoho_location_id === ZOHO_TOTAL);
  if (hasTotal && linked.some((m) => m.zoho_location_id !== ZOHO_TOTAL)) {
    return { levels: [], warning: "locations mezcladas" };
  }
  if (linked.length === 0) {
    if ((input.tnLocationCount ?? 0) >= 2) return { levels: [], warning: "locations sin mapear" };
    if (input.total === null) return { levels: [], warning: "stock no disponible" };
    return { levels: [{ stock: qty(input.total) }] };
  }
  if (hasTotal && input.total === null) return { levels: [], warning: "stock no disponible" };
  // Sin lista por almacén recibida (o vacía) no se sabe cuánto hay: nunca se asume 0 sobre una tienda en vivo.
  if (!hasTotal && !input.zohoLocations?.length) return { levels: [], warning: "stock por almacén no disponible" };
  return {
    levels: linked.map((m) => ({
      location_id: m.tn_location_id,
      stock: hasTotal
        ? qty(input.total)
        : qty(input.zohoLocations?.find((l) => String(l.location_id) === m.zoho_location_id)?.stock),
    })),
  };
}

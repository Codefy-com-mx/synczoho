// Mapeo de locations Tiendanube (MultiCD) ↔ locations de Zoho Inventory.
import { getPool, type DatabaseClient } from "../../db.js";
import { tnFetchWithRetry, type TiendanubeStore } from "./tiendanube.js";
import { zohoFetch, type ZohoConnection } from "./zoho.js";

export interface TnLocation { id: string; name: string }
export interface ZohoLocation { id: string; name: string }
export interface LocationMapping {
  tn_location_id: string;
  tn_location_name: string;
  zoho_location_id: string | null;
  zoho_location_name: string | null;
}
// zoho_locations alimenta el selector de la UI (no está en la interfaz mínima, es aditivo).
export interface LocationsResult {
  mappings: LocationMapping[]; tn_available: boolean; zoho_available: boolean; zoho_locations: ZohoLocation[];
}

/** `zoho_location_id` centinela: esa location de Tiendanube recibe el stock total del ítem de Zoho. */
export const ZOHO_TOTAL = "__total__";
export const ZOHO_TOTAL_NAME = "Stock total de Zoho";

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

/** `null` si no hay scope read_locations o la API falla: el llamador no debe tocar nada. */
export async function fetchTnLocations(store: TiendanubeStore): Promise<TnLocation[] | null> {
  try {
    const resp = await tnFetchWithRetry(store, "/locations");
    if (!resp.ok) return null;
    const list = await resp.json();
    if (!Array.isArray(list)) return null;
    return list.map((l: any) => ({
      id: String(l.id),
      name: (l.name?.es ?? l.name?.pt ?? l.name?.en ?? (typeof l.name === "string" ? l.name : "")) || "Location",
    }));
  } catch {
    return null;
  }
}

/**
 * `null` si Zoho falla de forma transitoria (429/5xx): no se sabe qué locations hay.
 * `[]` si responde otro error 4xx (org sin multi-location o sin acceso) o no devuelve locations.
 * Los errores de red/token se propagan.
 */
export async function fetchZohoLocations(admin: DatabaseClient, conn: ZohoConnection): Promise<ZohoLocation[] | null> {
  const resp = await zohoFetch(admin, conn, "/inventory/v1/locations");
  if (resp.status === 429 || resp.status >= 500) return null;
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.locations ?? []).map((l: any) => ({ id: String(l.location_id), name: String(l.location_name ?? "") }));
}

export function autoMatchLocations(
  tn: TnLocation[], zoho: ZohoLocation[], existing: LocationMapping[],
): LocationMapping[] {
  const zohoById = new Map(zoho.map((z) => [z.id, z]));
  const prior = new Map(existing.map((m) => [m.tn_location_id, m.zoho_location_id]));
  const used = new Set<string>();
  const linked = new Map<string, ZohoLocation>();
  const link = (t: TnLocation, z: ZohoLocation | undefined) => {
    if (!z || used.has(z.id)) return;
    used.add(z.id);
    linked.set(t.id, z);
  };
  // El vínculo al total no está en la lista de Zoho: se conserva siempre (el comerciante lo cambia en la UI).
  for (const t of tn) {
    if (prior.get(t.id) === ZOHO_TOTAL) link(t, { id: ZOHO_TOTAL, name: ZOHO_TOTAL_NAME });
  }
  for (const t of tn) if (!linked.has(t.id)) link(t, zohoById.get(prior.get(t.id) ?? ""));
  // Con el total vigente no se crean vínculos reales solos: mezclarlos publicaría las mismas unidades dos veces.
  if (!existing.some((m) => m.zoho_location_id === ZOHO_TOTAL)) {
    for (const t of tn) {
      if (!linked.has(t.id)) link(t, zoho.find((z) => !used.has(z.id) && norm(z.name) === norm(t.name)));
    }
    if (tn.length === 1 && zoho.length === 1 && !linked.has(tn[0].id)) link(tn[0], zoho[0]);
  }
  return tn.map((t) => ({
    tn_location_id: t.id,
    tn_location_name: t.name,
    zoho_location_id: linked.get(t.id)?.id ?? null,
    zoho_location_name: linked.get(t.id)?.name ?? null,
  }));
}

export async function loadLocationMappings(storeId: string): Promise<LocationMapping[]> {
  const { rows } = await getPool().query<LocationMapping>(
    `SELECT tn_location_id, tn_location_name, zoho_location_id, zoho_location_name
     FROM location_mappings WHERE store_id = $1 ORDER BY tn_location_name, tn_location_id`,
    [storeId],
  );
  return rows;
}

async function persist(storeId: string, rows: LocationMapping[]): Promise<void> {
  const pool = getPool();
  if (rows.length > 0) {
    await pool.query(
      `INSERT INTO location_mappings (store_id, tn_location_id, tn_location_name, zoho_location_id, zoho_location_name)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
       ON CONFLICT (store_id, tn_location_id) DO UPDATE SET
         tn_location_name = EXCLUDED.tn_location_name,
         zoho_location_id = EXCLUDED.zoho_location_id,
         zoho_location_name = EXCLUDED.zoho_location_name`,
      [
        storeId,
        rows.map((r) => r.tn_location_id), rows.map((r) => r.tn_location_name),
        rows.map((r) => r.zoho_location_id), rows.map((r) => r.zoho_location_name),
      ],
    );
  }
  await pool.query(
    "DELETE FROM location_mappings WHERE store_id = $1 AND NOT (tn_location_id = ANY($2::text[]))",
    [storeId, rows.map((r) => r.tn_location_id)],
  );
}

export async function refreshLocationMappings(
  admin: DatabaseClient, store: TiendanubeStore, conn: ZohoConnection | null,
): Promise<LocationsResult> {
  const tn = await fetchTnLocations(store);
  const existing = await loadLocationMappings(store.store_id);
  // Sin conexión o con Zoho caído (null) no se sabe qué locations existen: los vínculos guardados no se tocan.
  const zoho = conn ? await fetchZohoLocations(admin, conn) : null;
  const zoho_available = !!zoho && zoho.length > 0;
  if (!tn) return { mappings: existing, tn_available: false, zoho_available, zoho_locations: zoho ?? [] };
  // Con conexión activa y lista (incluso vacía) los ids desaparecidos pasan a null.
  const mappings = zoho
    ? autoMatchLocations(tn, zoho, existing)
    : tn.map((t) => {
        const prev = existing.find((m) => m.tn_location_id === t.id);
        return {
          tn_location_id: t.id, tn_location_name: t.name,
          zoho_location_id: prev?.zoho_location_id ?? null, zoho_location_name: prev?.zoho_location_name ?? null,
        };
      });
  await persist(store.store_id, mappings);
  return { mappings, tn_available: true, zoho_available, zoho_locations: zoho ?? [] };
}

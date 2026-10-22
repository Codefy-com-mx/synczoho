import { serve } from "../../runtime.js";
// Mapeo de locations Tiendanube ↔ Zoho.
// POST { storeId, action?: "get" | "refresh" | "save", mappings?: [{ tn_location_id, zoho_location_id }] }
// → { mappings, tn_available, zoho_available, zoho_locations }
import { getPool } from "../../db.js";
import { corsHeaders, getAdminClient, getZohoConnection } from "../_shared/zoho.js";
import { getStore } from "../_shared/tiendanube.js";
import {
  ZOHO_TOTAL, ZOHO_TOTAL_NAME, fetchZohoLocations, loadLocationMappings, refreshLocationMappings,
} from "../_shared/locations.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { storeId, action = "get", mappings } = await req.json();
    if (!storeId) return json({ error: "storeId requerido" }, 400);
    if (!["get", "refresh", "save"].includes(action)) return json({ error: "action inválida" }, 400);
    const id = String(storeId);
    const admin = getAdminClient();
    const conn = await getZohoConnection(admin, id).catch(() => null);

    if (action === "save") {
      if (!Array.isArray(mappings)) return json({ error: "mappings requerido" }, 400);
      const zoho = conn ? await fetchZohoLocations(admin, conn) : [];
      const stored = await loadLocationMappings(id);
      const final = new Map(stored.map((m) => [m.tn_location_id, m.zoho_location_id]));
      for (const m of mappings) {
        if (!final.has(String(m?.tn_location_id))) return json({ error: "Location de Tiendanube desconocida" }, 400);
        if (m.zoho_location_id === ZOHO_TOTAL) {
          // Con Zoho caído (null) o sin locations ([]) se acepta; con locations hay que vincular las reales.
          if (zoho?.length) return json({ error: "Zoho tiene ubicaciones: vincula cada una en lugar del stock total" }, 400);
        } else if (m.zoho_location_id !== null) {
          if (!zoho) return json({ error: "Zoho no está disponible, inténtalo de nuevo" }, 503);
          if (!zoho.some((z) => z.id === m.zoho_location_id)) return json({ error: "Location de Zoho inexistente" }, 400);
        }
        final.set(m.tn_location_id, m.zoho_location_id);
      }
      const ids = [...final.values()].filter((v) => v !== null);
      const totals = ids.filter((v) => v === ZOHO_TOTAL).length;
      if (totals > 1) return json({ error: "Solo una ubicación de Tiendanube puede recibir el stock total" }, 400);
      if (totals === 1 && ids.length > 1) {
        return json({ error: "El stock total no se puede combinar con ubicaciones de Zoho" }, 400);
      }
      // Una location de Zoho por location de Tiendanube, evaluado sobre el estado final del lote.
      if (new Set(ids).size !== ids.length) {
        return json({ error: "Una location de Zoho solo puede vincularse a una location de Tiendanube" }, 400);
      }
      for (const m of mappings) {
        const z = m.zoho_location_id === ZOHO_TOTAL
          ? { id: ZOHO_TOTAL, name: ZOHO_TOTAL_NAME }
          : zoho?.find((l) => l.id === m.zoho_location_id);
        await getPool().query(
          "UPDATE location_mappings SET zoho_location_id=$3, zoho_location_name=$4 WHERE store_id=$1 AND tn_location_id=$2",
          [id, m.tn_location_id, z?.id ?? null, z?.name ?? null],
        );
      }
      return json({ mappings: await loadLocationMappings(id), tn_available: true, zoho_available: !!zoho && zoho.length > 0, zoho_locations: zoho ?? [] });
    }

    // "get" usa las locations de Tiendanube guardadas (sin GET /locations por visita); "refresh" las vuelve a pedir.
    return json(await refreshLocationMappings(admin, await getStore(admin, id), conn, action === "get"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    console.error("location-mappings error", msg);
    return json({ error: msg }, 500);
  }
});

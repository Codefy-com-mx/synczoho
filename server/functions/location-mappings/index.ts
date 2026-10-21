import { serve } from "../../runtime.js";
// Mapeo de locations Tiendanube ↔ Zoho.
// POST { storeId, action?: "get" | "refresh" | "save", mappings?: [{ tn_location_id, zoho_location_id }] }
// → { mappings, tn_available, zoho_available, zoho_locations }
import { getPool } from "../../db.js";
import { corsHeaders, getAdminClient, getZohoConnection } from "../_shared/zoho.js";
import { getStore } from "../_shared/tiendanube.js";
import {
  fetchZohoLocations, loadLocationMappings, refreshLocationMappings,
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
      const known = new Set((await loadLocationMappings(id)).map((m) => m.tn_location_id));
      for (const m of mappings) {
        if (!known.has(String(m?.tn_location_id))) return json({ error: "Location de Tiendanube desconocida" }, 400);
        if (m.zoho_location_id !== null && !zoho.some((z) => z.id === m.zoho_location_id)) {
          return json({ error: "Location de Zoho inexistente" }, 400);
        }
      }
      for (const m of mappings) {
        const z = zoho.find((l) => l.id === m.zoho_location_id);
        await getPool().query(
          "UPDATE location_mappings SET zoho_location_id=$3, zoho_location_name=$4 WHERE store_id=$1 AND tn_location_id=$2",
          [id, m.tn_location_id, z?.id ?? null, z?.name ?? null],
        );
      }
      return json({ mappings: await loadLocationMappings(id), tn_available: true, zoho_available: zoho.length > 0, zoho_locations: zoho });
    }

    // ponytail: "get" también consulta ambas APIs; si pesa, devolver solo las filas guardadas.
    return json(await refreshLocationMappings(admin, await getStore(admin, id), conn));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    console.error("location-mappings error", msg);
    return json({ error: msg }, 500);
  }
});

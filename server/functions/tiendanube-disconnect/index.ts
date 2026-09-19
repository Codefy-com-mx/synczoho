import { serve } from "../../runtime.js";
// Desconecta una tienda manualmente desde el panel de synczoho.
// Elimina todos los datos asociados a la tienda de forma idempotente:
// si la tienda ya no existe (ej: fue desinstalada desde TN admin), devuelve success igual.
import { corsHeaders, getAdminClient } from "../_shared/zoho.js";

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { store_id } = await req.json().catch(() => ({}));
    if (!store_id) {
      return new Response(JSON.stringify({ error: "store_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = getAdminClient();

    // Eliminar todos los datos de la tienda (operación idempotente).
    // Si la tienda ya fue eliminada (ej: via app/uninstalled webhook) estas
    // operaciones simplemente afectan 0 filas — sin errores.
    await Promise.allSettled([
      admin.from("zoho_connections").delete().eq("store_id", store_id),
      admin.from("sync_settings").delete().eq("store_id", store_id),
      admin.from("sync_logs").delete().eq("store_id", store_id),
    ]);

    // Eliminar la tienda al final (foreign keys dependen de store_id)
    await admin.from("stores").delete().eq("store_id", store_id);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[tiendanube-disconnect] error:", e instanceof Error ? e.message : e);
    // Devolvemos 200 igualmente: si ocurre un error parcial, el estado local
    // del cliente igual debe limpiarse para evitar mostrar una sesión rota.
    return new Response(
      JSON.stringify({ ok: true, warning: e instanceof Error ? e.message : "partial error" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

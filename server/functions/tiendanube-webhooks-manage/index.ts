import { serve } from "../../runtime.js";
// Gestiona webhooks en Tiendanube: list / register / delete.
// POST { storeId, action: "list" | "register" | "delete", id?: number }
import { corsHeaders, getAdminClient, logSync } from "../_shared/zoho.js";
import { getStore, tnFetch } from "../_shared/tiendanube.js";
import { REQUIRED_EVENTS, listOurWebhooks, syncStoreWebhooks, webhookUrl } from "../_shared/webhooks.js";

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { storeId, action = "list" } = await req.json();
    if (!storeId) {
      return json({ error: "storeId requerido" }, 400);
    }
    const admin = getAdminClient();
    const store = await getStore(admin, storeId);
    const appUrl = process.env.APP_URL?.replace(/\/$/, "");
    if (!appUrl) return json({ error: "APP_URL no configurada" }, 500);

    if (action === "list") {
      const ours = await listOurWebhooks(store, appUrl);
      const registered = new Set(ours.map((w) => w.event));
      const missing = REQUIRED_EVENTS.filter((e) => !registered.has(e));
      return json({
        webhook_url: webhookUrl(appUrl),
        registered: ours,
        missing,
        all_active: missing.length === 0,
      });
    }

    if (action === "register") {
      const { created, deleted, errors } = await syncStoreWebhooks(store, appUrl);
      await logSync(admin, storeId, {
        operation: "webhooks_register",
        status: errors.length === 0 ? "success" : "error",
        message: `Registrados ${created.length}/${REQUIRED_EVENTS.length}`,
        payload: { created, deleted, errors },
      });
      return json({ created, errors, ok: errors.length === 0 });
    }

    if (action === "delete_all") {
      const ours = await listOurWebhooks(store, appUrl);
      let deleted = 0;
      for (const w of ours) {
        const r = await tnFetch(store, `/webhooks/${w.id}`, { method: "DELETE" });
        if (r.ok) deleted++;
        await r.text();
      }
      return json({ deleted });
    }

    return json({ error: "action inválida" }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    console.error("webhooks-manage error", msg);
    return json({ error: msg }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

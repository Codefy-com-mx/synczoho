import { serve } from "../../runtime.js";
// Gestiona webhooks en Tiendanube: list / register / delete.
// POST { storeId, action: "list" | "register" | "delete", id?: number }
import { corsHeaders, getAdminClient, logSync } from "../_shared/zoho.js";
import { getStore, tnFetch, tnFetchJson } from "../_shared/tiendanube.js";

// Eventos requeridos para sincronización de órdenes, clientes y ciclo de vida de la app
const REQUIRED_EVENTS = [
  "order/created",
  "order/updated",
  "order/paid",
  "order/cancelled",
  "customer/created",
  "customer/updated",
  "app/uninstalled",
  "app/suspended",
  "app/resumed",
];

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
    const webhookUrl = `${appUrl}/api/functions/v1/tiendanube-webhook`;

    if (action === "list") {
      const list = await tnFetchJson<any[]>(store, `/webhooks?per_page=200`);
      const ours = (list || []).filter((w) => w.url === webhookUrl);
      const registered = new Set(ours.map((w) => w.event));
      const missing = REQUIRED_EVENTS.filter((e) => !registered.has(e));
      return json({
        webhook_url: webhookUrl,
        registered: ours,
        missing,
        all_active: missing.length === 0,
      });
    }

    if (action === "register") {
      const list = await tnFetchJson<any[]>(store, `/webhooks?per_page=200`);
      const ours = (list || []).filter((w) => w.url === webhookUrl);
      const existing = new Set(ours.map((w) => w.event));

      const created: any[] = [];
      const errors: any[] = [];
      for (const event of REQUIRED_EVENTS) {
        if (existing.has(event)) continue;
        try {
          const r = await tnFetch(store, `/webhooks`, {
            method: "POST",
            body: JSON.stringify({ event, url: webhookUrl }),
          });
          const t = await r.text();
          if (!r.ok) {
            errors.push({ event, error: t.slice(0, 200) });
          } else {
            created.push(JSON.parse(t));
          }
        } catch (e) {
          errors.push({ event, error: e instanceof Error ? e.message : "err" });
        }
      }
      await logSync(admin, storeId, {
        operation: "webhooks_register",
        status: errors.length === 0 ? "success" : "error",
        message: `Registrados ${created.length}/${REQUIRED_EVENTS.length}`,
        payload: { created, errors },
      });
      return json({ created, errors, ok: errors.length === 0 });
    }

    if (action === "delete_all") {
      const list = await tnFetchJson<any[]>(store, `/webhooks?per_page=200`);
      const ours = (list || []).filter((w) => w.url === webhookUrl);
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

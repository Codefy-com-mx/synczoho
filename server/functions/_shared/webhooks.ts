// Registro de webhooks de Tiendanube compartido por la instalación y la
// sección Pedidos. Solo se piden los eventos que procesa el worker.
import { tnFetch, tnFetchJson, type TiendanubeStore } from "./tiendanube.js";

export const REQUIRED_EVENTS = [
  "order/created",
  "order/updated",
  "order/paid",
  "order/cancelled",
  "app/uninstalled",
  "app/suspended",
  "app/resumed",
  "product/created",
  "product/updated",
  "product/deleted",
  "category/created",
  "category/updated",
  "category/deleted",
  "location/created",
  "location/updated",
  "location/deleted",
];

export interface TiendanubeWebhook {
  id: number;
  event: string;
  url: string;
}

export function webhookUrl(appUrl: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/functions/v1/tiendanube-webhook`;
}

export async function listOurWebhooks(store: TiendanubeStore, appUrl: string): Promise<TiendanubeWebhook[]> {
  const list = await tnFetchJson<TiendanubeWebhook[]>(store, "/webhooks?per_page=200");
  return (list || []).filter((w) => w.url === webhookUrl(appUrl));
}

/**
 * Deja registrados exactamente los eventos requeridos: crea los que faltan y
 * borra los de esta app que ya no se usan. Sin cambios pendientes no escribe.
 */
export async function syncStoreWebhooks(store: TiendanubeStore, appUrl: string) {
  const url = webhookUrl(appUrl);
  const ours = await listOurWebhooks(store, appUrl);
  const existing = new Set(ours.map((w) => w.event));

  const created: unknown[] = [];
  const errors: Array<{ event: string; error: string }> = [];
  for (const event of REQUIRED_EVENTS) {
    if (existing.has(event)) continue;
    try {
      const r = await tnFetch(store, "/webhooks", {
        method: "POST",
        body: JSON.stringify({ event, url }),
      });
      const t = await r.text();
      if (r.ok) created.push(JSON.parse(t));
      else errors.push({ event, error: t.slice(0, 200) });
    } catch (e) {
      errors.push({ event, error: e instanceof Error ? e.message : "err" });
    }
  }

  let deleted = 0;
  for (const w of ours.filter((w) => !REQUIRED_EVENTS.includes(w.event))) {
    const r = await tnFetch(store, `/webhooks/${w.id}`, { method: "DELETE" });
    await r.text();
    if (r.ok) deleted++;
  }

  return { created, deleted, errors };
}

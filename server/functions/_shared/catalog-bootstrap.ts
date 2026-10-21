// Arranque: re-registra webhooks y encola el backfill de las tiendas con catálogo pendiente.
import { getPool } from "../../db.js";
import { getAdminClient, logSync } from "./zoho.js";
import { enqueueBackfill } from "./tn-catalog.js";
import { syncStoreWebhooks } from "./webhooks.js";

export async function resyncAllStores(appUrl: string): Promise<{ stores: number; failed: number }> {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT store_id, access_token, store_name, catalog_status FROM stores WHERE suspended = false",
  );
  let failed = 0;
  for (const store of rows) {
    try {
      const { errors } = await syncStoreWebhooks(store, appUrl);
      if (errors.length) throw new Error(`Webhooks con error: ${errors.map((e: any) => e.event).join(", ")}`);
    } catch (error) {
      failed++;
      await logSync(getAdminClient(), store.store_id, {
        operation: "webhooks_register",
        status: "error",
        message: error instanceof Error ? error.message : "Error al registrar webhooks",
      });
    }
    if (store.catalog_status === "pending") {
      await enqueueBackfill(store.store_id).catch(console.error);
    }
  }
  return { stores: rows.length, failed };
}

import { getPool } from "./db.js";
import createSalesorder from "./functions/zoho-create-salesorder/index.js";
import sendAlertEmail from "./functions/send-alert-email/index.js";
import { TN_API, TN_USER_AGENT, findStore, type TiendanubeStore } from "./functions/_shared/tiendanube.js";
import { applyPricesToZoho, diffPrices } from "./functions/_shared/price-from-tn.js";
import {
  backfillCatalog, deleteProduct, deletePendingCatalogEvents, loadProductCatalog, refreshCategory, refreshProduct,
} from "./functions/_shared/tn-catalog.js";
import { refreshLocationMappings } from "./functions/_shared/locations.js";
import { logRetryObserver } from "./functions/_shared/tn-observer.js";
import { getAdminClient, getZohoConnection, logSync } from "./functions/_shared/zoho.js";

interface EventRow {
  id: string;
  store_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export const storeTables = [
  "products", "zoho_connections", "product_sync_map", "sync_logs", "sync_settings",
  "order_sync_map", "customer_sync_map", "stock_sync_state", "category_mappings",
  "tn_variants", "tn_categories", "location_mappings", "stores",
];

async function sendPrivacyEmail(to: string, subject: string, message: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!key || !from) throw new Error("Privacy email delivery is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text: message }),
  });
  if (!response.ok) throw new Error(`Privacy email delivery failed (${response.status})`);
}

async function recordPrivacyRequest(row: EventRow, status: "pending_manual" | "completed", customerId?: number): Promise<void> {
  await getPool().query(`
    INSERT INTO privacy_requests (event_id, store_id, request_type, customer_id, status, completed_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (event_id) DO UPDATE SET status=EXCLUDED.status, completed_at=EXCLUDED.completed_at
  `, [row.id, row.store_id, row.event_type, customerId || null, status, status === "completed" ? new Date() : null]);
}

// Con dirección tn_to_zoho, un precio que cambió en Tiendanube se copia al ítem de Zoho.
// Comparar contra la caché local evita el eco: un webhook sin cambio de precio no produce diff.
async function refreshAndPushPrices(store: TiendanubeStore, productId: number): Promise<void> {
  const { rows } = await getPool().query(
    "SELECT prices_enabled, prices_direction FROM sync_settings WHERE store_id=$1", [store.store_id],
  );
  if (!rows[0]?.prices_enabled || rows[0].prices_direction !== "tn_to_zoho") {
    await refreshProduct(store, productId);
    return;
  }
  // La conexión se resuelve ANTES de refrescar: si Zoho no está disponible el evento falla con la caché
  // intacta y el reintento ve el diff original.
  // ponytail: un crash entre refreshProduct y applyPricesToZoho pierde el push; haría falta un push pendiente durable.
  const admin = getAdminClient();
  const conn = await getZohoConnection(admin, store.store_id);
  const before = await loadProductCatalog(store.store_id, productId);
  await refreshProduct(store, productId);
  const changes = diffPrices(before, await loadProductCatalog(store.store_id, productId));
  // Los fallos por SKU se registran dentro y no hacen fallar el evento.
  if (changes.length > 0) await applyPricesToZoho(admin, conn, store.store_id, changes);
}

// Eventos de catálogo: sin tienda no pueden completarse y se pueden abandonar.
// Pedidos, privacidad y app/* nunca entran aquí: deben reintentarse siempre.
const isCatalogFamily = (event: string) => event.startsWith("product/") || event.startsWith("category/")
  || event.startsWith("location/") || event === "internal/backfill";

export async function processEvent(row: EventRow): Promise<void> {
  const pool = getPool();
  const { store_id: storeId, event_type: event, payload } = row;
  if (isCatalogFamily(event)) {
    const admin = getAdminClient();
    const store = await findStore(admin, storeId);
    // Tienda desconectada/desinstalada: el evento queda procesado en vez de reintentarse para siempre.
    if (!store) return;
    if (event.startsWith("location/")) {
      // created/updated/deleted: se recalcula la lista completa. Sin Zoho activo se refresca solo el lado de Tiendanube.
      const conn = await getZohoConnection(admin, storeId).catch(() => null);
      await refreshLocationMappings(admin, store, conn);
    } else if (event === "internal/backfill") {
      await backfillCatalog(store, logRetryObserver(getAdminClient(), storeId));
    } else if (event === "product/deleted") {
      await deleteProduct(storeId, Number(payload.id));
    } else if (event === "category/deleted") {
      await pool.query("DELETE FROM tn_categories WHERE store_id=$1 AND id=$2", [storeId, Number(payload.id)]);
    } else if (event.startsWith("category/")) {
      await refreshCategory(store, Number(payload.id));
    } else if (event === "product/updated") {
      await refreshAndPushPrices(store, Number(payload.id));
    } else {
      await refreshProduct(store, Number(payload.id));
    }
    return;
  }
  if (event.startsWith("order/")) {
    const result = await createSalesorder(new Request("http://internal/functions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeId, orderId: payload.id, event }),
    }));
    if (!result.ok || (await result.clone().json()).error) throw new Error(`Order sync returned ${result.status}`);
    return;
  }
  if (event === "app/suspended" || event === "app/resumed") {
    await pool.query(
      "UPDATE stores SET suspended=$1, suspended_at=$2 WHERE store_id=$3",
      [event === "app/suspended", event === "app/suspended" ? new Date() : null, storeId],
    );
    return;
  }
  if (event === "app/uninstalled") {
    await pool.query("DELETE FROM zoho_connections WHERE store_id=$1", [storeId]);
    await pool.query("DELETE FROM zoho_oauth_states WHERE store_id=$1", [storeId]);
    for (const table of ["tn_variants", "tn_categories", "location_mappings"]) {
      await pool.query(`DELETE FROM ${table} WHERE store_id=$1`, [storeId]);
    }
    await deletePendingCatalogEvents(storeId);
    await pool.query("DELETE FROM stores WHERE store_id=$1", [storeId]);
    return;
  }
  if (event === "store/redact") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const table of storeTables) await client.query(`DELETE FROM ${table} WHERE store_id=$1`, [storeId]);
      await client.query("DELETE FROM zoho_oauth_states WHERE store_id=$1", [storeId]);
      await client.query("DELETE FROM webhook_events WHERE store_id=$1", [storeId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return;
  }
  if (event === "customers/redact") {
    const customer = payload.customer as Record<string, unknown>;
    const customerId = Number(customer.id);
    const ids = Array.isArray(payload.orders_to_redact)
      ? payload.orders_to_redact.filter((id) => Number.isSafeInteger(Number(id))).map(Number)
      : [];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM customer_sync_map WHERE store_id=$1 AND (tiendanube_customer_id=$2 OR email=$3)",
        [storeId, customer.id, customer.email || null],
      );
      await client.query(
        "DELETE FROM order_sync_map WHERE store_id=$1 AND tiendanube_order_id=ANY($2::bigint[])",
        [storeId, ids],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const contact = process.env.PRIVACY_CONTACT_EMAIL;
    if (!contact) throw new Error("PRIVACY_CONTACT_EMAIL not configured");
    await sendPrivacyEmail(contact, "ZohoSync: revisar borrado de cliente en Zoho", `
Tienda: ${storeId}
Cliente Tiendanube: ${customerId}
Se borraron los mapeos locales del cliente y de las órdenes solicitadas. Revisar datos del cliente en Zoho Inventory y las obligaciones legales de conservación.
Evento interno: ${row.id}
`.trim());
    await recordPrivacyRequest(row, "pending_manual", customerId);
    return;
  }
  if (event === "customers/data_request") {
    const customer = payload.customer as Record<string, unknown>;
    const customerId = Number(customer.id);
    const store = await pool.query<{ access_token: string }>(
      "SELECT access_token FROM stores WHERE store_id=$1", [storeId],
    );
    const maps = await pool.query(
      "SELECT tiendanube_customer_id,email,zoho_contact_id,status,metadata FROM customer_sync_map WHERE store_id=$1 AND (tiendanube_customer_id=$2 OR email=$3)",
      [storeId, customerId, customer.email || null],
    );
    const orderIds = Array.isArray(payload.orders_requested)
      ? payload.orders_requested.filter((id) => Number.isSafeInteger(Number(id))).map(Number)
      : [];
    const orders = await pool.query(
      "SELECT tiendanube_order_id,zoho_salesorder_id,zoho_invoice_id,status FROM order_sync_map WHERE store_id=$1 AND tiendanube_order_id=ANY($2::bigint[])",
      [storeId, orderIds],
    );
    const report = JSON.stringify({
      request_id: (payload.data_request as Record<string, unknown>)?.id || null,
      store_id: storeId, customer_id: customerId,
      local_customer_mappings: maps.rows, local_order_mappings: orders.rows,
      note: "Zoho Inventory puede conservar datos adicionales que debe revisar el comerciante. ZohoSync no guarda datos de checkouts ni borradores.",
    }, null, 2);
    let merchantEmail: string | null = null;
    if (store.rows[0]?.access_token) {
      try {
        const response = await fetch(`${TN_API}/${storeId}/store`, {
          headers: {
            Authentication: `bearer ${store.rows[0].access_token}`,
            "User-Agent": TN_USER_AGENT,
          },
        });
        if (response.ok) {
          const current = await response.json();
          if (typeof current.email === "string" && current.email.includes("@")) merchantEmail = current.email;
        }
      } catch {
        // Missing or unavailable owner email requires manual privacy handling.
      }
    }
    if (merchantEmail) {
      await sendPrivacyEmail(merchantEmail, "Solicitud de datos personales - ZohoSync", report);
      await recordPrivacyRequest(row, "completed", customerId);
    } else {
      const contact = process.env.PRIVACY_CONTACT_EMAIL;
      if (!contact) throw new Error("PRIVACY_CONTACT_EMAIL not configured");
      await sendPrivacyEmail(contact, "ZohoSync: solicitud de datos pendiente de entrega al comerciante", report);
      await recordPrivacyRequest(row, "pending_manual", customerId);
    }
    return;
  }
}

const MAX_CATALOG_ATTEMPTS = 5;

// Tras agotar reintentos, el catálogo local puede estar desfasado: lo marcamos y avisamos.
export async function onEventFailure(row: EventRow, message: string): Promise<void> {
  const isCatalog = row.event_type.startsWith("product/") || row.event_type.startsWith("category/")
    || row.event_type === "internal/backfill";
  if (!isCatalog || row.attempts < MAX_CATALOG_ATTEMPTS) return;
  const errorMessage = `${row.event_type}: ${message}`;
  // El UPDATE condicional es la compuerta de dedupe: solo la primera falla tras un catálogo 'ready' alerta.
  const stale = await getPool().query(
    "UPDATE stores SET catalog_status='stale' WHERE store_id=$1 AND catalog_status <> 'stale'", [row.store_id],
  );
  if (!stale.rowCount) return;
  await logSync(getAdminClient(), row.store_id, { operation: "catalog_webhook", status: "error", message: errorMessage });
  const alert = await sendAlertEmail(new Request("http://internal/functions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeId: row.store_id, operation: "catalog_webhook", errorMessage }),
  }));
  if (!alert.ok) console.error("Catalog alert email failed", row.store_id, alert.status);
}

const MAX_CATALOG_FAMILY_ATTEMPTS = 10;

// Un evento de catálogo que falla 10 veces se abandona (processed=true conservando el motivo) para que no
// se reintente cada hora ni degrade /status para siempre. Pedidos y privacidad nunca se abandonan.
export async function abandonIfExhausted(row: EventRow, message: string): Promise<void> {
  if (!isCatalogFamily(row.event_type) || row.attempts < MAX_CATALOG_FAMILY_ATTEMPTS) return;
  await getPool().query(
    "UPDATE webhook_events SET processed=true, payload=NULL, error_message=$2 WHERE id=$1",
    [row.id, `abandonado tras ${MAX_CATALOG_FAMILY_ATTEMPTS} intentos: ${message}`.slice(0, 500)],
  );
}

let running = false;
let lastCleanup = 0;
export async function runWebhookWorker(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const pool = getPool();
    if (Date.now() - lastCleanup > 60 * 60_000) {
      await pool.query("DELETE FROM zoho_oauth_states WHERE expires_at < now()");
      lastCleanup = Date.now();
    }
    for (let i = 0; i < 20; i++) {
      const claimed = await pool.query<EventRow>(`
        WITH next AS (
          SELECT id FROM webhook_events WHERE processed=false AND next_attempt_at<=now()
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE webhook_events AS e
        SET attempts=e.attempts+1, next_attempt_at=now()+interval '5 minutes'
        FROM next WHERE e.id=next.id
        RETURNING e.id,e.store_id,e.event_type,e.payload,e.attempts
      `);
      const row = claimed.rows[0];
      if (!row) break;
      const lockClient = await pool.connect();
      // Un backfill largo usa su propia clave para no bloquear los pedidos de la tienda.
      // ponytail: el bucle es secuencial, así que un backfill de minutos igual retrasa los demás eventos del worker; mover a un worker aparte si molesta.
      const lockKey = `${row.event_type.startsWith("internal/") ? "backfill" : "webhooks"}:${row.store_id}`;
      try {
        // ponytail: serialize one store at a time; switch to per-order locks only if throughput demands it.
        const lock = await lockClient.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockKey],
        );
        if (!lock.rows[0]?.locked) throw new Error("Store is already processing");
        await processEvent(row);
        await pool.query(
          "UPDATE webhook_events SET processed=true, payload=NULL, error_message=NULL WHERE id=$1",
          [row.id],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("Webhook processing failed", row.id, row.event_type, message);
        await pool.query(
          "UPDATE webhook_events SET error_message=$2, next_attempt_at=now()+make_interval(secs => LEAST(3600, 60 * POWER(2, LEAST(attempts, 6))::integer)) WHERE id=$1",
          [row.id, message.slice(0, 500)],
        );
        await onEventFailure(row, message).catch((e) => console.error("Catalog failure handling failed", row.id, e));
        await abandonIfExhausted(row, message).catch((e) => console.error("Abandon handling failed", row.id, e));
      } finally {
        await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
        lockClient.release();
      }
    }
  } finally {
    running = false;
  }
}

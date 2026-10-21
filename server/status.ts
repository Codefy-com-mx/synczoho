import type { Pool } from "pg";
import { getPool } from "./db.js";

export type ServiceStatus = "ok" | "degraded" | "down";

export interface StatusReport {
  status: ServiceStatus;
  checked_at: string;
  database: "ok" | "down";
  queue: { pending: number; oldest_pending_seconds: number; failed: number };
  scheduler: { stock_last_success: string | null; prices_last_success: string | null };
  stale_catalogs: number;
}

// Una sola consulta de agregados: nunca devuelve ids, nombres ni tokens de tiendas.
const STATUS_SQL = `
  SELECT
    (SELECT count(*) FROM webhook_events WHERE processed = false) AS pending,
    (SELECT COALESCE(floor(EXTRACT(EPOCH FROM now() - min(created_at))), 0)
       FROM webhook_events WHERE processed = false) AS oldest_pending_seconds,
    (SELECT count(*) FROM webhook_events WHERE processed = false AND error_message IS NOT NULL) AS failed,
    (SELECT max(last_success_at) FROM scheduled_sync_state WHERE operation = 'stock_sync_run') AS stock_last_success,
    (SELECT max(last_success_at) FROM scheduled_sync_state WHERE operation = 'price_sync_run') AS prices_last_success,
    (SELECT count(*) FROM stores WHERE catalog_status = 'stale') AS stale_catalogs
`;

const iso = (value: unknown): string | null => (value ? new Date(value as string | Date).toISOString() : null);

export async function getStatus(pool: Pick<Pool, "query"> = getPool()): Promise<StatusReport> {
  const checked_at = new Date().toISOString();
  try {
    const { rows } = await pool.query(STATUS_SQL);
    const row = rows[0] ?? {};
    const queue = {
      pending: Number(row.pending ?? 0),
      oldest_pending_seconds: Number(row.oldest_pending_seconds ?? 0),
      failed: Number(row.failed ?? 0),
    };
    const stale_catalogs = Number(row.stale_catalogs ?? 0);
    const degraded = queue.oldest_pending_seconds > 600 || queue.failed > 0 || stale_catalogs > 0;
    return {
      status: degraded ? "degraded" : "ok",
      checked_at,
      database: "ok",
      queue,
      scheduler: { stock_last_success: iso(row.stock_last_success), prices_last_success: iso(row.prices_last_success) },
      stale_catalogs,
    };
  } catch {
    return {
      status: "down",
      checked_at,
      database: "down",
      queue: { pending: 0, oldest_pending_seconds: 0, failed: 0 },
      scheduler: { stock_last_success: null, prices_last_success: null },
      stale_catalogs: 0,
    };
  }
}

export const statusHttpCode = (status: ServiceStatus): number => (status === "down" ? 503 : 200);

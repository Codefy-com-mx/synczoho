import type { DatabaseClient } from "../../db.js";
import type { RetryObserver } from "./tiendanube.js";
import { logSync } from "./zoho.js";

/** Registra en sync_logs cuando tnFetchWithRetry agota los reintentos. */
export function logRetryObserver(admin: DatabaseClient, storeId: string): RetryObserver {
  return {
    async onExhausted({ status, path }) {
      await logSync(admin, storeId, {
        operation: "tn_retry_exhausted",
        status: "error",
        message: `${status === 0 ? "red" : status} agotó reintentos en ${path}`,
      });
    },
  };
}

// Helpers compartidos para llamar a la API de Tiendanube.
import type { DatabaseClient } from "../../db.js";

export const TN_API = "https://api.tiendanube.com/v1";
export const TN_USER_AGENT = "ZohoSync/1.0 (support@synczoho.com)";

export interface TiendanubeStore {
  store_id: string;
  access_token: string;
  store_name: string | null;
}

export async function getStore(
  admin: DatabaseClient,
  storeId: string,
): Promise<TiendanubeStore> {
  const { data, error } = await admin
    .from("stores")
    .select("store_id, access_token, store_name")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(`DB error: ${error.message}`);
  if (!data) throw new Error("Tienda no encontrada");
  return data as TiendanubeStore;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function tnFetch(
  store: TiendanubeStore,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${TN_API}/${store.store_id}${path.startsWith("/") ? path : "/" + path}`;
  const headers = new Headers(init.headers || {});
  headers.set("Authentication", `bearer ${store.access_token}`);
  headers.set("User-Agent", TN_USER_AGENT);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return await fetch(url, { ...init, headers });
}

/**
 * tnFetch con reintentos automáticos en 429 (Leaky Bucket: 2 req/s, bucket 40).
 * - Respeta el header Retry-After si está presente.
 * - Backoff exponencial: 1s → 2s → 4s → 8s.
 * - Si x-rate-limit-request-left < 5, agrega una pausa preventiva de 500ms.
 */
export async function tnFetchWithRetry(
  store: TiendanubeStore,
  path: string,
  init: RequestInit = {},
  maxRetries = 4,
): Promise<Response> {
  let attempt = 0;
  while (true) {
    const resp = await tnFetch(store, path, init);

    // Pausa preventiva si queda poca cuota
    const remaining = Number(resp.headers.get("x-rate-limit-request-left") ?? 999);
    if (remaining > 0 && remaining < 5) {
      await sleep(600);
    }

    if (resp.status !== 429 || attempt >= maxRetries) {
      return resp;
    }

    // 429 – backoff exponencial
    const retryAfter = Number(resp.headers.get("Retry-After") ?? 0);
    const waitMs = retryAfter > 0
      ? retryAfter * 1000
      : Math.min(1000 * Math.pow(2, attempt), 16_000);

    console.warn(`[TN] Rate limited. Reintento ${attempt + 1}/${maxRetries} en ${waitMs}ms`);
    await sleep(waitMs);
    attempt++;
  }
}

export async function tnFetchJson<T = any>(
  store: TiendanubeStore,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const resp = await tnFetchWithRetry(store, path, init);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Tiendanube API ${resp.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : ({} as T);
}

/**
 * Devuelve el location_id principal de la tienda (primer depósito activo).
 * Retorna null si no se puede obtener (ej: el endpoint no existe en el plan).
 */
export async function getTnDefaultLocationId(
  store: TiendanubeStore,
): Promise<number | null> {
  try {
    const resp = await tnFetch(store, "/locations");
    if (!resp.ok) return null;
    const locs: any[] = await resp.json();
    if (Array.isArray(locs) && locs.length > 0) {
      return locs[0].id ?? null;
    }
  } catch {
    // silencioso — algunos planes no tienen este endpoint
  }
  return null;
}

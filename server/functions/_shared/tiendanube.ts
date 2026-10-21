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

export interface RetryObserver {
  onExhausted?(info: { status: number; path: string }): void | Promise<void>;
}

/**
 * Espera antes del reintento `attempt` (desde 0), o null si el status no es reintentable.
 * status 0 = error de red. 429: 2s·2^n (tope 30s) o Retry-After; 5xx/red: 0.5s·2^n (tope 8s).
 * Suma hasta 25% de jitter.
 */
export function retryDelayMs(
  status: number,
  attempt: number,
  retryAfter: string | null,
  random: () => number = Math.random,
): number | null {
  let delay: number;
  if (status === 429) {
    const ra = Number(retryAfter);
    delay = ra > 0 ? ra * 1000 : Math.min(2000 * 2 ** attempt, 30_000);
  } else if (status === 0 || [500, 502, 503, 504].includes(status)) {
    delay = Math.min(500 * 2 ** attempt, 8_000);
  } else {
    return null;
  }
  return Math.round(delay + random() * 0.25 * delay);
}

/**
 * tnFetch con reintentos en 429, 500/502/503/504 y errores de red (ver retryDelayMs).
 * Agotados los reintentos devuelve la última respuesta (o relanza el error de red)
 * y avisa a `observer.onExhausted`.
 * Si x-rate-limit-request-left < 5, agrega una pausa preventiva de 600ms.
 */
export async function tnFetchWithRetry(
  store: TiendanubeStore,
  path: string,
  init: RequestInit = {},
  maxRetries = 4,
  observer?: RetryObserver,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let resp: Response | undefined;
    let netErr: unknown;
    try {
      resp = await tnFetch(store, path, init);
    } catch (e) {
      netErr = e;
    }
    const status = resp?.status ?? 0;

    if (resp) {
      // Pausa preventiva si queda poca cuota
      const remaining = Number(resp.headers.get("x-rate-limit-request-left") ?? 999);
      if (remaining > 0 && remaining < 5) await sleep(600);
    }

    const waitMs = retryDelayMs(status, attempt, resp?.headers.get("Retry-After") ?? null);
    if (waitMs === null) {
      if (resp) return resp;
      throw netErr;
    }
    if (attempt >= maxRetries) {
      await observer?.onExhausted?.({ status, path });
      if (resp) return resp;
      throw netErr;
    }

    console.warn(`[TN] ${status || "red"} en ${path}. Reintento ${attempt + 1}/${maxRetries} en ${waitMs}ms`);
    await sleep(waitMs);
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

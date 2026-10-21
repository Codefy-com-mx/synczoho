#!/usr/bin/env node
// Prueba de carga del receptor de webhooks de Tiendanube (perfil Hot Sale).
//
//   TIENDANUBE_CLIENT_SECRET=... node scripts/loadtest/webhook-burst.mjs \
//     --url https://staging/api/functions/v1/tiendanube-webhook --rps 50 --duration 600 --store-id 123456 --no-drain
//
// Opciones: --url (obligatoria), --rps (50), --duration (600 s), --store-id (1), --order-ids 101,102,
// --status-url, --no-drain (única opción sin valor). Perfil de aceptación: con --no-drain. Perfil de
// drenado (p. ej. --rps 5 --duration 60): sin --no-drain; sin la bandera, 50 rps x 600 s termina en
// FALLA por diseño porque el worker no puede drenar ~28 500 eventos en 300 s.
//
// Sin dependencias: solo Node >= 18 (fetch global). Envía product/updated; solo si se pasan ids de
// pedidos reales (--order-ids 101,102) mezcla 80 % product/updated y 20 % order/paid. Rampa lineal
// durante el primer 10 % de la duración y luego consulta /api/status para medir cuánto tarda el
// worker en drenar la cola. Código de salida != 0 si no se cumplen los criterios, 2 si los
// argumentos son inválidos. --no-drain omite por completo la consulta a /api/status (perfil de aceptación). El secreto se lee del entorno (recomendado: argv es visible en ps/historial).
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

const P95_LIMIT_MS = 500;
const DRAIN_LIMIT_S = 300;
const REQUEST_TIMEOUT_MS = 10_000;

/** HMAC-SHA256 hex del cuerpo crudo: mismo formato que `verifyWebhookSignature` del receptor. */
export function signBody(body, secret) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Percentil por rango más cercano sobre una lista ya ordenada ascendente. */
export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Eventos por segundo objetivo en el instante `t` (s): rampa lineal en el primer 10 %. */
export function rateAt(t, rps, duration) {
  const ramp = duration * 0.1;
  return ramp > 0 && t < ramp ? Math.max(1, (rps * t) / ramp) : rps;
}

/** `--opcion valor` o bandera `--opcion` (true si no hay valor o el siguiente token es otra opción). */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    out[argv[i].slice(2)] = next === undefined || next.startsWith("--") ? true : (i++, next);
  }
  return out;
}

/** Mensaje de error si una opción (salvo --no-drain) quedó sin valor, o null. */
export function validateOptions(args) {
  for (const [key, value] of Object.entries(args)) {
    if (value === true && key !== "no-drain") return `falta el valor de --${key}`;
  }
  return null;
}

/** Enteros separados por coma -> number[]; vacío si no se pasó la opción. Lanza si algo no es entero positivo. */
export function parseOrderIds(raw) {
  if (raw == null || raw === "") return [];
  return String(raw).split(",").map((t) => {
    const n = Number(t.trim());
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`--order-ids: "${t.trim()}" no es un id entero positivo`);
    return n;
  });
}

/** Mensaje de error si --rps/--duration no son números finitos > 0, o null. */
export function validateRates(rps, duration) {
  if (!Number.isFinite(rps) || rps <= 0) return "--rps debe ser un número finito > 0";
  if (!Number.isFinite(duration) || duration <= 0) return "--duration debe ser un número finito > 0 (segundos)";
  return null;
}

/**
 * Un evento del perfil. `r` en [0,1) decide el tipo. order/paid solo si hay ids reales: con ids
 * inventados el evento falla, se reintenta con backoff de hasta 3600 s, sigue generando errores y
 * ruido en los logs y cuenta en `failed` al llegar a 5 intentos. `queue.pending` de /api/status
 * solo cuenta eventos listos, así que esos eventos en backoff no aparecen como pendientes.
 */
export function buildEvent(storeId, orderIds, r = Math.random(), pick = Math.random) {
  if (orderIds.length && r >= 0.8) {
    return { store_id: storeId, event: "order/paid", id: orderIds[Math.floor(pick() * orderIds.length)] };
  }
  // ponytail: ids de producto al azar; un id inexistente solo hace que el worker borre una fila de caché.
  return { store_id: storeId, event: "product/updated", id: 1 + Math.floor(pick() * 5000) };
}

async function sendOne(url, secret, storeId, orderIds, stats) {
  const body = JSON.stringify(buildEvent(storeId, orderIds));
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-linkedstore-hmac-sha256": signBody(body, secret) },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await res.arrayBuffer();
    stats.latencies.push(performance.now() - t0);
    if (res.status >= 500) stats.s5xx++;
    else if (res.status >= 400) stats.s4xx++;
    else if (res.status >= 200 && res.status < 300) stats.s2xx++;
    else stats.other++;
  } catch {
    stats.errors++;
  }
}

async function fetchStatus(statusUrl) {
  try {
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = await res.json();
    return json && json.queue && Number.isFinite(json.queue.pending) ? json.queue : null;
  } catch {
    return null;
  }
}

/** Segundos desde `startedAt` hasta pending === 0, o null si /api/status no está disponible. */
async function measureDrain(statusUrl, startedAt) {
  if (!(await fetchStatus(statusUrl))) return { measured: false };
  const deadline = startedAt + (DRAIN_LIMIT_S + 60) * 1000;
  for (;;) {
    const queue = await fetchStatus(statusUrl);
    if (queue && queue.pending === 0) return { measured: true, seconds: (Date.now() - startedAt) / 1000 };
    if (Date.now() > deadline) return { measured: true, seconds: Infinity, pending: queue?.pending };
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export async function run(opts) {
  const { url, secret, rps, duration, storeId, orderIds = [], noDrain = false } = opts;
  const stats = { latencies: [], s2xx: 0, s4xx: 0, s5xx: 0, other: 0, errors: 0 };
  const inflight = new Set();
  const start = performance.now();
  let last = start;
  let tokens = 0;
  let sent = 0;
  while (performance.now() - start < duration * 1000) {
    await new Promise((r) => setTimeout(r, 10));
    const now = performance.now();
    tokens += (rateAt((now - start) / 1000, rps, duration) * (now - last)) / 1000;
    last = now;
    for (; tokens >= 1; tokens--) {
      const p = sendOne(url, secret, storeId, orderIds, stats).finally(() => inflight.delete(p));
      inflight.add(p);
      sent++;
    }
  }
  await Promise.all(inflight);
  const burstEnd = Date.now();

  const statusUrl = opts.statusUrl || new URL("/api/status", url).href;
  const drain = noDrain ? { measured: false, skipped: true } : await measureDrain(statusUrl, burstEnd);

  const sorted = stats.latencies.slice().sort((a, b) => a - b);
  const p = { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99) };
  const failures = [];
  if (!(p.p95 < P95_LIMIT_MS)) failures.push(`p95 ${p.p95.toFixed(0)} ms >= ${P95_LIMIT_MS} ms`);
  if (stats.s5xx > 0) failures.push(`${stats.s5xx} respuestas 5xx`);
  if (stats.s4xx > 0 || stats.errors > 0 || stats.other > 0) {
    failures.push(`${stats.s4xx} 4xx / ${stats.errors} errores de red / ${stats.other} otras (firma o URL incorrectas?)`);
  }
  if (drain.measured && !(drain.seconds < DRAIN_LIMIT_S)) failures.push(`cola no drenó en < ${DRAIN_LIMIT_S} s`);
  return { sent, stats, percentiles: p, drain, failures };
}

/** Última línea del informe; deja claro cuando el criterio de drenado no se pudo evaluar. */
export function verdictLine(failures, drain) {
  if (failures.length) return `RESULTADO: FALLA\n - ${failures.join("\n - ")}`;
  return drain.measured ? "RESULTADO: OK" : "RESULTADO: OK (drenado no evaluado)";
}

function report({ sent, stats, percentiles: p, drain, failures }, orderIds) {
  const fmt = (n) => (Number.isFinite(n) ? `${n.toFixed(1)} ms` : "n/d");
  console.log(`enviados: ${sent}`);
  console.log(orderIds.length
    ? `mezcla: 80 % product/updated, 20 % order/paid (${orderIds.length} ids reales)`
    : "mezcla: 100 % product/updated (eventos order/paid omitidos: no se pasó --order-ids)");
  console.log(`latencia: p50 ${fmt(p.p50)} | p95 ${fmt(p.p95)} | p99 ${fmt(p.p99)}`);
  console.log(`respuestas: 2xx ${stats.s2xx} | 4xx ${stats.s4xx} | 5xx ${stats.s5xx} | otras ${stats.other} | errores de red ${stats.errors}`);
  if (drain.skipped) console.log("drenado de cola: omitido (--no-drain)");
  else if (!drain.measured) console.log("drenado de cola: no medido (/api/status no disponible)");
  else if (Number.isFinite(drain.seconds)) console.log(`drenado de cola: ${drain.seconds.toFixed(0)} s tras terminar la ráfaga`);
  else console.log(`drenado de cola: NO drenó (pendientes: ${drain.pending ?? "?"})`);
  console.log(verdictLine(failures, drain));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = parseArgs(process.argv.slice(2));
  const missing = validateOptions(a);
  if (missing) {
    console.error(missing);
    process.exit(2);
  }
  const secret = a.secret || process.env.TIENDANUBE_CLIENT_SECRET;
  const usage = "Uso: TIENDANUBE_CLIENT_SECRET=... webhook-burst.mjs --url <receptor> [--rps 50] [--duration 600] [--store-id 1] [--order-ids 101,102] [--status-url <url>] [--no-drain]";
  if (!a.url || !secret) {
    console.error(usage);
    process.exit(2);
  }
  if (a.secret) console.error("Aviso: --secret queda en el historial y en ps; prefiera la variable TIENDANUBE_CLIENT_SECRET.");
  const rps = Number(a.rps ?? 50);
  const duration = Number(a.duration ?? 600);
  const invalid = validateRates(rps, duration);
  let orderIds;
  try {
    orderIds = parseOrderIds(a["order-ids"]);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (invalid) {
    console.error(`${invalid}\n${usage}`);
    process.exit(2);
  }
  const result = await run({
    url: a.url,
    secret,
    rps,
    duration,
    storeId: Number(a["store-id"] ?? 1),
    orderIds,
    noDrain: a["no-drain"] === true,
    statusUrl: a["status-url"],
  });
  report(result, orderIds);
  process.exit(result.failures.length ? 1 : 0);
}

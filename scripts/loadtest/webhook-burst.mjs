#!/usr/bin/env node
// Prueba de carga del receptor de webhooks de Tiendanube (perfil Hot Sale).
//
//   node scripts/loadtest/webhook-burst.mjs --url https://staging/api/functions/v1/tiendanube-webhook \
//     --secret "$TIENDANUBE_CLIENT_SECRET" --rps 50 --duration 600 --store-id 123456
//
// Sin dependencias: solo Node >= 18 (fetch global). Mezcla 80 % product/updated y 20 % order/paid,
// rampa lineal durante el primer 10 % de la duración, y luego consulta /api/status para medir
// cuánto tarda el worker en drenar la cola. Código de salida != 0 si no se cumplen los criterios.
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

const P95_LIMIT_MS = 500;
const DRAIN_LIMIT_S = 300;

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

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

let orderSeq = 1_000_000;
function nextEvent(storeId) {
  // ponytail: ids al azar; el receptor solo valida y encola, no consulta el recurso.
  if (Math.random() < 0.8) {
    return { store_id: storeId, event: "product/updated", id: 1 + Math.floor(Math.random() * 5000) };
  }
  return { store_id: storeId, event: "order/paid", id: orderSeq++ };
}

async function sendOne(url, secret, storeId, stats) {
  const body = JSON.stringify(nextEvent(storeId));
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-linkedstore-hmac-sha256": signBody(body, secret) },
      body,
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
  const { url, secret, rps, duration, storeId } = opts;
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
      const p = sendOne(url, secret, storeId, stats).finally(() => inflight.delete(p));
      inflight.add(p);
      sent++;
    }
  }
  await Promise.all(inflight);
  const burstEnd = Date.now();

  const statusUrl = opts.statusUrl || new URL("/api/status", url).href;
  const drain = await measureDrain(statusUrl, burstEnd);

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

function report({ sent, stats, percentiles: p, drain, failures }) {
  const fmt = (n) => (Number.isFinite(n) ? `${n.toFixed(1)} ms` : "n/d");
  console.log(`enviados: ${sent}`);
  console.log(`latencia: p50 ${fmt(p.p50)} | p95 ${fmt(p.p95)} | p99 ${fmt(p.p99)}`);
  console.log(`respuestas: 2xx ${stats.s2xx} | 4xx ${stats.s4xx} | 5xx ${stats.s5xx} | otras ${stats.other} | errores de red ${stats.errors}`);
  if (!drain.measured) console.log("drenado de cola: no medido (/api/status no disponible)");
  else if (Number.isFinite(drain.seconds)) console.log(`drenado de cola: ${drain.seconds.toFixed(0)} s tras terminar la ráfaga`);
  else console.log(`drenado de cola: NO drenó (pendientes: ${drain.pending ?? "?"})`);
  console.log(failures.length ? `RESULTADO: FALLA\n - ${failures.join("\n - ")}` : "RESULTADO: OK");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = parseArgs(process.argv.slice(2));
  const secret = a.secret || process.env.TIENDANUBE_CLIENT_SECRET;
  if (!a.url || !secret) {
    console.error("Uso: webhook-burst.mjs --url <receptor> --secret <client secret> [--rps 50] [--duration 600] [--store-id 1] [--status-url <url>]");
    process.exit(2);
  }
  const result = await run({
    url: a.url,
    secret,
    rps: Number(a.rps ?? 50),
    duration: Number(a.duration ?? 600),
    storeId: Number(a["store-id"] ?? 1),
    statusUrl: a["status-url"],
  });
  report(result);
  process.exit(result.failures.length ? 1 : 0);
}

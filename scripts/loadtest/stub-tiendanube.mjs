#!/usr/bin/env node
// Stub local de la API de Tiendanube con latencia fija (~50 ms) para aislar el worker del
// rate limit real. Uso: node scripts/loadtest/stub-tiendanube.mjs [--port 4010] [--latency 50] [--host 127.0.0.1]
//
// IMPORTANTE: la app NO permite sobrescribir la base de la API (TN_API está fijo en
// server/functions/_shared/tiendanube.ts). Hasta que sea configurable, este stub no recibe
// tráfico del worker y la prueba solo mide la ACEPTACIÓN de webhooks.
import { createServer } from "node:http";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const port = Number(opt("port", 4010));
const latency = Number(opt("latency", 50));
// Solo loopback por defecto; pasar --host 0.0.0.0 para que un worker en otro equipo lo alcance.
const host = opt("host", "127.0.0.1");

const routes = [
  ["GET", /^\/v1\/(\d+)\/products\/(\d+)$/, (m) => ({
    id: Number(m[2]),
    name: { es: `Producto ${m[2]}` },
    categories: [],
    images: [],
    variants: [{ id: Number(m[2]) * 10, product_id: Number(m[2]), sku: `SKU-${m[2]}`, price: "100.00", stock: 10, inventory_levels: [] }],
  })],
  ["GET", /^\/v1\/(\d+)\/locations$/, () => [{ id: "loc-stub-1", name: { es: "Principal" } }]],
  ["PATCH", /^\/v1\/(\d+)\/products\/stock-price$/, () => []],
];

createServer((req, res) => {
  const path = new URL(req.url, "http://stub").pathname;
  req.resume();
  setTimeout(() => {
    for (const [method, re, build] of routes) {
      const m = req.method === method && path.match(re);
      if (m) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(build(m)));
      }
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 404, message: "Not Found", description: "Stub" }));
  }, latency);
}).listen(port, host, () => console.log(`stub Tiendanube en http://${host}:${port}/v1 (latencia ${latency} ms)`));

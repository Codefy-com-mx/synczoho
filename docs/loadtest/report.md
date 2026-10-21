# Prueba de carga del receptor de webhooks

Estado: **script listo, ejecución en staging PENDIENTE.** Este documento no contiene resultados de rendimiento hasta que el dueño ejecute la prueba.

## Qué se mide

Perfil Hot Sale sobre `POST /api/functions/v1/tiendanube-webhook`:

- 50 webhooks/s sostenidos 600 s (30 000 eventos), ajustable con `--rps` y `--duration`.
- 80 % `product/updated`, 20 % `order/paid`. Cuerpo `{store_id, event, id}` con ids enteros, firmado con HMAC-SHA256 hex del cuerpo crudo en `x-linkedstore-hmac-sha256` (mismo formato que `verifyWebhookSignature`).
- Rampa lineal durante el primer 10 % de la duración.
- El receptor solo valida la firma, inserta en `webhook_events` y responde 200: se mide la ACEPTACIÓN HTTP. Al terminar la ráfaga el script consulta `/api/status` cada 5 s y mide cuánto tarda `queue.pending` en llegar a 0 (drenado del worker). Si `/api/status` no existe imprime "drenado de cola: no medido" y ese criterio queda sin evaluar.

## Criterios de aprobación

| Criterio | Umbral |
|---|---|
| Latencia de aceptación p95 | < 500 ms |
| Respuestas 5xx | 0 |
| Cola drenada tras la ráfaga (si `/api/status` está disponible) | < 300 s |
| Respuestas 4xx / errores de red | 0 (criterio adicional del script: indica firma, secreto o URL incorrectos) |

Código de salida distinto de 0 si algún criterio falla.

## Comando exacto

```
node scripts/loadtest/webhook-burst.mjs \
  --url https://<staging>/api/functions/v1/tiendanube-webhook \
  --secret "$TIENDANUBE_CLIENT_SECRET" \
  --store-id <store_id de la tienda de prueba> \
  --rps 50 --duration 600
```

Opciones: `--url` y `--secret` obligatorias (el secreto también se lee de `TIENDANUBE_CLIENT_SECRET`), `--store-id` (por defecto 1), `--status-url` (por defecto `<origen de --url>/api/status`). Node >= 18, sin dependencias. Usar una tienda de prueba instalada en staging con catálogo importado.

## Stub de la API de Tiendanube

Con 50 eventos/s de producto, el worker llamaría a `GET /products/{id}` y chocaría con el rate limit real (2 req/s por tienda). `scripts/loadtest/stub-tiendanube.mjs` (`node scripts/loadtest/stub-tiendanube.mjs --port 4010 --latency 50`) responde `GET /v1/:store/products/:id`, `GET /v1/:store/locations` y `PATCH /v1/:store/products/stock-price` con 50 ms fijos; cualquier otra ruta devuelve 404.

**Limitación:** `TN_API` (`server/functions/_shared/tiendanube.ts`) está fijo en `https://api.tiendanube.com/v1` y la app NO permite sobrescribirlo. Mientras no sea configurable, el stub no recibe tráfico y la prueba mide solo la ACEPTACIÓN de webhooks. Para aislar la app hay que hacer `TN_API` configurable y apuntar el worker de staging a `http://<host>:4010/v1` (cambio pendiente, fuera de este plan).

## Resultados

Ejecución en staging: **PENDIENTE: ejecutar en staging.**

| Métrica | Valor | Criterio | Resultado |
|---|---|---|---|
| Eventos enviados | PENDIENTE: ejecutar en staging | n/a | n/a |
| p50 (ms) | PENDIENTE: ejecutar en staging | n/a | n/a |
| p95 (ms) | PENDIENTE: ejecutar en staging | < 500 | PENDIENTE: ejecutar en staging |
| p99 (ms) | PENDIENTE: ejecutar en staging | n/a | n/a |
| Respuestas 2xx | PENDIENTE: ejecutar en staging | n/a | n/a |
| Respuestas 4xx | PENDIENTE: ejecutar en staging | 0 | PENDIENTE: ejecutar en staging |
| Respuestas 5xx | PENDIENTE: ejecutar en staging | 0 | PENDIENTE: ejecutar en staging |
| Errores de red | PENDIENTE: ejecutar en staging | 0 | PENDIENTE: ejecutar en staging |
| Drenado de cola (s) | PENDIENTE: ejecutar en staging | < 300 | PENDIENTE: ejecutar en staging |
| Cuello de botella (si falla) | PENDIENTE: ejecutar en staging | n/a | n/a |

Entorno (completar): commit desplegado, tamaño de instancia, pool de Postgres, `TN_API` real o stub, fecha.

## Humo local (prueba del script, NO es un resultado de rendimiento)

Corrida corta contra un receptor falso local (~25 líneas de Node, no el receptor real): valida el HMAC como `verifyWebhookSignature`, responde 200 y expone un `/api/status` simulado que se vacía a 40 eventos/s. No hay base de datos ni worker real: las latencias y el drenado no dicen nada sobre la app.

```
node scripts/loadtest/webhook-burst.mjs --url http://127.0.0.1:4999/api/functions/v1/tiendanube-webhook --secret smoke-secret --rps 5 --duration 10 --store-id 1
enviados: 47
latencia: p50 2.5 ms | p95 4.6 ms | p99 80.2 ms
respuestas: 2xx 47 | 4xx 0 | 5xx 0 | otras 0 | errores de red 0
drenado de cola: 0 s tras terminar la ráfaga
RESULTADO: OK        (exit 0)
```

Comprobaciones adicionales del script: con un secreto incorrecto, 9 respuestas 401, `RESULTADO: FALLA` y salida 1; con `--status-url` apuntando a una ruta inexistente, "drenado de cola: no medido" sin fallar; el stub respondió 200 a `GET products/7`, `GET locations` y `PATCH stock-price` (~50 ms) y 404 a otra ruta; `src/lib/loadtest-sign.test.ts` verifica `signBody` contra `verifyWebhookSignature`.

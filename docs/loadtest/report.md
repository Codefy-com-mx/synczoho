# Prueba de carga del receptor de webhooks

Estado: **script listo, ejecución en staging PENDIENTE.** Este documento no contiene resultados de rendimiento hasta que se ejecute la prueba en staging y se peguen aquí los resultados.

## Qué se mide (y qué no)

Se prueba `POST /api/functions/v1/tiendanube-webhook`. El receptor solo valida la firma HMAC-SHA256, inserta el evento en `webhook_events` y responde 200. Por eso hay dos mediciones distintas:

1. **Aceptación de webhooks** (latencia y errores del receptor). Los criterios p95 y 0 respuestas 5xx aplican a esto.
2. **Drenado de la cola** (cuánto tarda el worker en procesar lo aceptado). El worker procesa de forma secuencial como máximo 20 eventos por ciclo de 10 s (`server/webhook-worker.ts`, `server/index.ts`), es decir, **como máximo ~2 eventos/s**, y cada `product/updated` hace un `GET /products/{id}` a Tiendanube (sujeto a su rate limit). A 50 eventos/s el receptor acepta mucho más de lo que el worker puede procesar: el backlog crece durante la ráfaga.

Consecuencia: con el perfil de aceptación (50 eventos/s durante 600 s) el criterio de drenado **no es alcanzable** (~28 500 eventos a ≤2 eventos/s son al menos ~4 horas). Por eso el drenado se mide con un perfil aparte, pequeño.

Detalles comunes:

- Cuerpo `{store_id, event, id}` con ids enteros, firmado con HMAC-SHA256 hex del cuerpo crudo en `x-linkedstore-hmac-sha256` (mismo formato que `verifyWebhookSignature`).
- Rampa lineal durante el primer 10 % de la duración. Con los valores por defecto (50 eventos/s, 600 s) el objetivo es de ~28 500 eventos (la rampa reduce el total frente a 30 000).
- Por defecto el mix es **100 % `product/updated`** con ids al azar (un id inexistente solo hace que el worker reciba 404 y borre una fila de caché). Los `order/paid` solo se envían si se pasan **ids de pedidos reales** con `--order-ids 101,102,...`; entonces el mix es 80 % `product/updated` y 20 % `order/paid`. Con ids de pedido inventados cada evento falla (Tiendanube responde 404 al leer el pedido), se reintenta con backoff de hasta 3600 s y sigue generando errores y ruido en los logs; al llegar a 5 intentos pasa a contar como evento fallido (`queue.failed` en `/status`) y quedan miles de eventos fallando en staging. Sin `--order-ids` el script lo avisa en su salida.
- Por defecto, tras la ráfaga el script consulta `GET /api/status` cada 5 s hasta que `queue.pending` llegue a 0 y mide ese tiempo (hasta 360 s de espera; si no llega a 0 el resultado es FALLA). Si `/api/status` no responde imprime "drenado de cola: no medido" y la última línea dice `RESULTADO: OK (drenado no evaluado)`.
- `--no-drain` omite por completo esa consulta (imprime "drenado de cola: omitido (--no-drain)" y termina con `RESULTADO: OK (drenado no evaluado)`). Es obligatorio en el perfil de aceptación A: sin él el script esperaría el drenado de ~28 500 eventos y terminaría en FALLA por diseño.
- `queue.pending` de `/status` cuenta solo los eventos **listos para procesar** (`processed = false` y `next_attempt_at <= now()`). Un evento que falló y espera su reintento con backoff no cuenta como pendiente, así que una lectura de 0 no significa que no haya eventos fallando: revisar también `queue.failed` y `webhook_events.error_message`. Si la cola ya tenía eventos listos antes de empezar, el drenado incluye ese backlog.

## Criterios de aprobación

| Criterio | Umbral | Perfil |
|---|---|---|
| Latencia de aceptación p95 | < 500 ms | aceptación |
| Respuestas 5xx | 0 | aceptación |
| Respuestas 4xx / errores de red / timeouts de 10 s | 0 (criterio adicional del script: indica firma, secreto o URL incorrectos) | ambos |
| Cola drenada tras terminar la ráfaga | < 300 s | solo perfil de drenado (en el perfil A se omite con `--no-drain`) |

El script termina con código distinto de 0 si algún criterio falla, y con 2 si los argumentos son inválidos.

## Comandos exactos

El secreto es el client secret real de la app: pásese por la variable de entorno `TIENDANUBE_CLIENT_SECRET` y no con `--secret`, que queda visible en `ps` y en el historial del shell.

**A. Perfil de aceptación** (50 eventos/s, 600 s; `--no-drain` porque el drenado de este volumen no se evalúa):

```bash
export TIENDANUBE_CLIENT_SECRET=...   # client secret de la app
node scripts/loadtest/webhook-burst.mjs \
  --url https://<staging>/api/functions/v1/tiendanube-webhook \
  --store-id <store_id de una tienda de prueba desechable> \
  --rps 50 --duration 600 --no-drain
```

Advertencia: esta corrida deja en staging un backlog de ~28 500 eventos que el worker tardará horas en drenar. Ejecutarla con una **tienda de prueba desechable** y limpiar después los eventos pendientes de esa tienda:

```sql
DELETE FROM webhook_events WHERE store_id = '<store_id>' AND processed = false;
```

**B. Perfil de drenado** (~285 eventos, sin `--no-drain`; a ~2 eventos/s el worker termina ~85 s después de acabar la ráfaga, ~150 s desde el inicio, dentro del umbral de 300 s):

```bash
node scripts/loadtest/webhook-burst.mjs \
  --url https://<staging>/api/functions/v1/tiendanube-webhook \
  --store-id <store_id> \
  --rps 5 --duration 60
```

Opciones: `--url` obligatoria; `--store-id` (por defecto 1); `--order-ids` (ids reales de pedidos de esa tienda; sin ellos no se envían `order/paid`); `--status-url` (por defecto `<origen de --url>/api/status`); `--no-drain` (no consultar la cola). Node >= 18, sin dependencias. Usar una tienda de prueba instalada en staging con el catálogo importado.

## Stub de la API de Tiendanube (aislar el rate limit)

La API real limita las requests por tienda, así que miles de `GET /products/{id}` medirían el rate limit de Tiendanube y no la app. `scripts/loadtest/stub-tiendanube.mjs` (`node scripts/loadtest/stub-tiendanube.mjs --port 4010 --latency 50`; escucha en 127.0.0.1, `--host 0.0.0.0` para otro equipo) responde `GET /v1/:store/products/:id`, `GET /v1/:store/locations` y `PATCH /v1/:store/products/stock-price` con 50 ms fijos; cualquier otra ruta devuelve 404.

**Limitación:** `TN_API` (`server/functions/_shared/tiendanube.ts`) está fijo en `https://api.tiendanube.com/v1` y la app NO permite sobrescribirlo. Mientras no sea configurable, el stub no recibe tráfico, la prueba mide la aceptación de webhooks y el drenado del perfil B depende de la latencia real de Tiendanube. Para aislar la app hay que hacer `TN_API` configurable y apuntar el worker de staging a `http://<host>:4010/v1` (cambio pendiente, fuera del alcance de este informe).

## Resultados

Ejecución en staging: **PENDIENTE: ejecutar en staging.**

### Perfil A (aceptación)

| Métrica | Valor | Criterio | Resultado |
|---|---|---|---|
| Eventos enviados | PENDIENTE: ejecutar en staging | n/a | n/a |
| p50 (ms) | PENDIENTE: ejecutar en staging | n/a | n/a |
| p95 (ms) | PENDIENTE: ejecutar en staging | < 500 | PENDIENTE: ejecutar en staging |
| p99 (ms) | PENDIENTE: ejecutar en staging | n/a | n/a |
| Respuestas 2xx | PENDIENTE: ejecutar en staging | n/a | n/a |
| Respuestas 4xx | PENDIENTE: ejecutar en staging | 0 | PENDIENTE: ejecutar en staging |
| Respuestas 5xx | PENDIENTE: ejecutar en staging | 0 | PENDIENTE: ejecutar en staging |
| Errores de red / timeouts | PENDIENTE: ejecutar en staging | 0 | PENDIENTE: ejecutar en staging |
| Cuello de botella (si falla) | PENDIENTE: ejecutar en staging | n/a | n/a |

### Perfil B (drenado)

| Métrica | Valor | Criterio | Resultado |
|---|---|---|---|
| Eventos enviados | PENDIENTE: ejecutar en staging | n/a | n/a |
| Drenado de cola (s) | PENDIENTE: ejecutar en staging | < 300 | PENDIENTE: ejecutar en staging |

Entorno (completar): commit desplegado, tamaño de instancia, pool de Postgres, `TN_API` real o stub, fecha.

## Humo local (prueba del script, NO es un resultado de rendimiento)

Corrida corta contra un receptor falso local (~25 líneas de Node, no el receptor real): valida el HMAC como `verifyWebhookSignature`, responde 200 y expone un `/api/status` simulado que se vacía a 40 eventos/s. No hay base de datos ni worker real: las latencias y el drenado no dicen nada sobre la app.

```
TIENDANUBE_CLIENT_SECRET=smoke-secret node scripts/loadtest/webhook-burst.mjs --url http://127.0.0.1:4999/api/functions/v1/tiendanube-webhook --rps 5 --duration 10 --store-id 1
enviados: 47
mezcla: 100 % product/updated (eventos order/paid omitidos: no se pasó --order-ids)
latencia: p50 4.0 ms | p95 10.9 ms | p99 79.2 ms
respuestas: 2xx 47 | 4xx 0 | 5xx 0 | otras 0 | errores de red 0
drenado de cola: 0 s tras terminar la ráfaga
RESULTADO: OK        (exit 0)
```

Comprobaciones adicionales del script contra el mismo receptor falso:

- Con `--order-ids 101,102` y `--status-url` a una ruta inexistente: `mezcla: 80 % product/updated, 20 % order/paid (2 ids reales)`, `drenado de cola: no medido (/api/status no disponible)` y `RESULTADO: OK (drenado no evaluado)`.
- Con `--rps abc`, `--order-ids 1,x` o una opción sin valor (`--rps` solo): mensaje de error ("falta el valor de --rps") y salida 2. Solo `--no-drain` puede ir sin valor.
- `src/lib/loadtest-sign.test.ts` ejecuta el CLI real contra un servidor local y comprueba de extremo a extremo que `--no-drain` no consulta `/api/status` y termina con `RESULTADO: OK (drenado no evaluado)`.
- Con un secreto incorrecto (corrida anterior de la primera versión del script): 9 respuestas 401, `RESULTADO: FALLA` y salida 1.
- El stub respondió 200 a `GET products/7`, `GET locations` y `PATCH stock-price` (~50 ms) y 404 a otra ruta.
- `src/lib/loadtest-sign.test.ts` verifica `signBody` contra `verifyWebhookSignature`, el mix con y sin `--order-ids`, la validación de argumentos y la línea de veredicto.

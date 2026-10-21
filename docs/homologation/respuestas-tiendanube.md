# Respuestas a las 5 preguntas de Tiendanube (homologación ERP)

App ID 40863. Cada respuesta indica la evidencia que se adjunta y el estado real de la funcionalidad. Las secciones 1 a 5 y el resumen están redactados para enviarse a Tiendanube; las "Notas internas" del final no se envían.

## 1. ¿Realizaron un stress test?

**Respuesta:** Se preparó un script propio (`scripts/loadtest/webhook-burst.mjs`) que firma webhooks con HMAC-SHA256 y envía una ráfaga tipo Hot Sale al receptor de webhooks de staging: 50 eventos/s durante 10 min con rampa inicial (~28 500 eventos), principalmente `product/updated` (y `order/paid` cuando se le indican pedidos reales). Mide latencia de aceptación p50/p95/p99 y respuestas 4xx/5xx; esa corrida se lanza con `--no-drain`, porque el drenado de ese volumen no se evalúa (comandos exactos en `docs/loadtest/report.md`). Criterios de aprobación: p95 < 500 ms y 0 respuestas 5xx en la aceptación de webhooks.

El receptor valida la firma, guarda el evento y responde de inmediato; un worker lo procesa después. Ese worker procesa como máximo ~2 eventos/s, de modo que un backlog de ~28 500 eventos tarda horas en vaciarse. Por eso el tiempo de drenado de la cola (criterio: < 5 min) se mide con un perfil aparte y pequeño (5 eventos/s durante 60 s, ~285 eventos; se espera que la cola quede vacía ~85 s después de terminar la ráfaga, ~150 s desde el inicio), no con la ráfaga completa.

**Evidencia a adjuntar:** `docs/loadtest/report.md` (método, criterios, comandos y resultados), scripts en `scripts/loadtest/`.

**Estado:** script listo, **ejecución pendiente en staging**. Hasta que se ejecute y se pegue el resultado en el informe, esta respuesta no debe enviarse como "realizado". Además, la base de la API de Tiendanube no es configurable en la app, así que la prueba mide la aceptación de webhooks y no aísla el rate limit de Tiendanube (ver el informe).

## 2. ¿Tienen una página de estado (status page)?

**Respuesta:** Sí. `/status` es una página pública, sin autenticación y sin datos de tiendas, que se actualiza cada 30 s y muestra: etiqueta de estado (Operativo, Degradado o Caído), versión, estado de la base de datos, eventos pendientes de la cola de webhooks (solo los listos para procesar: un evento que espera su reintento no cuenta, por lo que 0 no implica que no haya eventos fallando), antigüedad del evento pendiente más antiguo, eventos fallidos, catálogos desactualizados y la última sincronización exitosa de stock y de precios. El estado pasa a Degradado automáticamente si el evento pendiente más antiguo supera 600 s, hay eventos fallidos o algún catálogo está desactualizado; Caído si la base de datos no responde. No hay gestión manual de incidentes. Los mismos datos están en `GET /api/status` (JSON; responde 503 si está Caído).

**Evidencia a adjuntar:** enlace a `https://<dominio de producción>/status`, captura de pantalla y salida de `GET /api/status`.

**Estado:** implementada en el código (`server/status.ts`, `server/status-page.ts`). El enlace funcionará cuando esa versión esté desplegada en producción.

## 3. ¿Cómo manejan los errores 429 (rate limit)?

**Respuesta:** Ante un 429, la app espera el tiempo indicado en `Retry-After`; si el encabezado no viene, usa espera exponencial con base de 2 s y tope de 30 s, y suma un jitter aleatorio de hasta +25 %. Reintenta hasta 4 veces. Además reduce de raíz el número de requests: el stock y el precio se actualizan con `PATCH /products/stock-price` en lotes de hasta 50 variantes, y el catálogo se mantiene con webhooks en lugar de consultar `/products` periódicamente. Si se agotan los reintentos del `PATCH /products/stock-price` de la sincronización de stock, o de las lecturas de la importación del catálogo, queda una fila `tn_retry_exhausted` en `sync_logs`; si una sincronización automática de stock o precios termina con errores y el comerciante activó las alertas, recibe un correo con el detalle. Los reintentos individuales no se guardan en `sync_logs`: se ven en el log del servidor (`[TN] 429 en <ruta>. Reintento n/4 en <ms>`) y en el historial de requests de Tiendanube.

**Evidencia a adjuntar:** historial de requests de Tiendanube mostrando un 429 y su reintento, paso 11 del video, y filas `tn_retry_exhausted` de `sync_logs` si llegaran a ocurrir. Pruebas unitarias del comportamiento: `src/lib/tn-retry.test.ts`.

**Estado:** implementado con ese alcance. Un 429 agotado no dispara por sí mismo una alerta por correo; la alerta sale cuando la ejecución programada termina con errores.

## 4. ¿Cuál es su política de reintentos?

**Respuesta:**

- 429: respeta `Retry-After`; si falta, espera exponencial de base 2 s y tope 30 s. Se suma un jitter aleatorio de hasta +25 % en todos los casos.
- Errores 500, 502, 503 y 504 y errores de red: espera exponencial de base 500 ms y tope 8 s, con el mismo jitter de hasta +25 %, **solo en métodos idempotentes** (GET, HEAD, PUT, PATCH, DELETE). Otros códigos 5xx (por ejemplo 501) no se reintentan. Un `POST` solo se reintenta ante 429, para no duplicar recursos.
- Máximo 4 reintentos por request.
- Webhooks entrantes: se validan, se guardan en `webhook_events` y se responde 200 de inmediato; el worker reintenta cada evento con espera exponencial persistida en la base de datos (60 s · 2^intentos, tope 3600 s). Tras 5 intentos fallidos de un evento de catálogo, la tienda queda con el catálogo "Desactualizado" y se envía una alerta por correo (si el comerciante activó las alertas); se recupera con "Resincronizar catálogo".

**Evidencia a adjuntar:** `src/lib/tn-retry.test.ts`, `src/lib/tn-webhooks.test.ts` y `src/lib/webhook-worker-catalog.test.ts`; filas de `webhook_events` (columnas `attempts` y `error_message`).

**Estado:** implementado.

## 5. ¿Cómo registran y consultan los logs de errores?

**Respuesta:** Los resultados y errores de cada sincronización se guardan en la tabla `sync_logs` (operación, estado, mensaje y duración), que el comerciante ve en la sección Historial de la app; los errores de procesamiento de webhooks se guardan en `webhook_events.error_message`, junto con el número de intentos. Los logs del servidor no incluyen tokens de acceso ni secretos. Los mensajes de error pueden incluir hasta 500 caracteres del texto de error devuelto por Tiendanube o por Zoho; no se garantiza que ese texto de terceros esté libre de datos personales.

**Evidencia a adjuntar:** captura de la sección Historial; consulta de ejemplo a `sync_logs` y `webhook_events`; contador de eventos fallidos en `/status`.

**Estado:** implementado. No debe afirmarse que los logs "nunca contienen datos personales": ver las notas internas.

## Resumen de estado

| # | Pregunta | Respuesta | Evidencia | Estado |
|---|---|---|---|---|
| 1 | Stress test | Script propio, aceptación y drenado en perfiles distintos | `docs/loadtest/report.md` | Script listo, ejecución pendiente en staging |
| 2 | Status page | Sí, `/status` | `/status`, `/api/status` | Implementada; depende del despliegue |
| 3 | Manejo de 429 | `Retry-After` + backoff con jitter, `tn_retry_exhausted` en stock y catálogo | historial de Tiendanube, `sync_logs` | Implementado con ese alcance |
| 4 | Política de reintentos | 429, 500/502/503/504 y red; webhooks con espera persistida | tests, `webhook_events` | Implementado |
| 5 | Logs de errores | `sync_logs`, `webhook_events.error_message` | Historial, consultas | Implementado; datos personales en texto de terceros no garantizado |

Ítems del checklist aún no cubiertos (se responden como fase 2): kit, producto de obsequio, persona jurídica (`billing_*`), cancelar pedido de Zoho a Tiendanube (sin y con pago) y exportar categorías como funcionalidad propia. Ver `docs/homologation/demo-script.md`.

## Notas internas (no enviar)

Verificado contra el código al preparar este documento:

- `tnFetchWithRetry` (`server/functions/_shared/tiendanube.ts`) solo hace `console.warn` por reintento; no escribe en `sync_logs` ni envía correo. Avisa a `observer.onExhausted` al agotar reintentos.
- El observer `logRetryObserver` (`server/functions/_shared/tn-observer.ts`) solo llama a `logSync` con `tn_retry_exhausted`; nunca envía alerta. Está conectado únicamente en `sync-stock-run` y en el backfill del catálogo (`webhook-worker.ts` vía `backfillCatalog`). No está conectado en `sync-prices-run`, `zoho-sync-import`, `category-mappings`, `fetchTnLocations`, `sync-customers-bulk`, ni en `refreshProduct`/`refreshCategory`.
- Los únicos correos de alerta son el de catálogo desactualizado (`webhook-worker.ts`, `onEventFailure`) y el de ejecución programada fallida (`sync-auto-run`, que solo envía si `alert_on_error` está activo y hay `alert_email`).
- Algunas llamadas a Tiendanube no pasan por el reintento: registro y borrado de webhooks (`_shared/webhooks.ts`, `tiendanube-webhooks-manage`) y `tn-send-tracking` usan `tnFetch` directo.
- Logs y datos personales: ningún `console.*` imprime tokens ni secretos (solo textos fijos y códigos de estado). Pero `zoho-create-salesorder` imprime con `console.error` el JSON de error de Zoho al fallar la creación de contacto, factura o pago; `tiendanube-auth` imprime nombre y dominio de la tienda; y `tnFetchJson`, `webhook_events.error_message` y `sync_logs.message` incluyen hasta 400-500 caracteres del cuerpo de error del proveedor. No hay redacción de datos personales en ese texto.
- Antes de enviar la respuesta 5, revisar una muestra reciente de `sync_logs` y `webhook_events.error_message`.
- En `sync-stock-run` el observer solo se pasa al `PATCH /products/stock-price` (`server/functions/sync-stock-run/index.ts:218`); un reintento agotado en `GET /locations` (`fetchTnLocations`, línea 97) no se registra. `GET /locations` se llama en cada sincronización de stock y en exportaciones con stock (`zoho-sync-import/index.ts:116`).
- `queue.pending` de `/status` cuenta solo eventos listos (`next_attempt_at <= now()`); los eventos en backoff no cuentan hasta que vence su espera, y `queue.failed` cuenta los que tienen `attempts >= 5` y `error_message`.
- Verificar en la grabación (paso 6 del guion) el efecto real de la orden de venta confirmada sobre el stock en Zoho (comprometido/disponible vs. físico): el repositorio no lo comprueba.
- Pendientes antes de enviar: ejecutar la prueba de carga en staging (respuesta 1) y desplegar la versión con `/status` en producción (respuesta 2).

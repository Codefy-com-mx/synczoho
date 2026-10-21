# Respuestas a las 5 preguntas de Tiendanube (homologación ERP)

App ID 40863. Cada respuesta indica la evidencia a adjuntar y el estado real al día de hoy. Donde la evidencia depende de una acción pendiente del dueño, se dice explícitamente.

## 1. ¿Realizaron un stress test?

**Respuesta:** Sí, mediante un script propio que firma webhooks con HMAC-SHA256 y envía una ráfaga tipo Hot Sale (50 eventos/s sostenidos 10 min, 80 % `product/updated` y 20 % `order/paid`, con rampa inicial) al receptor de webhooks de staging. Mide latencia de aceptación p95/p99, respuestas 5xx y el tiempo que tarda el worker en drenar la cola. Criterios: p95 < 500 ms, 0 respuestas 5xx, cola drenada en < 5 min.

**Evidencia a adjuntar:** `docs/loadtest/report.md` (método, criterios, comando y resultados), scripts en `scripts/loadtest/`.

**Estado honesto:** script listo; **ejecución pendiente en staging**. No se debe enviar esta respuesta como "realizado" hasta que el dueño ejecute `node scripts/loadtest/webhook-burst.mjs ...` y pegue el resultado en el informe. Además, mientras la base de la API de Tiendanube (`TN_API`) no sea configurable, la prueba mide la aceptación de webhooks y no aísla el rate limit de Tiendanube (ver el informe).

## 2. ¿Tienen una página de estado (status page)?

**Respuesta:** Sí. `/status` es una vista pública, sin autenticación y sin datos de tiendas, que muestra: estado de la base de datos, atraso de la cola de webhooks (edad del evento pendiente más antiguo), eventos fallidos, último éxito del scheduler por operación y versión. El estado `degraded` se calcula automáticamente; no hay gestión manual de incidentes. Los mismos datos están en `GET /api/status` (JSON).

**Evidencia a adjuntar:** enlace a `https://<dominio de producción>/status` y captura de pantalla; salida de `GET /api/status`.

**Estado honesto:** implementada en la Tarea 13 del plan; depende de que esa tarea esté desplegada en producción antes de enviar el enlace.

## 3. ¿Cómo manejan los errores 429 (rate limit)?

**Respuesta:** Ante un 429, la app espera el tiempo indicado en `Retry-After`; si el encabezado no viene, usa backoff exponencial con base de 2 s, tope de 30 s y jitter. Reintenta hasta 4 veces. Si se agotan los reintentos, registra el evento `tn_retry_exhausted` en `sync_logs` y dispara el correo de alerta para revisar la integración. Además, la actualización de stock y precio usa `PATCH /products/stock-price` en lotes de hasta 50 variantes, y el catálogo se mantiene con webhooks en lugar de consultar `/products` periódicamente, lo que reduce de raíz el número de requests.

**Evidencia a adjuntar:** filas de `sync_logs` con reintentos y con `tn_retry_exhausted`; paso 11 del video (`docs/homologation/demo-script.md`); historial de requests de Tiendanube mostrando el 429 y su reintento.

**Estado honesto:** implementado. El caso de agotamiento es difícil de provocar en vivo; si no se logra, se aporta el código y las pruebas unitarias (`src/lib/tn-retry.test.ts`) en lugar de una captura.

## 4. ¿Cuál es su política de reintentos?

**Respuesta:**

- 429: respeta `Retry-After`; si falta, backoff exponencial base 2 s, tope 30 s, con jitter.
- 5xx y errores de red: backoff exponencial base 500 ms, tope 8 s, con jitter, **solo en métodos idempotentes** (GET, HEAD, PUT, PATCH, DELETE). Un `POST` solo se reintenta ante 429, para no duplicar recursos.
- Máximo 4 reintentos por request. Al agotarlos se registra `tn_retry_exhausted` en `sync_logs` y se envía la alerta.
- Webhooks entrantes: se validan, se guardan en `webhook_events` y se responde 200 de inmediato; el worker reintenta con backoff exponencial persistido en base de datos (60 s · 2^intentos, tope 3600 s). Tras 5 intentos fallidos de un evento de catálogo, la tienda se marca con catálogo "desactualizado" y se envía una alerta; el comerciante lo recupera con "Resincronizar catálogo".

**Evidencia a adjuntar:** `src/lib/tn-retry.test.ts`, `src/lib/tn-webhooks.test.ts` y `src/lib/webhook-worker-catalog.test.ts`; filas de `webhook_events` (columnas de intentos y `error_message`) y de `sync_logs`.

**Estado honesto:** implementado.

## 5. ¿Cómo registran y consultan los logs de errores?

**Respuesta:** Los errores de sincronización se guardan en la tabla `sync_logs` (operación, tienda, resultado y detalle) y los de procesamiento de webhooks en `webhook_events.error_message`, con el número de intentos. Ningún log incluye tokens de acceso ni datos personales de clientes. El comerciante ve el historial de sincronizaciones en la app y el equipo consulta las tablas directamente; los fallos graves generan correo de alerta.

**Evidencia a adjuntar:** captura del historial de sincronizaciones en la app; consulta de ejemplo a `sync_logs` y `webhook_events` con los campos sensibles ausentes; `/status` para el contador agregado de eventos fallidos.

**Estado honesto:** implementado. Antes de enviar, verificar con una muestra reciente de `sync_logs` y `webhook_events.error_message` que no aparezcan tokens ni datos de clientes.

## Resumen de estado

| # | Pregunta | Respuesta | Evidencia | Estado |
|---|---|---|---|---|
| 1 | Stress test | Sí (script) | `docs/loadtest/report.md` | Script listo, ejecución pendiente en staging |
| 2 | Status page | Sí | `/status`, `/api/status` | Implementada; desplegar antes de enviar |
| 3 | Manejo de 429 | `Retry-After` + backoff + alerta | `sync_logs`, paso 11 del video | Implementado |
| 4 | Política de reintentos | 429 + 5xx + red; webhooks con backoff persistido | tests, `webhook_events` | Implementado |
| 5 | Logs de errores | `sync_logs`, `webhook_events.error_message` | capturas y consultas | Implementado |

Ítems del checklist aún no cubiertos (se responden como fase 2): kit, producto de obsequio, persona jurídica (`billing_*`), cancelar pedido ERP → Tiendanube (sin y con pago) y exportar categorías. Ver `docs/homologation/demo-script.md`.

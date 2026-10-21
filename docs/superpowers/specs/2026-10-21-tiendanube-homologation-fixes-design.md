# Homologación Tiendanube (ERP) — correcciones del Action Plan

Fecha: 2026-10-21 · App ID 40863 · Estado: borrador para aprobación

## Intención

Tiendanube devolvió la homologación con un Action Plan (hoja "Action Plan" del
checklist ERP) y 5 preguntas. Hay que corregir lo que es código, responder lo
que es política/operación y preparar un video que demuestre el resto, para que
re-validen y la app avance a publicación.

Evidencia del polling: `GET /v1/7920795/products` cada ~6 h 15 min, que
coincide con el scheduler `every6h` (`sync-stock-run`, `sync-prices-run`,
`sync-unmatched-list` listan todo `/products?per_page=200`).

## Metas

1. **Cero polling de catálogo a Tiendanube.** Tras un backfill inicial, el
   catálogo se mantiene con webhooks `product/*`, `category/*`, `location/*`.
2. **MultiCD real.** Leer y mapear las locations de la tienda con los
   almacenes de Zoho; leer y escribir stock por location con
   `inventory_levels`; no usar `variant.stock` (deprecado).
3. **Imágenes por separado** vía `POST /products/{id}/images`.
4. **Resiliencia y observabilidad** que permitan responder "sí" a las 5
   preguntas con evidencia (reintentos, 429, logs, status page, prueba de carga).
5. **Guion de demostración** que cubra cada ítem "No demostrado".

## No-metas

- No cambiar el flujo de pedidos (el checklist lo marca Completed).
- No agregar Draft Orders, creación de pedidos/clientes en Tiendanube ni
  productos digitales (todos "Not Applied").
- No tocar `remotion/` ni el material de marketing.
- Anti-meta: un polling disfrazado (cron que relee `/products` "por si acaso").
  La resincronización de catálogo es solo una acción manual del comerciante.

## Restricciones y hechos verificados

- Webhooks `product/created|updated|deleted` y `category/*` envían solo
  `{store_id, event, id}`; hay que consultar `GET /products/{id}` para el detalle.
  Existen también `location/created|updated|deleted` (documentación 2025-03).
- `PATCH /products/stock-price`: máx. 50 variantes por request;
  `inventory_levels[].location_id` es opcional pero, si se omite, usa la
  primera location; un `location_id` inexistente devuelve 422. Ya hay
  `chunkStockPriceBatch`.
- `app/uninstalled|suspended|resumed` ya se manejan. No se toca.
- La app ya valida HMAC y encola en `webhook_events` (responde rápido); el
  worker procesa con reintento exponencial. Se reutiliza esa cola.
- Stack: Node 22, TypeScript, Postgres (`pg`), React/Nimbus. Migraciones SQL en
  `server/migrations/`. Tests con vitest en `src/lib/*.test.ts`.
- Los scopes `read_locations` y `read_fulfillment_orders` se declaran en el
  panel de Partners (acción del dueño de la app, no código). Los comerciantes
  existentes deben reautorizar para obtener el token con los scopes nuevos.

## Diseño

### A. Webhooks en lugar de polling

- `REQUIRED_EVENTS` (`server/functions/_shared/webhooks.ts`) suma
  `product/created|updated|deleted`, `category/created|updated|deleted`,
  `location/created|updated|deleted`. `syncStoreWebhooks` ya crea los faltantes.
- Nueva tabla `tn_variants` (store_id, product_id, variant_id, sku, price,
  promotional_price, inventory_levels jsonb `[{location_id, stock}]`,
  updated_at; PK store_id+variant_id). Nueva tabla `tn_categories`
  (store_id, id, name jsonb).
- El worker (`processEvent`) maneja `product/*` (GET `/products/{id}` con
  `fields=id,variants`, upsert/delete en `tn_variants`), `category/*` y
  `location/*` (refresca el mapeo de locations, ver B).
- **Backfill**: evento interno `internal/backfill` en la misma cola
  `webhook_events`, paginado, con `fields=` y respetando rate limit. Se
  encola al instalar (después de registrar webhooks) y desde un botón manual
  "Importar productos de Tiendanube" / "Resincronizar catálogo" en la UI.
- `sync-stock-run`, `sync-prices-run` y `sync-unmatched-list` leen de
  `tn_variants`. Si la tienda no tiene caché, encolan el backfill y devuelven
  "catálogo en preparación" sin llamar a `/products`.
- **Precio Tiendanube → Zoho (aprobado, dirección exclusiva):** nueva columna
  `sync_settings.prices_direction` (`zoho_to_tn` por defecto | `tn_to_zoho`)
  y selector en Configuración. Con `tn_to_zoho`, el worker, al procesar
  `product/updated`, compara precio/precio promocional contra `tn_variants`
  y, si cambió, actualiza el ítem en Zoho (match por SKU vía
  `product_sync_map`). Con `tn_to_zoho` el sync programado de precios
  Zoho → Tiendanube no corre (así no hay bucles). Sin modo bidireccional.

### B. MultiCD

- Permisos: documentar y verificar `read_locations` y `read_fulfillment_orders`
  en el token (el `scope` viene en la respuesta del token); si faltan, la UI
  pide reautorizar. `write_locations` / `write_fulfillment_orders` no se piden.
- Nueva tabla `location_mappings` (store_id, tn_location_id text,
  tn_location_name, zoho_location_id nullable, zoho_location_name, PK
  store_id+tn_location_id). Se llena con `GET /locations` al instalar y en
  eventos `location/*`; se autoasigna por nombre (normalizado) y por último,
  si la tienda tiene una sola location y Zoho un solo almacén, se vinculan.
  Se edita en Configuración (selector por location). Reemplaza el uso muerto
  de `sync_settings.stock_warehouse_id` y el `getTnDefaultLocationId` que toma
  `/locations[0]` y traga errores.
- Stock Zoho → Tiendanube: por cada par mapeado, el stock del almacén de Zoho
  va a `inventory_levels:[{location_id, stock}]` (siempre con `location_id`
  explícito) vía `PATCH /products/stock-price`. Locations sin mapear no se
  tocan y se avisan en la UI/logs. Si la organización de Zoho no tiene
  multi-almacén, se usa el stock total contra la(s) location(s) mapeada(s).
- Stock Tiendanube → Zoho: comparar por location mapeada y ajustar el
  almacén correspondiente en Zoho.
- Creación y actualización de productos (`zoho-sync-import`): el stock inicial
  va como `inventory_levels` por location mapeada; se elimina el `PUT` con
  `variant.stock` de `syncVariantsUpdate` (sustituido por stock-price).
- Imágenes: `POST /products` sin `images`; luego `POST /products/{id}/images`
  por cada imagen (el camino de actualización ya lo hace).

### C. Resiliencia y observabilidad

- `tnFetchWithRetry`: además de 429 (que ya espera `Retry-After`/backoff),
  reintenta 5xx y errores de red con backoff exponencial + jitter (máx. 4).
  En 429 agotado, registra evento `rate_limit_exhausted` en `sync_logs` y
  dispara la alerta existente (`send-alert-email`) para revisar la
  integración. Ningún log incluye tokens ni datos personales (verificar los
  `console.log` actuales, p. ej. en `tiendanube-auth`).
- Página de estado: `GET /api/status` (JSON, sin datos de tiendas) y vista
  `/status` en el frontend: base de datos, atraso de la cola (edad del evento
  pendiente más antiguo), eventos fallidos, último éxito del scheduler por
  operación, versión. Estado `degraded` calculado, sin gestión manual de
  incidentes.
- Prueba de carga: script Node sin dependencias nuevas
  (`scripts/loadtest/webhook-burst.mjs`) que firma HMAC con el client secret y
  envía ráfagas de `product/updated` y `order/paid` a staging con un perfil
  Hot Sale (rampa a N req/s sostenida 10 min). Criterios: p95 < 500 ms, 0 5xx,
  cola drenada en < 5 min. Resultado en `docs/loadtest/report.md`.

### D. Demostración

`docs/homologation/demo-script.md`: guion paso a paso, ítem por ítem de la
columna "No demostrado", en el orden de las hojas del checklist, con qué
mostrar en pantalla y qué request del historial debe aparecer.

## Brechas de funcionalidad (hoy no existen en el código)

Ítems críticos "No demostrado" cuya funcionalidad no encontré implementada:
kit (producto compuesto), producto de obsequio, importar datos de persona
jurídica (`billing_customer_type`, `billing_business_name`, `billing_trade_name`,
`billing_stats_registration`), cancelar pedido ERP→Tiendanube (sin y con pago),
exportación explícita de categorías, y "sincronización solo de campos
modificados". Ver "Decisiones abiertas".

## Entorno (confirmado por el dueño)

- Scopes `read_locations` y `read_fulfillment_orders` ya declarados en
  Partners. Los comerciantes existentes deben reautorizar para recibirlos.
- Habrá entorno de pruebas (staging) para la carga y el demo.
- El dueño creará una org de Zoho con varios almacenes y una tienda de prueba
  de Tiendanube con varias locations para grabar el video.

## Decisiones del dueño

- Documento aprobado el 2026-10-21.
- Las funciones nuevas (kit, obsequio, persona jurídica, cancelar pedido
  ERP→Tiendanube, exportar categorías) van a una **fase 2**, fuera de este
  plan. Este plan cubre A–D; el video muestra solo lo que ya existe.
- Precio Tiendanube → Zoho: dirección exclusiva, dentro de este plan (ver A).

1. Brechas de funcionalidad: ¿se implementan todas antes del video, o se
   demuestran las que existen y se pide a Tiendanube tratarlas como
   no aplicables / etapa posterior? (Son ítems de 1-3 puntos cada uno.)
2. Precio Tiendanube → Zoho: hoy el precio solo va hacia Tiendanube. El ítem
   pide actualizar el ERP cuando cambia en Tiendanube; ¿se agrega con
   dirección configurable o se acepta ese ítem como no cubierto?

## Decisiones tomadas por mí (revisables)

- **Migración de tiendas existentes:** al desplegar, un paso único reregistra
  webhooks y encola el backfill de cada tienda. Hasta que termine, los syncs
  de esa tienda se omiten con mensaje "catálogo en preparación" (minutos, no
  llama a `/products`).
- **Sin scopes nuevos (comerciante sin reautorizar):** el stock sigue
  funcionando sin `location_id` (Tiendanube usa la primera location) y la UI
  muestra un aviso para reautorizar; el mapeo multi-location queda bloqueado.
- **Caché desactualizada:** no hay reconciliación periódica. Si un evento
  agota reintentos, la tienda se marca "catálogo desactualizado" (visible en
  la UI y en `/status` solo como contador agregado), se dispara la alerta y la
  recuperación es "Resincronizar catálogo".
- **Tiendas con 2+ locations de Tiendanube y sin multi-almacén en Zoho:** no
  se envía stock; la UI pide mapear manualmente la location que recibe el
  total. Nunca se reparte ni se adivina.
- **Conflicto en bidireccional por location:** se respeta `stock_priority`
  existente, aplicado por par mapeado.
- **Carga de prueba:** Tiendanube se simula con un stub (su rate limit de
  2 req/s por tienda haría el resultado inválido); perfil inicial 50 webhooks/s
  sostenidos 10 min, ajustable. Se mide aceptación HTTP (p95) y drenaje de la
  cola.
- **`/status`:** público, sin autenticación, mismo host; se agrega a las listas
  de rutas permitidas y cabeceras de seguridad.
- **`sync_settings.stock_warehouse_id`:** se deja sin usar, sin migración de
  borrado.

## Queda al constructor

Esquema exacto de columnas e índices; nombres de endpoints internos; diseño
visual de la UI de mapeo y de `/status`; librería/formato del script de carga;
cómo detectar scopes faltantes con el token existente; qué endpoint de Zoho
usar para listar almacenes/locations (hay que verificar contra la API: Zoho
usa "warehouse" y "location" según versión de la organización); mensajes de UI.

## Respuestas para Tiendanube (borrador)

- Stress-test: sí, tras C (adjuntar reporte).
- Status page: sí, tras C (`/status`).
- 429: espera `Retry-After`, backoff mayor y alerta si se agota.
- Política de reintentos: 429 + 5xx + red, backoff exponencial con jitter;
  eventos de webhook con reintento exponencial persistido en base de datos.
- Logs de errores: `sync_logs` y `webhook_events.error_message`, sin tokens
  ni datos personales.

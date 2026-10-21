# Homologación Tiendanube (ERP) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar el polling de catálogo a Tiendanube con webhooks, adaptar la app a MultiCD (`inventory_levels` por location), mover imágenes a `/products/{id}/images`, y agregar la resiliencia/observabilidad y artefactos que pide el Action Plan.

**Architecture:** Una caché local `tn_variants` se llena con un backfill paginado (cola `webhook_events`, evento `internal/backfill`) y se mantiene con webhooks `product/*`, `category/*`, `location/*`. Los syncs leen de la caché. Un mapeo `location_mappings` une locations de Tiendanube con locations de Zoho; la lógica de stock por location vive en un módulo puro (`stock-plan.ts`) que `sync-stock-run` ejecuta.

**Tech Stack:** Node 22, TypeScript (ESM, imports `.js`), Postgres (`pg`, `getPool()` / `DatabaseClient`), vitest, React + Nimbus (`@nimbus-ds/components`).

**Spec:** `docs/superpowers/specs/2026-10-21-tiendanube-homologation-fixes-design.md`

## Global Constraints

- Rama nueva desde `main`: `fix/homologacion-multicd-webhooks`. Commits: Conventional Commits en español (como `git log`), terminan con `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- `PATCH /products/stock-price`: máx. 50 variantes por request (`chunkStockPriceBatch` ya existe); con `inventory_levels[].location_id` explícito siempre que se conozca; `location_id` inexistente → 422.
- Nunca enviar `variant.stock` (deprecado) en `POST /products`, `PUT /products/{id}`, `PUT /products/{id}/variants/{id}`.
- Imágenes: solo `POST /products/{id}/images` tras crear el producto.
- Webhooks `product/*`, `category/*`: el payload trae solo `{store_id, event, id}`.
- Nada de polling: ningún código programado (scheduler, `setInterval`) puede llamar `GET /products`. Solo backfill (instalación, despliegue, botón manual).
- Reintentos: 429 respeta `Retry-After`, espera más que en 5xx; 5xx y errores de red se reintentan con backoff exponencial + jitter; máx. 4 reintentos.
- Los logs no incluyen tokens ni datos personales.
- `/status` es público, sin datos de tiendas; `sync_settings.stock_warehouse_id` se deja sin usar (sin migración de borrado).
- Fuera de alcance (fase 2): kit, obsequio, persona jurídica (`billing_*`), cancelar pedido ERP→Tiendanube, exportar categorías, precio bidireccional.
- Cada tarea corre `npx vitest run <su test>`; la tarea final corre `npm run check`.

## Review Focus

1. `GET /products/{id}` responde 404 (producto borrado antes de procesar `product/updated`): se trata como borrado, no se reintenta para siempre. (Tarea 4)
2. Tienda con 2+ locations en Tiendanube y ninguna mapeada: no se envía stock ni se adivina location; la respuesta trae `blocked: "locations_unmapped"`. (Tarea 11)
3. Token sin `read_locations` (403 en `/locations`): el sync sigue sin `location_id` y la UI avisa; no crashea. (Tareas 9, 11)
4. Eco de precio: con `prices_direction = zoho_to_tn`, un `product/updated` causado por nuestro propio PATCH no escribe en Zoho; con `tn_to_zoho` y precio igual al de la caché tampoco. (Tarea 8)
5. Eventos fuera de orden o duplicados (`product/deleted` seguido de un `product/updated` tardío): quedan idempotentes, sin variantes fantasma. (Tareas 4, 5)

---

### Task 1: Migración y limpieza por tienda

**Files:**
- Create: `server/migrations/004_homologation.sql`
- Modify: `server/webhook-worker.ts` (`storeTables`, rama `app/uninstalled`), `server/functions/tiendanube-disconnect/index.ts:25-31`
- Test: `src/lib/store-cleanup.test.ts`

**Interfaces:**
- Produces: tablas `tn_variants(store_id, product_id bigint, variant_id bigint, sku, price numeric, promotional_price numeric, inventory_levels jsonb, updated_at; PK store_id+variant_id)`, `tn_categories(store_id, id bigint, name jsonb, updated_at; PK store_id+id)`, `location_mappings(store_id, tn_location_id text, tn_location_name, zoho_location_id, zoho_location_name; PK store_id+tn_location_id)`; columnas `stores.catalog_status text NOT NULL DEFAULT 'pending' CHECK IN ('pending','ready','stale')`, `stores.catalog_synced_at timestamptz`, `stores.scopes text`; `sync_settings.prices_direction text NOT NULL DEFAULT 'zoho_to_tn' CHECK IN ('zoho_to_tn','tn_to_zoho')`. Exporta `storeTables` desde `server/webhook-worker.ts`.

- [ ] **Step 1: Write the failing test** `store-cleanup.test.ts`: `expect(storeTables).toEqual(expect.arrayContaining(["tn_variants","tn_categories","location_mappings"]))`; y que `server/migrations/004_homologation.sql` (leído con `readFileSync`) contiene `CREATE TABLE IF NOT EXISTS tn_variants`, `prices_direction`, `catalog_status`.
- [ ] **Step 2: Run** `npx vitest run src/lib/store-cleanup.test.ts` → FAIL.
- [ ] **Step 3: Implement** la migración (idempotente: `IF NOT EXISTS`), exportar `storeTables` con las 3 tablas nuevas, borrarlas también en `app/uninstalled` y en `tiendanube-disconnect`.
- [ ] **Step 4: Run** el test → PASS; `npm run typecheck` → sin errores.
- [ ] **Step 5: Commit** `feat(db): tablas de caché de catálogo, mapeo de locations y dirección de precios`

### Task 2: Política de reintentos

**Files:**
- Modify: `server/functions/_shared/tiendanube.ts` (`tnFetchWithRetry`)
- Create: `server/functions/_shared/tn-observer.ts`
- Test: `src/lib/tiendanube.test.ts` (ampliar)

**Interfaces:**
- Produces (`tiendanube.ts`): `export function retryDelayMs(status: number, attempt: number, retryAfter: string | null, random?: () => number): number | null`; `export interface RetryObserver { onExhausted?(info: { status: number; path: string }): void | Promise<void> }`; `tnFetchWithRetry(store, path, init?, maxRetries = 4, observer?: RetryObserver)`.
- Produces (`tn-observer.ts`): `export function logRetryObserver(admin: DatabaseClient, storeId: string): RetryObserver` — en `onExhausted` llama `logSync(admin, storeId, { operation: "tn_retry_exhausted", status: "error", message: "429|5xx|red agotó reintentos en <path>" })`.

- [ ] **Step 1: Write failing tests** en `tiendanube.test.ts`: `retryDelayMs(429, 0, "3", () => 0) === 3000`; `retryDelayMs(429, 2, null, () => 0) === 8000` (base 2000·2^attempt, tope 30000); `retryDelayMs(503, 1, null, () => 0) === 1000` (base 500·2^attempt, tope 8000); `retryDelayMs(500|502|503|504, …)` no es null; `retryDelayMs(404|422|200|501, 0, null) === null`; con `random = () => 1` el resultado es `base * 1.25`. Con `fetch` stubbeado: 503,503,200 → 3 llamadas y devuelve 200; error de red luego 200 → reintenta; 429 ×5 → devuelve el último 429 y llama `observer.onExhausted` una vez con `{status: 429, path}`; 404 → 1 llamada. Usar `vi.useFakeTimers()`.
- [ ] **Step 2: Run** `npx vitest run src/lib/tiendanube.test.ts` → FAIL.
- [ ] **Step 3: Implement** `retryDelayMs` (delay = min(base·2^attempt, cap), más `random()·0.25·delay`; 429 con `Retry-After` > 0 usa ese valor en segundos) y reescribir el bucle de `tnFetchWithRetry`: errores de `fetch` equivalen a status 0 (base 500) y, agotados los reintentos, relanzan el error; conservar la pausa preventiva por `x-rate-limit-request-left`. Crear `tn-observer.ts`.
- [ ] **Step 4: Run** los tests → PASS.
- [ ] **Step 5: Verify logs** `grep -rnE "console\.(log|error|warn)\(.*(token|access_token|secret)" server` → sin coincidencias (si hay, quitar el dato sensible).
- [ ] **Step 6: Commit** `feat(tiendanube): reintentos para 5xx, red y 429 con backoff y jitter`

### Task 3: Eventos de webhook y validación

**Files:**
- Modify: `server/functions/_shared/webhooks.ts` (`REQUIRED_EVENTS`), `server/functions/tiendanube-webhook/index.ts`
- Test: `src/lib/tn-webhooks.test.ts`, `src/lib/webhook.test.ts`

**Interfaces:**
- Produces: `REQUIRED_EVENTS` incluye además `product/created|updated|deleted`, `category/created|updated|deleted`, `location/created|updated|deleted`.

- [ ] **Step 1: Write failing tests**: en `tn-webhooks.test.ts`, `REQUIRED_EVENTS` contiene los 9 eventos nuevos; el test "registers only the missing events" sigue pasando sin cambios. En `webhook.test.ts`: un POST firmado con `{store_id, event:"product/updated"}` (sin `id`) → 400 `Invalid event`; con `id: 55` → 200 y `INSERT` en `webhook_events`; igual para `category/*`; `location/*` acepta `id` string (ULID).
- [ ] **Step 2: Run** `npx vitest run src/lib/tn-webhooks.test.ts src/lib/webhook.test.ts` → FAIL.
- [ ] **Step 3: Implement**: agregar los eventos; en el handler exigir `id` válido para `product/*` (entero seguro) y `category/*` (entero seguro) y `location/*` (string no vacío).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(webhooks): registrar eventos de producto, categoría y location`

### Task 4: Módulo de caché de catálogo

**Files:**
- Create: `server/functions/_shared/tn-catalog.ts`
- Test: `src/lib/tn-catalog.test.ts`

**Interfaces:**
- Consumes: `getPool()` de `server/db.js`; `tnFetchWithRetry`, `TiendanubeStore` de `tiendanube.js`.
- Produces:
  - `interface CatalogVariant { product_id: number; variant_id: number; sku: string; price: number; promotional_price: number | null; inventory_levels: Array<{ location_id: string; stock: number }> }`
  - `toCatalogVariants(product: any): CatalogVariant[]` (puro; omite variantes sin SKU; `inventory_levels` vacío si la API no lo trae)
  - `refreshProduct(store: TiendanubeStore, productId: number): Promise<"updated" | "deleted">` — `GET /products/{id}?fields=id,variants`; 404 → borra; reemplaza todas las filas del producto
  - `deleteProduct(storeId: string, productId: number): Promise<void>`
  - `backfillCatalog(store: TiendanubeStore, observer?: RetryObserver): Promise<{ products: number; variants: number }>` — pagina `/products?per_page=200&page=N&fields=id,variants` hasta página corta (tope 500 páginas), borra filas de la tienda no vistas, deja `stores.catalog_status='ready'`, `catalog_synced_at=now()`
  - `refreshCategory(store, categoryId: number): Promise<void>` (upsert en `tn_categories`; 404 borra)
  - `loadCatalog(storeId: string): Promise<CatalogVariant[]>`
  - `getCatalogStatus(storeId: string): Promise<"pending" | "ready" | "stale">`
  - `enqueueBackfill(storeId: string): Promise<boolean>` — inserta `webhook_events(event_type='internal/backfill', payload='{}')` salvo que ya exista uno sin procesar; devuelve si insertó.

- [ ] **Step 1: Write failing tests** (`getPool` mockeado con pool falso que registra `query(text, values)`; `fetch` stubbeado): `toCatalogVariants` omite variante sin SKU y normaliza `price`/`promotional_price` a número; `refreshProduct` con 404 → `"deleted"` y emite `DELETE FROM tn_variants`; con 200 → reemplaza (delete + upsert) y devuelve `"updated"`; `backfillCatalog` con páginas de 200 y 37 productos hace 2 requests a `/products?` y termina marcando `catalog_status='ready'`; con una página de exactamente 200 seguida de una vacía no se queda en bucle; `enqueueBackfill` no inserta dos veces.
- [ ] **Step 2: Run** `npx vitest run src/lib/tn-catalog.test.ts` → FAIL.
- [ ] **Step 3: Implement** el módulo con SQL directo vía `getPool().query` (upsert `ON CONFLICT (store_id, variant_id)`; `inventory_levels` como `JSON.stringify`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(catalogo): caché local de variantes con backfill paginado`

### Task 5: El worker procesa eventos de catálogo

**Files:**
- Modify: `server/webhook-worker.ts` (exportar `processEvent`; ramas nuevas; clave de lock; marcado `stale`)
- Test: `src/lib/webhook-worker-catalog.test.ts`

**Interfaces:**
- Consumes: Tarea 4 (`refreshProduct`, `deleteProduct`, `refreshCategory`, `backfillCatalog`), `getStore` de `tiendanube.js`, `logRetryObserver`.
- Produces: `export async function processEvent(row: EventRow): Promise<void>` ahora maneja `product/created|updated` → `refreshProduct`, `product/deleted` → `deleteProduct`, `category/*` → `refreshCategory` (deleted → borra), `internal/backfill` → `backfillCatalog`. Tras `attempts >= 5` en eventos de catálogo (`product/`, `category/`, `internal/backfill`): `UPDATE stores SET catalog_status='stale'`, `logSync` error y alerta vía `send-alert-email` con `operation: "catalog_webhook"` (agregar etiqueta en `OP_LABELS`). El lock del evento `internal/*` usa la clave `backfill:${store_id}` en vez de `webhooks:${store_id}` (para no bloquear pedidos).

- [ ] **Step 1: Write failing tests** (módulos de Tarea 4 mockeados): `processEvent` con `product/updated` llama `refreshProduct(store, 55)`; con `product/deleted` llama `deleteProduct`; `product/deleted` y luego `product/updated` cuyo `refreshProduct` devuelve `"deleted"` no lanza; `internal/backfill` llama `backfillCatalog`; `category/updated` llama `refreshCategory`; evento desconocido no lanza.
- [ ] **Step 2: Run** `npx vitest run src/lib/webhook-worker-catalog.test.ts` → FAIL.
- [ ] **Step 3: Implement** las ramas, exportar `processEvent`, cambiar la clave de lock y el marcado `stale` en el `catch` del bucle.
- [ ] **Step 4: Run** → PASS; `npx vitest run src/lib/webhook.test.ts` sigue pasando.
- [ ] **Step 5: Commit** `feat(worker): procesar webhooks de producto y categoría y backfill`

### Task 6: Disparadores de backfill y botón manual

**Files:**
- Create: `server/functions/catalog-resync/index.ts`, `src/components/CatalogCard.tsx`
- Modify: `server/handlers.ts`, `server/functions/tiendanube-auth/index.ts`, `server/index.ts`, `src/components/ConfigurationView.tsx`, `src/components/SyncProductsView.tsx` (botón "Importar productos de Tiendanube" apuntando a la misma función)
- Test: `src/lib/catalog-resync.test.ts`

**Interfaces:**
- Produces: función `catalog-resync` (body `{ storeId, action?: "status" | "resync" }`, auth de comerciante estándar) → `{ catalog_status, catalog_synced_at }`; `resync` encola con `enqueueBackfill` y pone `catalog_status='pending'`. En `server/index.ts`: `export async function resyncAllStores()` (re-registra webhooks con `syncStoreWebhooks` y encola backfill para toda tienda con `catalog_status='pending'`), invocada una vez tras `runMigrations()` si `APP_URL` está definida. `tiendanube-auth` encola backfill después de `syncStoreWebhooks` (también en reinstalación/reautorización).

- [ ] **Step 1: Write failing tests**: `catalog-resync` con `action:"resync"` llama `enqueueBackfill(storeId)` y devuelve `catalog_status:"pending"`; con `action:"status"` no encola; `tiendanube-auth` (test existente `tiendanube-auth.test.ts`) llama `enqueueBackfill` tras instalar.
- [ ] **Step 2: Run** `npx vitest run src/lib/catalog-resync.test.ts src/lib/tiendanube-auth.test.ts` → FAIL.
- [ ] **Step 3: Implement** la función y registrarla en `handlers.ts`; en `tiendanube-auth` encolar tras registrar webhooks; en `server/index.ts` la transición única; `CatalogCard` (estado Tag: Preparando / Al día / Desactualizado + botón "Resincronizar catálogo" y fecha) dentro de `ConfigurationView`; el botón de `SyncProductsView` invoca `catalog-resync`.
- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(catalogo): backfill al instalar, al desplegar y botón de resincronización`

### Task 7: Precios y no-vinculados leen de la caché

**Files:**
- Modify: `server/functions/sync-prices-run/index.ts` (sección 2), `server/functions/sync-unmatched-list/index.ts` (sección 2)
- Test: `src/lib/sync-prices-run.test.ts`, nuevo `src/lib/sync-unmatched-list.test.ts`

**Interfaces:**
- Consumes: `loadCatalog`, `getCatalogStatus` (Tarea 4).
- Produces: ambas funciones devuelven `{ skipped: true, reason: "catalog_not_ready" }` (HTTP 200) cuando el estado es `pending`, sin tocar Zoho ni Tiendanube; con `stale` corren igual (la UI ya avisa que el catálogo puede estar desactualizado); ninguna llama `/products?`.

- [ ] **Step 1: Write failing tests**: actualizar el mock de `tiendanube.js` en `sync-prices-run.test.ts` para que `tnFetchWithRetry` lance si el path empieza con `/products?`, y mockear `tn-catalog.js` con un `loadCatalog` fijo; esperar que el PATCH de precios sea el mismo de antes y que no haya GET a `/products?`; con `getCatalogStatus` = `"pending"` → `{skipped:true, reason:"catalog_not_ready"}` y cero llamadas a Zoho. Análogo en `sync-unmatched-list.test.ts`.
- [ ] **Step 2: Run** `npx vitest run src/lib/sync-prices-run.test.ts src/lib/sync-unmatched-list.test.ts` → FAIL.
- [ ] **Step 3: Implement**: reemplazar el bucle `/products` por `loadCatalog(storeId)` (mismo mapa por SKU con `price` y `promotional_price`); `sync-auto-run` trata `skipped` como neutro (ya lo hace para `already_running`; extender a cualquier `skipped`).
- [ ] **Step 4: Run** → PASS; `npx vitest run src/lib/sync-auto-run.test.ts` sigue pasando.
- [ ] **Step 5: Commit** `fix(sync): precios y no vinculados leen del catálogo local sin polling`

### Task 8: Dirección de precios (Tiendanube → Zoho)

**Files:**
- Create: `server/functions/_shared/price-from-tn.ts`
- Modify: `server/webhook-worker.ts` (rama `product/updated`), `server/functions/sync-settings/index.ts` (`prices_direction` en `DEFAULTS`), `server/functions/sync-auto-run/index.ts` (omitir precios si `tn_to_zoho`), `server/functions/sync-prices-run/index.ts` (rechazar corrida real si `tn_to_zoho`), `src/hooks/useSyncSettings.ts`, `src/components/SyncStockView.tsx` o la vista de precios existente (selector)
- Test: `src/lib/price-from-tn.test.ts`

**Interfaces:**
- Consumes: Tarea 4 (`loadCatalog`, `refreshProduct`), `zohoFetch`, `getZohoConnection`.
- Produces: `diffPrices(before: CatalogVariant[], after: CatalogVariant[]): Array<{ sku: string; price?: number; promotional_price?: number | null }>` (puro; solo variantes existentes antes con cambio ≥ 0.01; variantes nuevas se ignoran); `applyPricesToZoho(admin, storeId: string, changes): Promise<{ updated: number; errors: number }>` — por SKU busca `product_sync_map.zoho_item_id` (ignora ids `group:`) y hace `PUT /inventory/v1/items/{id}` con `{ rate: price }` y `sales_rate: promo ?? price` (espejo de `sync-prices-run`).

- [ ] **Step 1: Write failing tests**: `diffPrices` devuelve `[]` si el precio es igual (eco), ignora variantes nuevas, detecta cambio de promo a `null`; en el worker con `prices_direction='zoho_to_tn'` un `product/updated` no llama `applyPricesToZoho`; con `'tn_to_zoho'` y `prices_enabled` y precio cambiado, sí lo llama una vez con el SKU correcto; con precio igual no lo llama; `sync-auto-run` con `tn_to_zoho` no ejecuta `price_sync_run`; `sync-prices-run` real con `tn_to_zoho` devuelve 400.
- [ ] **Step 2: Run** `npx vitest run src/lib/price-from-tn.test.ts src/lib/sync-auto-run.test.ts src/lib/sync-prices-run.test.ts` → FAIL.
- [ ] **Step 3: Implement**: en la rama `product/updated` del worker leer `before = loadCatalog` del producto antes de `refreshProduct`, comparar con `after` y aplicar solo si la dirección lo permite; selector "Dirección de precios" (Zoho → Tiendanube / Tiendanube → Zoho) con texto de ayuda sobre exclusividad.
- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(precios): dirección exclusiva Tiendanube → Zoho vía webhook de producto`

### Task 9: Locations y mapeo

**Files:**
- Create: `server/functions/_shared/locations.ts`, `server/functions/location-mappings/index.ts`, `src/components/LocationMappingsCard.tsx`
- Modify: `server/handlers.ts`, `server/webhook-worker.ts` (`location/*`), `src/components/ConfigurationView.tsx`
- Test: `src/lib/locations.test.ts`

**Interfaces:**
- Produces:
  - `interface TnLocation { id: string; name: string }`, `interface ZohoLocation { id: string; name: string }`, `interface LocationMapping { tn_location_id: string; tn_location_name: string; zoho_location_id: string | null; zoho_location_name: string | null }`
  - `fetchTnLocations(store: TiendanubeStore): Promise<TnLocation[] | null>` — `GET /locations`; **`null`** si 401/403 (sin scope) o error; el nombre se toma de `name.es ?? name.pt ?? name` o `"Location"`
  - `fetchZohoLocations(admin, conn): Promise<ZohoLocation[]>` — `GET /inventory/v1/locations` → `locations[].location_id/location_name`; `[]` si responde error (org sin multi-location)
  - `autoMatchLocations(tn: TnLocation[], zoho: ZohoLocation[], existing: LocationMapping[]): LocationMapping[]` — conserva mapeos existentes cuyo `zoho_location_id` siga existiendo; empareja por nombre normalizado (minúsculas, sin acentos, trim); si hay exactamente 1 de cada lado, los vincula; el resto queda con `zoho_location_id: null`
  - `refreshLocationMappings(admin, store, conn | null): Promise<{ mappings: LocationMapping[]; tn_available: boolean; zoho_available: boolean }>` (persiste en `location_mappings`; borra locations que ya no existen en Tiendanube)
  - `loadLocationMappings(storeId: string): Promise<LocationMapping[]>`
  - Función `location-mappings` (body `{storeId, action: "get"|"refresh"|"save", mappings?}`) → `{ mappings, tn_available, zoho_available }`; `save` solo acepta `zoho_location_id` que exista en Zoho o `null`.

- [ ] **Step 1: Write failing tests**: `autoMatchLocations`: "Depósito Central" ↔ "Deposito central" (acentos); 1 TN + 1 Zoho con nombres distintos → vinculados; 2 TN + 1 Zoho con nombres distintos → ninguno vinculado; mapeo existente se conserva; mapeo cuyo Zoho id desapareció vuelve a `null`. `fetchTnLocations` con 403 → `null`, con 200 → ids string. `fetchZohoLocations` con 400 → `[]`.
- [ ] **Step 2: Run** `npx vitest run src/lib/locations.test.ts` → FAIL.
- [ ] **Step 3: Implement** módulo, función, rama `location/*` del worker (llama `refreshLocationMappings`, con `conn` solo si Zoho está activo) y `LocationMappingsCard` (una fila por location de Tiendanube con `Select` de locations de Zoho + "Sin vincular"; aviso si `!tn_available`: "Reautoriza la app para leer locations"; llama `refresh` al montar).
- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(multicd): mapeo de locations Tiendanube ↔ Zoho`

### Task 10: Scopes del token

**Files:**
- Modify: `server/functions/tiendanube-auth/index.ts`, `server/functions/catalog-resync/index.ts` (devuelve `missing_scopes`), `src/components/CatalogCard.tsx`
- Test: `src/lib/tiendanube-auth.test.ts` (ampliar)

**Interfaces:**
- Produces: `tiendanube-auth` guarda `tokenData.scope` en `stores.scopes` (insert y update); `catalog-resync` `status` devuelve `missing_scopes: string[]` = los de `["read_products","write_products","read_locations","read_fulfillment_orders"]` ausentes de `stores.scopes`; `CatalogCard` muestra aviso "Reautoriza la app para habilitar MultiCD" si no está vacío.

- [ ] **Step 1: Write failing tests**: instalación con `scope: "read_products,write_products"` guarda ese valor; `status` devuelve `missing_scopes: ["read_locations","read_fulfillment_orders"]`; con los 4 devuelve `[]`; `scopes` null → los 4 faltantes.
- [ ] **Step 2: Run** `npx vitest run src/lib/tiendanube-auth.test.ts src/lib/catalog-resync.test.ts` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(multicd): detectar scopes faltantes y pedir reautorización`

### Task 11: Stock por location

**Files:**
- Create: `server/functions/_shared/stock-plan.ts`
- Modify: `server/functions/sync-stock-run/index.ts`, `server/functions/_shared/tiendanube.ts` (eliminar `getTnDefaultLocationId`)
- Test: `src/lib/stock-plan.test.ts`, `src/lib/sync-stock-run.test.ts` (actualizar mocks)

**Interfaces:**
- Consumes: Tareas 4, 7 (caché y `catalog_not_ready`), 9 (`loadLocationMappings`, `fetchTnLocations`).
- Produces:
  - `interface ZohoStockItem { item_id: string; sku?: string; stock_on_hand?: number; actual_available_stock?: number; locations?: Array<{ location_id: string; location_stock_on_hand?: number | string }> }`
  - `interface StockChange { sku: string; zoho_item_id: string; product_id: number; variant_id: number; tn_location_id: string | null; zoho_location_id: string | null; from: number; to: number; target: "tn" | "zoho" }`
  - `planStockChanges(input: { zohoItems: ZohoStockItem[]; catalog: CatalogVariant[]; mappings: LocationMapping[]; tnLocationCount: number | null; direction: "zoho_to_tn" | "tn_to_zoho" | "bidirectional"; priority: "zoho" | "tiendanube" }): { changes: StockChange[]; unmatched: string[]; inSync: number; blocked: "locations_unmapped" | null }`
    - Si hay mapeos con `zoho_location_id`: un cambio por par (variante, location mapeada), comparando `location_stock_on_hand` de Zoho con `inventory_levels[tn_location_id].stock` (ausente = 0).
    - Si no hay mapeos vinculados y `tnLocationCount` es `null`, `0` o `1`: camino legado, un cambio por variante con `tn_location_id: null` y el stock total de Zoho.
    - Si no hay mapeos vinculados y `tnLocationCount >= 2`: `blocked: "locations_unmapped"`, sin cambios.
    - Bidireccional: gana `priority` por cada par; `to` nunca negativo.
  - `buildStockPatch(changes: StockChange[]): StockPriceProduct<{ id: number; inventory_levels: Array<{ location_id?: string; stock: number }> }>[]` (agrupa por producto y variante; omite `location_id` cuando es `null`).

- [ ] **Step 1: Write failing tests** `stock-plan.test.ts`: (a) una location legada → un cambio sin `location_id`; (b) dos locations mapeadas con stocks distintos → dos cambios con `location_id` explícito y `buildStockPatch` los junta en una sola variante con 2 `inventory_levels`; (c) 2 locations de Tiendanube sin mapeo → `blocked: "locations_unmapped"` y `changes: []`; (d) location sin mapear entre varias mapeadas no genera cambio; (e) bidireccional con `priority:"zoho"` → `target:"tn"`; con `"tiendanube"` → `target:"zoho"`; (f) SKU sin match → en `unmatched`; (g) stock igual → `inSync` suma. En `sync-stock-run.test.ts`: ya no hay GET `/products?`; el PATCH lleva `location_id` explícito; con `blocked` la respuesta incluye `blocked: "locations_unmapped"` y no hay PATCH; Zoho recibe ajustes con `location_id` en `line_items` cuando el cambio apunta a Zoho; `catalog_not_ready` → `skipped`.
- [ ] **Step 2: Run** `npx vitest run src/lib/stock-plan.test.ts src/lib/sync-stock-run.test.ts` → FAIL.
- [ ] **Step 3: Implement** `stock-plan.ts` y reescribir el cuerpo de `sync-stock-run`: lee la lista de Zoho (si las filas no traen `locations`, pedir `GET /inventory/v1/items/{id}` solo para los ítems con match, concurrencia 3), `loadCatalog`, `loadLocationMappings`, `fetchTnLocations` (para `tnLocationCount`), llama `planStockChanges`, ejecuta `buildStockPatch` + `chunkStockPriceBatch` y los ajustes de Zoho, y actualiza `stock_sync_state`/`product_sync_map` como hoy. Pasar `logRetryObserver` a `tnFetchWithRetry`. // ponytail: no se actualiza la caché tras el PATCH; el webhook `product/updated` resultante la refresca.
- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Verify en staging** con la org de Zoho multi-location y la tienda de prueba con 2 locations: correr un sync y confirmar en el historial de Tiendanube un solo `PATCH /products/stock-price` con ambos `location_id`; si la lista de ítems de Zoho no trae `locations`, confirmar que el fallback por ítem funciona.
- [ ] **Step 6: Commit** `feat(multicd): stock por location con inventory_levels`

### Task 11b: Location que recibe el stock total (hueco del plan, regla del controlador)

El diseño (sección B y "Decisiones tomadas por mí") exige que, con 2+ locations de Tiendanube y una org de Zoho sin locations, la UI pida mapear a mano la location que recibe el total. Ninguna tarea lo cubría: sin un `zoho_location_id` esas tiendas quedan bloqueadas para siempre.

**Files:** `server/functions/_shared/locations.ts`, `server/functions/_shared/stock-plan.ts`, `server/functions/location-mappings/index.ts`, `server/functions/sync-stock-run/index.ts`, `src/components/LocationMappingsCard.tsx`; tests en `src/lib/locations.test.ts`, `src/lib/stock-plan.test.ts`, `src/lib/location-mappings.test.ts`, `src/lib/sync-stock-run.test.ts`, `src/components/LocationMappingsCard.test.tsx`.

**Interfaces:** `export const ZOHO_TOTAL = "__total__"` en `locations.ts`; un mapeo con `zoho_location_id === ZOHO_TOTAL` significa "esta location de Tiendanube recibe el `stock_on_hand` total de Zoho". Como máximo una location de Tiendanube lo tiene y no puede convivir con vínculos a locations reales de Zoho. `sync-stock-run` devuelve `unmapped_locations: string[]` (ids de Tiendanube sin vincular cuando hay al menos un vínculo) y lo registra en `payload` del log final.

- [ ] Tests primero (rojo), implementar, tests en verde, commit `feat(multicd): location que recibe el stock total sin multi-almacén en Zoho`.

### Task 12: Alta de productos con MultiCD e imágenes separadas

**Files:**
- Modify: `server/functions/zoho-sync-import/index.ts` (`ZohoVariantData`, `loadZohoProduct`, `buildCreatePayload` línea ~437, `syncVariantsUpdate` ~460-500, flujo `create` ~130-175)
- Test: `src/lib/zoho-import.test.ts` (ampliar)

**Interfaces:**
- Consumes: `loadLocationMappings`, `fetchTnLocations` (Tarea 9).
- Produces: `ZohoVariantData.locations?: Array<{ location_id: string; stock: number }>`; creación: la variante lleva `inventory_levels` por location mapeada (stock del `location_id` de Zoho) o, en camino legado, `[{ stock: stock_on_hand }]`; con 2+ locations de Tiendanube sin mapear no se envía stock y el resultado del ítem incluye `message: "locations sin mapear"`. Se elimina todo `stock` / `stock_management` de `POST /products`, `PUT /products/{id}` y `PUT .../variants/{id}`. `syncVariantsUpdate` envía precio/stock por `PATCH /products/stock-price` usando `planStockChanges`-equivalente de una variante (reusar `buildStockPatch`). Imágenes: `POST /products` sin `images`; luego un `POST /products/{id}/images` por imagen.

- [ ] **Step 1: Write failing tests**: el body de `POST /products` no contiene `images` ni `stock` y las variantes llevan `inventory_levels`; tras crear, hay un `POST /products/{id}/images` por imagen con `{attachment, filename, position}`; el update no hace `PUT .../variants/{id}` con `stock`; con 2 locations sin mapear no hay `inventory_levels` y el resultado trae el mensaje.
- [ ] **Step 2: Run** `npx vitest run src/lib/zoho-import.test.ts` → FAIL.
- [ ] **Step 3: Implement**; fallo de una imagen se registra en `sync_logs` (no se traga con `.catch(() => {})`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(productos): inventory_levels por location e imágenes por /products/{id}/images`

### Task 13: Página y endpoint de estado

**Files:**
- Create: `server/status.ts`, `server/status-page.ts`
- Modify: `server/index.ts` (rutas `GET /api/status` y `GET /status`), `server/security-headers.ts` si el HTML inline requiere ajuste de CSP
- Test: `src/lib/status.test.ts`

**Interfaces:**
- Produces: `getStatus(pool = getPool()): Promise<{ status: "ok" | "degraded" | "down"; checked_at: string; database: "ok" | "down"; queue: { pending: number; oldest_pending_seconds: number; failed: number }; scheduler: { stock_last_success: string | null; prices_last_success: string | null }; stale_catalogs: number }>`; `degraded` si `oldest_pending_seconds > 600`, o `failed > 0`, o `stale_catalogs > 0`; `down` si falla la consulta a la base. `renderStatusPage(): string` (HTML autocontenido que consulta `/api/status` cada 30 s). Sin ids ni nombres de tienda.

- [ ] **Step 1: Write failing tests**: con pool falso: cola vacía → `ok`; evento pendiente de 700 s → `degraded`; `query` lanza → `down`; la respuesta serializada no contiene `store_id`.
- [ ] **Step 2: Run** `npx vitest run src/lib/status.test.ts` → FAIL.
- [ ] **Step 3: Implement** consultas agregadas sobre `webhook_events` (`processed=false`, `error_message IS NOT NULL`), `scheduled_sync_state` (`MAX(last_success_at)` por `operation`) y `stores` (`catalog_status='stale'`); rutas en `server/index.ts` sin autenticación (HTTP 200 siempre salvo `down` → 503).
- [ ] **Step 4: Run** → PASS; `npm run build:server`.
- [ ] **Step 5: Commit** `feat(status): endpoint y página pública de estado del servicio`

### Task 14: Prueba de carga y documentos de homologación

**Files:**
- Create: `scripts/loadtest/webhook-burst.mjs`, `scripts/loadtest/stub-tiendanube.mjs`, `docs/loadtest/report.md`, `docs/homologation/demo-script.md`, `docs/homologation/respuestas-tiendanube.md`
- Test: `src/lib/loadtest-sign.test.ts` (importa `signBody` del script)

**Interfaces:**
- Produces: `signBody(body: string, secret: string): string` (HMAC-SHA256 hex, mismo formato que `verifyWebhookSignature`); el script acepta `--url`, `--secret`, `--rps` (por defecto 50), `--duration` (por defecto 600 s), imprime p50/p95/p99, conteo de 5xx y el tiempo hasta drenar la cola (consultando `/api/status`); el stub responde `/products/{id}`, `/locations` y `PATCH /products/stock-price` con latencia fija para no depender del rate limit real.

- [ ] **Step 1: Write failing test**: `verifyWebhookSignature(Buffer.from(b), signBody(b, "s"), "s") === true` y con otro secreto `false`.
- [ ] **Step 2: Run** `npx vitest run src/lib/loadtest-sign.test.ts` → FAIL.
- [ ] **Step 3: Implement** los scripts (Node, sin dependencias nuevas; mezcla 80 % `product/updated`, 20 % `order/paid`) y escribir `demo-script.md` con un paso por ítem "No demostrado" que sí está cubierto (importar categorías/productos, exportar productos con `inventory_levels`, stock y precio ERP→TN, venta en TN actualiza stock, webhooks de producto, MultiCD con 2 locations, precio TN→ERP con la dirección invertida, resiliencia/429, `/status`), indicando qué request debe verse en el historial de Tiendanube; y `respuestas-tiendanube.md` con las 5 respuestas del documento de diseño más la evidencia (enlaces a `/status`, `docs/loadtest/report.md`).
- [ ] **Step 4: Run** el test → PASS.
- [ ] **Step 5: Run en staging** `node scripts/loadtest/webhook-burst.mjs --url <staging> --secret <secret>` y pegar el resultado en `docs/loadtest/report.md`. Aprobado si p95 < 500 ms, 0 respuestas 5xx y cola drenada en < 5 min; si no, anotar el cuello de botella en el informe.
- [ ] **Step 6: Commit** `docs(homologacion): prueba de carga, guion de demostración y respuestas`

### Task 15: Verificación final

**Files:** ninguno nuevo.

- [ ] **Step 1: Run** `npm run check` → typecheck, lint, tests y build en verde.
- [ ] **Step 2: Verify no polling** `grep -rn "products?per_page" server` → solo aparece dentro de `tn-catalog.ts` (backfill); ninguna función de sync ni el scheduler.
- [ ] **Step 3: Verify en staging** (tienda de prueba con 2 locations, org Zoho multi-location): instalar/reautorizar → el backfill deja `catalog_status='ready'`; cambiar un producto en Tiendanube → llega `product/updated` y la caché cambia; correr un sync de stock y de precios → en el historial de Tiendanube no aparece ningún `GET /products` listado; mapear locations desde Configuración; invertir la dirección de precios y cambiar un precio en Tiendanube → Zoho se actualiza.
- [ ] **Step 4: Commit** de cualquier ajuste y abrir PR hacia `main`.

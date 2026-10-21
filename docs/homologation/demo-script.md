# Guion de demostración en video — homologación Tiendanube (ERP)

App ID 40863. Un paso por ítem del checklist "No demostrado" que **sí** está cubierto por esta entrega, en el orden de las hojas del checklist. Cada paso indica qué mostrar en pantalla y qué request debe verse en el historial de requests de Tiendanube (Partners, panel de la app, historial de la tienda de prueba).

## Preparación (antes de grabar)

- Tienda de prueba de Tiendanube con **2 locations** (p. ej. "Principal" y "Depósito") y al menos 3 productos, uno con variantes, con imágenes y categorías.
- Organización de Zoho Inventory con **2 almacenes/locations** y los mismos SKU. Una segunda organización de Zoho **sin locations** para el paso 9.
- App instalada en staging con scopes `read_locations` y `read_fulfillment_orders` (el comerciante debe reautorizar si instaló antes de que se declararan).
- Abrir en una pestaña el historial de requests de Tiendanube y filtrar por la app; dejar visible la columna método + ruta + código.
- Tener a mano `/status` y la pantalla de Configuración de la app.

## Pasos

1. **Instalar y registrar webhooks.** Mostrar: instalación OAuth de la app en la tienda de prueba y, a continuación, el listado de webhooks registrados (`product/*`, `category/*`, `location/*`, `order/*`, `app/*`). Historial de Tiendanube: `POST /webhooks` (uno por evento) y luego `GET /webhooks` en reinstalaciones.

2. **Importar categorías y productos desde Tiendanube.** Mostrar: botón "Importar productos de Tiendanube" en la app; el aviso "catálogo en preparación" mientras corre el backfill; el catálogo ya cargado con categorías y variantes. Historial: `GET /products?per_page=...&fields=...` paginado, una sola vez (backfill inicial) y `GET /categories`; no debe haber repeticiones periódicas de `GET /products`.

3. **Exportar productos de Zoho a Tiendanube con `inventory_levels`.** Mostrar: producto nuevo en Zoho con stock en sus almacenes; ejecutar la exportación; el producto aparece en Tiendanube con el stock por location correcto. Historial: `POST /products` **sin** `images` y con variantes con `inventory_levels` por `location_id` (no `variant.stock`).

4. **Imágenes por separado.** Mostrar: el producto exportado en el paso 3 ahora con sus imágenes en Tiendanube. Historial: `POST /products/{id}/images` por cada imagen, después del `POST /products`.

5. **Stock y precio ERP → Tiendanube.** Mostrar: cambiar stock y precio de un SKU en Zoho, ejecutar la sincronización (o esperar el ciclo programado) y ver el valor nuevo en el admin de Tiendanube. Historial: `PATCH /products/stock-price` con hasta 50 variantes por request, `price` e `inventory_levels:[{location_id, stock}]`; ningún `PUT /products/{id}` con `variant.stock`.

6. **Una venta en Tiendanube actualiza el stock en Zoho** (con la dirección de stock que lo permite). Mostrar: configuración con dirección Tiendanube → Zoho (o bidireccional); hacer una compra de prueba y marcarla pagada; el stock del almacén en Zoho baja. Historial: webhook `order/paid` entregado (200) seguido de `GET /orders/{id}`.

7. **Los webhooks de producto mantienen la caché fresca sin polling.** Mostrar: editar en el admin de Tiendanube el precio/stock de un producto y ver, en pocos segundos, el cambio reflejado en el catálogo de la app sin pulsar nada. Historial: webhook `product/updated` entregado y **un solo** `GET /products/{id}?fields=id,variants`; explicar que no hay `GET /products` periódico (mostrar 6+ horas de historial sin él, o el historial del día).

8. **MultiCD: 2 locations de Tiendanube mapeadas a 2 locations de Zoho.** Mostrar: Configuración > Locations con las dos locations de la tienda autoasignadas por nombre a las dos de Zoho (editar una a mano para mostrar el selector); cambiar el stock de un SKU en cada almacén de Zoho y ver cada valor en su location de Tiendanube. Historial: `GET /locations` al instalar o al llegar `location/*`; `PATCH /products/stock-price` con **dos** entradas en `inventory_levels`, cada una con su `location_id`.

9. **Tienda con 2 locations y org de Zoho sin locations: opción "Stock total de Zoho".** Mostrar: conectar la org de Zoho sin locations; la app no envía stock hasta que el comerciante elige qué location recibe el total; elegir "Stock total de Zoho" para una location; el stock total aparece solo en esa. Historial: antes de elegir, ningún `PATCH /products/stock-price` con stock; después, `PATCH /products/stock-price` con `inventory_levels` de **una** location. Aclarar que la app nunca reparte ni adivina entre locations.

10. **Precio Tiendanube → Zoho con la dirección invertida.** Mostrar: en Configuración, cambiar "Dirección de precios" a Tiendanube → Zoho (el sync Zoho → Tiendanube de precios deja de correr); editar el precio de un producto en el admin de Tiendanube; el precio del ítem en Zoho cambia (match por SKU). Historial: webhook `product/updated` y `GET /products/{id}`; ningún `PATCH /products/stock-price` de precios en esa dirección.

11. **Resiliencia ante 429 y 5xx.** Mostrar: provocar un lote grande de actualizaciones (o forzar el caso con una tienda de prueba / el entorno de staging) y revelar en `sync_logs` el reintento: una respuesta 429 con `Retry-After` seguida de reintento exitoso, y un 5xx reintentado con backoff. Historial: respuesta `429` y la repetición del mismo request después de la espera; en métodos idempotentes también el reintento tras un `5xx`. Mostrar el evento `tn_retry_exhausted` solo si se logra provocar, y el correo de alerta.

12. **Página de estado `/status`.** Mostrar: abrir `https://<staging>/status` sin iniciar sesión: base de datos, atraso de la cola, eventos fallidos, último éxito del scheduler por operación y versión; verificar que no muestra datos de tiendas. Mostrar también `GET /api/status` (JSON). Historial de Tiendanube: no aplica (la página no llama a Tiendanube).

13. **Desinstalación y suspensión.** Mostrar: suspender la app desde el admin (y reactivarla) y luego desinstalarla; la app marca la tienda como suspendida/desinstalada y deja de sincronizar; los webhooks de la tienda se detienen. Historial: webhooks `app/suspended`, `app/resumed` y `app/uninstalled` entregados con respuesta 200.

## Ítems fuera de este video (fase 2)

Funcionalidades que **todavía no están cubiertas** por la app y que se responderán a Tiendanube como "no cubierto aún / fase 2" (no se graban en este video):

- Kit (producto compuesto).
- Producto de obsequio.
- Persona jurídica: importar `billing_customer_type`, `billing_business_name`, `billing_trade_name`, `billing_stats_registration` desde pedidos.
- Cancelar pedido ERP → Tiendanube, sin pago y con pago.
- Exportar categorías de Zoho a Tiendanube.

Los ítems de la hoja que el checklist marca como "Not Applied" (Draft Orders, creación de pedidos/clientes en Tiendanube, productos digitales) y el flujo de pedidos ya marcado "Completed" no se modifican y no se demuestran de nuevo.

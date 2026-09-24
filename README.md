# ZohoSync

Aplicación React/Vite con API Node.js y PostgreSQL para sincronizar Tiendanube
con Zoho Inventory. No requiere Supabase.

## Desarrollo local

Requiere Node.js 22 y PostgreSQL 15 o posterior.

```sh
cp .env.example .env
npm ci
npm run build
npm start
```

El servidor aplica automáticamente las migraciones de `server/migrations`,
expone la API en `/api/functions/v1/*`, sirve el frontend compilado y publica el
healthcheck en `/health`.

Variables obligatorias:

```env
DATABASE_URL=postgresql://usuario:password@host:5432/synczoho
APP_URL=https://app.example.com
APP_ORIGIN=https://app.example.com
VITE_TIENDANUBE_APP_ID=40863
TIENDANUBE_CLIENT_ID=40863
TIENDANUBE_CLIENT_SECRET=...
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
```

Variables adicionales para atender solicitudes de privacidad:
`RESEND_API_KEY`, `RESEND_FROM_EMAIL` y `PRIVACY_CONTACT_EMAIL` (un
buzón interno autorizado). Sin ellas, las solicitudes quedan pendientes y se
reintentan; no se confirman como atendidas. Otras variables opcionales:
`DATABASE_SSL`, `DB_POOL_SIZE` y `DISABLE_SCHEDULER`.
El worker de webhooks reserva una conexión para el bloqueo por tienda; el
pool usa al menos dos conexiones aunque `DB_POOL_SIZE` sea menor.

Los callbacks OAuth deben apuntar a:

- Tiendanube: `https://<dominio>/auth/callback`
- Zoho: `https://<dominio>/zoho/callback`

En el panel de Partners de Tiendanube, configura los tres webhooks
**obligatorios de privacidad** (no se registran mediante la API):

- URL webhook store redact: `https://<dominio>/api/functions/v1/privacy-store-redact`
- URL webhook customers redact: `https://<dominio>/api/functions/v1/privacy-customer-redact`
- URL webhook customers data request: `https://<dominio>/api/functions/v1/privacy-data-request`

El receptor verifica `x-linkedstore-hmac-sha256` contra el cuerpo original
antes de guardar el evento. El worker reintenta fallos desde PostgreSQL.
`store/redact` elimina los datos locales de la tienda. `customers/redact`
borra mapeos locales y crea una tarea en `privacy_requests` para revisar
manualmente los datos del cliente en Zoho. `customers/data_request` envía
un informe de los datos locales al correo del propietario obtenido de la
API de Tiendanube; si no puede verificarse, lo remite al buzón de privacidad como
tarea manual. Las tareas `pending_manual` **requieren seguimiento humano**;
recibir HTTP 200 no significa haber completado la solicitud legal. Para
solicitudes sin correo verificable, confirma el canal de entrega antes de
marcar la tarea como completada.

```sql
SELECT * FROM privacy_requests WHERE status = 'pending_manual' ORDER BY created_at;
SELECT id, event_type, error_message, attempts
FROM webhook_events WHERE processed = false ORDER BY created_at;
-- Solo después de resolver la solicitud con el comerciante/Zoho:
UPDATE privacy_requests SET status = 'completed', completed_at = now()
WHERE event_id = '<id-del-evento>' AND status = 'pending_manual';
```

## Verificación

```sh
npm run check
```

## Coolify

Despliega `docker-compose.yml` como recurso Docker Compose. Coolify detectará
las variables sin valor y generará `SERVICE_PASSWORD_POSTGRES`. Asigna el
dominio público al servicio `app` en el puerto `3000`, define `APP_URL` con ese
mismo origen HTTPS y configura los cuatro secretos OAuth antes del primer
despliegue.

El volumen `synczoho-postgres` conserva la base de datos entre despliegues.

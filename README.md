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

Variables opcionales: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `DATABASE_SSL`,
`DB_POOL_SIZE` y `DISABLE_SCHEDULER`.

Los callbacks OAuth deben apuntar a:

- Tiendanube: `https://<dominio>/auth/callback`
- Zoho: `https://<dominio>/zoho/callback`

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

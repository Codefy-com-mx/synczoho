# ZohoSync

Frontend React/Vite y Edge Functions de Supabase para sincronizar Tiendanube con Zoho Inventory.

## Desarrollo local

Requiere Node.js 22 y npm.

```sh
cp .env.example .env
npm ci
npm run dev
```

Variables públicas:

```env
VITE_SUPABASE_URL=https://supabase.example.com
VITE_SUPABASE_PUBLISHABLE_KEY=...
VITE_TIENDANUBE_APP_ID=40863
```

El callback de la aplicación Tiendanube debe ser `https://<dominio>/auth/callback`.

## Supabase

Las migraciones y funciones están en `supabase/` y funcionan tanto con Supabase administrado como self-hosted.

```sh
supabase db push --db-url "$DATABASE_URL"
supabase functions deploy
```

Configura también los secrets requeridos por las funciones (`TIENDANUBE_CLIENT_ID`, `TIENDANUBE_CLIENT_SECRET`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` y, para alertas, `RESEND_API_KEY`).

## Verificación

```sh
npm run check
```

## Coolify

Despliega este repositorio como aplicación Nixpacks con Node 22. Define las tres variables `VITE_*` del ejemplo, usa `npm run build` y publica `dist/` mediante el servidor estático de Coolify. Aplica las migraciones y despliega las Edge Functions antes de publicar una versión que dependa de cambios de esquema.

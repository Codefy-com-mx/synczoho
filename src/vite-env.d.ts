/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_TIENDANUBE_APP_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

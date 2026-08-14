/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_DEMO_ENDPOINT?: string;
  readonly PUBLIC_PHONE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

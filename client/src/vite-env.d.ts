/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_GOOGLE_ADS_CLIENT?: string;
  readonly VITE_GOOGLE_ADS_SLOT?: string;
  readonly VITE_GOOGLE_ADS_LAYOUT_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_DEMO_CONSENT_VERSION?: string;
  readonly PUBLIC_DEMO_SUBMISSION_ENABLED?: string;
  readonly PUBLIC_PERSONAL_DATA_CONSENT_PATH?: string;
  readonly PUBLIC_PHONE?: string;
  readonly PUBLIC_PRIVACY_POLICY_PATH?: string;
  readonly PUBLIC_SMARTCAPTCHA_CLIENT_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export const PLATFORM_TEST_ENV = {
  PLATFORM_AUTH_SECRET: "insecure-platform-test-placeholder-000",
  PLATFORM_AUTH_URL: "http://localhost:3001",
  SAAS_ADMIN_ORIGIN: "http://localhost:5473",
  KIOSK_ADMISSION_PROOF_SECRET: "insecure-kiosk-admission-proof-test-key",
} satisfies NodeJS.ProcessEnv;

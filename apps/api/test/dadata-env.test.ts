import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/env";
import { DadataConfig } from "../src/integrations/dadata/dadata.types";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

const productionEnv = {
  ...PLATFORM_TEST_ENV,
  NODE_ENV: "production",
  DATABASE_URL: "postgres://user:pass@localhost/db",
  BETTER_AUTH_SECRET: "insecure-test-placeholder",
  BETTER_AUTH_URL: "https://api.example.test",
  PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "587",
  SMTP_USER: "mailer",
  SMTP_PASSWORD: "secret",
  SMTP_FROM_EMAIL: "no-reply@example.test",
  SMTP_FROM_NAME: "Маркиро",
  MAIL_PAYLOAD_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  S3_ENDPOINT: "https://objects.example.test",
  S3_REGION: "ru-central1",
  S3_BUCKET: "markiro-private",
  S3_ACCESS_KEY_ID: "access-key",
  S3_SECRET_ACCESS_KEY: "secret-key",
  S3_FORCE_PATH_STYLE: "false",
} satisfies NodeJS.ProcessEnv;

describe("DaData environment", () => {
  it("boots production without DaData and treats blank credentials as unconfigured", () => {
    const unconfigured = loadEnv(productionEnv);
    expect(unconfigured.DADATA_TOKEN).toBeUndefined();
    expect(unconfigured.DADATA_SECRET).toBeUndefined();
    const blank = loadEnv({ ...productionEnv, DADATA_TOKEN: "", DADATA_SECRET: "" });
    expect(blank.DADATA_TOKEN).toBeUndefined();
    expect(blank.DADATA_SECRET).toBeUndefined();
  });

  it("rejects a secret without a token", () => {
    expect(() => loadEnv({ ...productionEnv, DADATA_SECRET: "provider-secret" })).toThrow();
  });

  it("does not serialize credentials through public configuration diagnostics", () => {
    const env = loadEnv({
      ...productionEnv,
      DADATA_TOKEN: "provider-token-must-not-leak",
      DADATA_SECRET: "provider-secret-must-not-leak",
    });
    const config = new DadataConfig(env.DADATA_TOKEN, env.DADATA_SECRET);
    expect(config.configured).toBe(true);
    expect(JSON.stringify(config)).toBe('{"configured":true}');
  });
});

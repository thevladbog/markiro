import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { loadChzTrueApiTokenFormat, loadEnv } from "../src/env";
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

describe("CHZ environment", () => {
  it("uses UUID tokens by default while retaining an explicit JWT rollback mode", () => {
    expect(loadEnv(productionEnv).CHZ_TRUE_API_TOKEN_FORMAT).toBe("uuid");
    expect(
      loadEnv({ ...productionEnv, CHZ_TRUE_API_TOKEN_FORMAT: "uuid" }).CHZ_TRUE_API_TOKEN_FORMAT,
    ).toBe("uuid");
    expect(() => loadEnv({ ...productionEnv, CHZ_TRUE_API_TOKEN_FORMAT: "opaque" })).toThrow();
    expect(loadChzTrueApiTokenFormat({})).toBe("uuid");
    expect(loadChzTrueApiTokenFormat({ CHZ_TRUE_API_TOKEN_FORMAT: "" })).toBe("uuid");
    expect(loadChzTrueApiTokenFormat({ CHZ_TRUE_API_TOKEN_FORMAT: "uuid" })).toBe("uuid");
    expect(loadChzTrueApiTokenFormat({ CHZ_TRUE_API_TOKEN_FORMAT: "jwt" })).toBe("jwt");
  });

  it("boots production without CHZ_TOKEN_ENCRYPTION_KEY and treats blank value as unconfigured", () => {
    const unconfigured = loadEnv(productionEnv);
    expect(unconfigured.CHZ_TOKEN_ENCRYPTION_KEY).toBeUndefined();
    const blank = loadEnv({ ...productionEnv, CHZ_TOKEN_ENCRYPTION_KEY: "" });
    expect(blank.CHZ_TOKEN_ENCRYPTION_KEY).toBeUndefined();
  });

  it("accepts a valid base64-encoded 32-byte encryption key", () => {
    const validKey = randomBytes(32).toString("base64");
    const env = loadEnv({ ...productionEnv, CHZ_TOKEN_ENCRYPTION_KEY: validKey });
    expect(env.CHZ_TOKEN_ENCRYPTION_KEY).toBeInstanceOf(Buffer);
    expect(env.CHZ_TOKEN_ENCRYPTION_KEY).toHaveLength(32);
  });

  it("rejects an invalid key length", () => {
    const invalidKey = randomBytes(16).toString("base64");
    expect(() => loadEnv({ ...productionEnv, CHZ_TOKEN_ENCRYPTION_KEY: invalidKey })).toThrow();
  });
});

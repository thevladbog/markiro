import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

const productionMailEnv = {
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
  S3_REGION: "us-east-1",
  S3_BUCKET: "markiro-private",
  S3_ACCESS_KEY_ID: "access-key",
  S3_SECRET_ACCESS_KEY: "secret-key",
  S3_FORCE_PATH_STYLE: "false",
} satisfies NodeJS.ProcessEnv;

describe("mail environment", () => {
  it("uses implicit TLS on port 465 when SMTP_SECURE is omitted", () => {
    const env = loadEnv({ ...productionMailEnv, SMTP_PORT: "465" });
    expect(env.SMTP_SECURE).toBe(true);
  });

  it("uses STARTTLS mode on port 587 when SMTP_SECURE is omitted", () => {
    const env = loadEnv(productionMailEnv);
    expect(env.SMTP_SECURE).toBe(false);
  });

  it("parses an explicit false instead of coercing it to true", () => {
    const env = loadEnv({ ...productionMailEnv, SMTP_SECURE: "false" });
    expect(env.SMTP_SECURE).toBe(false);
  });

  it("rejects disabling implicit TLS on standard port 465", () => {
    expect(() =>
      loadEnv({ ...productionMailEnv, SMTP_PORT: "465", SMTP_SECURE: "false" }),
    ).toThrow();
  });

  it("rejects implicit TLS on standard STARTTLS port 587", () => {
    expect(() => loadEnv({ ...productionMailEnv, SMTP_SECURE: "true" })).toThrow();
  });

  it.each([
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM_EMAIL",
    "SMTP_FROM_NAME",
    "MAIL_PAYLOAD_ENCRYPTION_KEY",
  ] as const)("requires %s in production", (name) => {
    const source = { ...productionMailEnv };
    delete source[name];
    expect(() => loadEnv(source)).toThrow();
  });

  it("requires a canonical base64 32-byte payload key", () => {
    expect(() =>
      loadEnv({ ...productionMailEnv, MAIL_PAYLOAD_ENCRYPTION_KEY: "not-a-key" }),
    ).toThrow();
  });

  it("defaults development to local Mailpit without SMTP authentication", () => {
    const env = loadEnv({
      ...PLATFORM_TEST_ENV,
      DATABASE_URL: "postgres://user:pass@localhost/db",
      BETTER_AUTH_SECRET: "insecure-test-placeholder",
      BETTER_AUTH_URL: "http://localhost:3000",
      PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
    } as NodeJS.ProcessEnv);
    expect(env.SMTP_HOST).toBe("localhost");
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.SMTP_USER).toBeUndefined();
    expect(env.SMTP_PASSWORD).toBeUndefined();
    expect(env.MAIL_PAYLOAD_ENCRYPTION_KEY).toHaveLength(32);
  });

  it("treats blank development mail variables as unset and keeps Mailpit defaults", () => {
    const env = loadEnv({
      ...PLATFORM_TEST_ENV,
      DATABASE_URL: "postgres://user:pass@localhost/db",
      BETTER_AUTH_SECRET: "insecure-test-placeholder",
      BETTER_AUTH_URL: "http://localhost:3000",
      PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
      SMTP_HOST: "",
      SMTP_PORT: "",
      SMTP_FROM_EMAIL: "",
      SMTP_FROM_NAME: "",
    } as NodeJS.ProcessEnv);

    expect(env).toMatchObject({
      SMTP_HOST: "localhost",
      SMTP_PORT: 1025,
      SMTP_FROM_EMAIL: "no-reply@markiro.local",
      SMTP_FROM_NAME: "Маркиро",
    });
  });
});

describe("landing demo environment", () => {
  it("keeps demo submissions disabled with bounded limiter defaults", () => {
    expect(loadEnv(productionMailEnv)).toMatchObject({
      LANDING_DEMO_SUBMISSION_ENABLED: false,
      LANDING_DEMO_RATE_WINDOW_SECONDS: 900,
      LANDING_DEMO_SOURCE_LIMIT: 5,
      LANDING_DEMO_GLOBAL_LIMIT: 100,
    });
  });

  it("requires every delivery setting only when demo submissions are enabled", () => {
    let thrown: unknown;
    try {
      loadEnv({
        ...productionMailEnv,
        LANDING_DEMO_SUBMISSION_ENABLED: "true",
      });
    } catch (error) {
      thrown = error;
    }
    const message = String(thrown);
    for (const name of [
      "LANDING_ORIGIN",
      "LANDING_DEMO_RECIPIENT",
      "LANDING_DEMO_REPLY_TO",
      "LANDING_DEMO_CONSENT_VERSION",
      "SMARTCAPTCHA_SERVER_KEY",
    ]) {
      expect(message).toContain(name);
    }

    expect(
      loadEnv({
        ...productionMailEnv,
        LANDING_DEMO_SUBMISSION_ENABLED: "true",
        LANDING_ORIGIN: "https://markiro.app",
        LANDING_DEMO_RECIPIENT: "hello@v-b.tech",
        LANDING_DEMO_REPLY_TO: "hello@v-b.tech",
        LANDING_DEMO_CONSENT_VERSION: "2026-08-14",
        SMARTCAPTCHA_SERVER_KEY: "ysc2_test-secret",
      }),
    ).toMatchObject({ LANDING_DEMO_SUBMISSION_ENABLED: true });
  });

  it.each([
    ["LANDING_ORIGIN", "https://markiro.app/demo"],
    ["LANDING_DEMO_RECIPIENT", "not-an-email"],
    ["LANDING_DEMO_REPLY_TO", "not-an-email"],
    ["LANDING_DEMO_CONSENT_VERSION", "   "],
    ["SMARTCAPTCHA_SERVER_KEY", "test-secret-without-prefix"],
  ] as const)("rejects invalid %s without echoing its value", (name, value) => {
    const source = {
      ...productionMailEnv,
      LANDING_DEMO_SUBMISSION_ENABLED: "true",
      LANDING_ORIGIN: "https://markiro.app",
      LANDING_DEMO_RECIPIENT: "hello@v-b.tech",
      LANDING_DEMO_REPLY_TO: "hello@v-b.tech",
      LANDING_DEMO_CONSENT_VERSION: "2026-08-14",
      SMARTCAPTCHA_SERVER_KEY: "ysc2_test-secret",
      [name]: value,
    };

    let thrown: unknown;
    try {
      loadEnv(source);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const message = String(thrown);
    expect(message).toContain(name);
    if (value.trim()) expect(message).not.toContain(value);
  });

  it.each([
    ["LANDING_DEMO_RATE_WINDOW_SECONDS", "59"],
    ["LANDING_DEMO_RATE_WINDOW_SECONDS", "3601"],
    ["LANDING_DEMO_SOURCE_LIMIT", "0"],
    ["LANDING_DEMO_SOURCE_LIMIT", "101"],
    ["LANDING_DEMO_GLOBAL_LIMIT", "0"],
    ["LANDING_DEMO_GLOBAL_LIMIT", "10001"],
  ] as const)("rejects an out-of-range %s", (name, value) => {
    expect(() => loadEnv({ ...productionMailEnv, [name]: value })).toThrow(new RegExp(name));
  });

  it("requires the global limiter budget to cover at least one source budget", () => {
    expect(() =>
      loadEnv({
        ...productionMailEnv,
        LANDING_DEMO_SOURCE_LIMIT: "6",
        LANDING_DEMO_GLOBAL_LIMIT: "5",
      }),
    ).toThrow(/LANDING_DEMO_GLOBAL_LIMIT/);
  });

  it("treats blank disabled feature settings as unset", () => {
    expect(
      loadEnv({
        ...productionMailEnv,
        LANDING_DEMO_SUBMISSION_ENABLED: "",
        LANDING_ORIGIN: "",
        LANDING_DEMO_RECIPIENT: "",
        LANDING_DEMO_REPLY_TO: "",
        LANDING_DEMO_CONSENT_VERSION: "",
        SMARTCAPTCHA_SERVER_KEY: "",
        LANDING_DEMO_RATE_WINDOW_SECONDS: "",
        LANDING_DEMO_SOURCE_LIMIT: "",
        LANDING_DEMO_GLOBAL_LIMIT: "",
      }),
    ).toMatchObject({
      LANDING_DEMO_SUBMISSION_ENABLED: false,
      LANDING_DEMO_RATE_WINDOW_SECONDS: 900,
      LANDING_DEMO_SOURCE_LIMIT: 5,
      LANDING_DEMO_GLOBAL_LIMIT: 100,
    });
  });
});

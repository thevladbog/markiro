import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

const base = {
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

describe("object storage environment", () => {
  it("parses a private S3-compatible production configuration", () => {
    expect(loadEnv(base)).toMatchObject({
      S3_ENDPOINT: "https://objects.example.test/",
      S3_REGION: "ru-central1",
      S3_BUCKET: "markiro-private",
      S3_FORCE_PATH_STYLE: false,
    });
  });

  it.each([
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ] as const)("requires %s in production", (name) => {
    const source = { ...base };
    delete source[name];
    expect(() => loadEnv(source)).toThrow();
  });

  it("rejects non-http storage endpoints", () => {
    expect(() => loadEnv({ ...base, S3_ENDPOINT: "file:///tmp/objects" })).toThrow();
  });

  it("defaults development to private path-style MinIO", () => {
    const env = loadEnv({
      ...PLATFORM_TEST_ENV,
      DATABASE_URL: "postgres://user:pass@localhost/db",
      BETTER_AUTH_SECRET: "insecure-test-placeholder",
      BETTER_AUTH_URL: "http://localhost:3000",
      PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
    } as NodeJS.ProcessEnv);
    expect(env).toMatchObject({
      S3_ENDPOINT: "http://localhost:9000/",
      S3_REGION: "us-east-1",
      S3_BUCKET: "markiro-private",
      S3_FORCE_PATH_STYLE: true,
    });
  });

  it("treats blank development storage variables as unset and keeps MinIO defaults", () => {
    const env = loadEnv({
      ...PLATFORM_TEST_ENV,
      DATABASE_URL: "postgres://user:pass@localhost/db",
      BETTER_AUTH_SECRET: "insecure-test-placeholder",
      BETTER_AUTH_URL: "http://localhost:3000",
      PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
      S3_ENDPOINT: "",
      S3_REGION: "",
      S3_BUCKET: "",
      S3_ACCESS_KEY_ID: "",
      S3_SECRET_ACCESS_KEY: "",
      S3_FORCE_PATH_STYLE: "",
    } as NodeJS.ProcessEnv);

    expect(env).toMatchObject({
      S3_ENDPOINT: "http://localhost:9000/",
      S3_REGION: "us-east-1",
      S3_BUCKET: "markiro-private",
      S3_ACCESS_KEY_ID: "markiro",
      S3_FORCE_PATH_STYLE: true,
    });
  });
});

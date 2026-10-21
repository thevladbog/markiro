import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

const base = {
  ...PLATFORM_TEST_ENV,
  NODE_ENV: "test",
  SERVER_PROFILE: "platform-only",
  DATABASE_URL: "postgres://user:pass@localhost/db",
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "1025",
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

const TOKEN = "42:not-a-real-telegram-bot-token";

describe("landing lead environment (spec 2026-10-20 §15.4)", () => {
  it("keeps Telegram off and twelve months of retention by default", () => {
    const env = loadEnv(base);
    expect(env.LEAD_TELEGRAM_ENABLED).toBe(false);
    expect(env.LEAD_TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.LEAD_RETENTION_MONTHS).toBe(12);
  });

  it("requires the token and the chat once alerts are switched on", () => {
    expect(() => loadEnv({ ...base, LEAD_TELEGRAM_ENABLED: "true" })).toThrow(
      /LEAD_TELEGRAM_BOT_TOKEN[\s\S]*LEAD_TELEGRAM_CHAT_ID/,
    );
    const env = loadEnv({
      ...base,
      LEAD_TELEGRAM_ENABLED: "true",
      LEAD_TELEGRAM_BOT_TOKEN: TOKEN,
      LEAD_TELEGRAM_CHAT_ID: "-1001234567890",
    });
    expect(env.LEAD_TELEGRAM_ENABLED).toBe(true);
    expect(
      loadEnv({ ...base, LEAD_TELEGRAM_CHAT_ID: "@markiro_leads" }).LEAD_TELEGRAM_CHAT_ID,
    ).toBe("@markiro_leads");
  });

  it("rejects malformed secrets, a non-boolean flag and out-of-range retention", () => {
    for (const overrides of [
      { LEAD_TELEGRAM_ENABLED: "yes" },
      { LEAD_TELEGRAM_BOT_TOKEN: "not-a-token" },
      { LEAD_TELEGRAM_CHAT_ID: "chat" },
      { LEAD_RETENTION_MONTHS: "0" },
      { LEAD_RETENTION_MONTHS: "61" },
    ]) {
      expect(() => loadEnv({ ...base, ...overrides })).toThrow();
    }
  });
});

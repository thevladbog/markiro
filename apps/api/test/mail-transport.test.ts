import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env";
import { buildMessageOptions, buildSmtpOptions } from "../src/modules/mail/mail-transport.service";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

const baseEnv = {
  ...PLATFORM_TEST_ENV,
  DATABASE_URL: "postgres://user:pass@localhost/db",
  BETTER_AUTH_SECRET: "insecure-test-placeholder",
  BETTER_AUTH_URL: "http://localhost:3000",
  PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
  S3_ENDPOINT: "https://objects.example.test",
  S3_REGION: "us-east-1",
  S3_BUCKET: "markiro-private",
  S3_ACCESS_KEY_ID: "access-key",
  S3_SECRET_ACCESS_KEY: "secret-key",
  S3_FORCE_PATH_STYLE: "false",
} satisfies NodeJS.ProcessEnv;

describe("buildSmtpOptions", () => {
  it("uses plain loopback SMTP with no auth for default Mailpit", () => {
    const options = buildSmtpOptions(loadEnv(baseEnv));
    expect(options).toMatchObject({
      host: "localhost",
      port: 1025,
      secure: false,
      requireTLS: false,
      tls: { rejectUnauthorized: true },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    expect(options).not.toHaveProperty("auth");
  });

  it("requires STARTTLS with certificate verification for production port 587", () => {
    const options = buildSmtpOptions(
      loadEnv({
        ...baseEnv,
        NODE_ENV: "production",
        SMTP_HOST: "smtp.example.test",
        SMTP_PORT: "587",
        SMTP_USER: "mailer",
        SMTP_PASSWORD: "secret",
        SMTP_FROM_EMAIL: "no-reply@example.test",
        SMTP_FROM_NAME: "Маркиро",
        MAIL_PAYLOAD_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      }),
    );
    expect(options).toMatchObject({
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: true },
    });
  });

  it("passes production mailbox credentials only to the SMTP auth option", () => {
    const options = buildSmtpOptions(
      loadEnv({
        ...baseEnv,
        NODE_ENV: "production",
        SMTP_HOST: "smtp.example.test",
        SMTP_PORT: "465",
        SMTP_USER: "mailer",
        SMTP_PASSWORD: "secret",
        SMTP_FROM_EMAIL: "no-reply@example.test",
        SMTP_FROM_NAME: "Маркиро",
        MAIL_PAYLOAD_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      }),
    );
    expect(options).toMatchObject({
      secure: true,
      requireTLS: false,
      auth: { user: "mailer", pass: "secret" },
    });
  });
});

describe("buildMessageOptions", () => {
  const rendered = {
    subject: "subject",
    html: "<p>body</p>",
    text: "body",
  };
  const envWithGlobalReplyTo = loadEnv({
    ...baseEnv,
    SMTP_REPLY_TO: "support@example.test",
  });

  it("prefers the message Reply-To over the global fallback", () => {
    expect(
      buildMessageOptions(
        envWithGlobalReplyTo,
        { ...rendered, replyTo: "lead@example.test" },
        "hello@v-b.tech",
      ),
    ).toMatchObject({
      from: {
        name: envWithGlobalReplyTo.SMTP_FROM_NAME,
        address: envWithGlobalReplyTo.SMTP_FROM_EMAIL,
      },
      to: "hello@v-b.tech",
      replyTo: "lead@example.test",
      subject: "subject",
      html: "<p>body</p>",
      text: "body",
    });
  });

  it("uses the global Reply-To when the rendered message has none", () => {
    expect(buildMessageOptions(envWithGlobalReplyTo, rendered, "user@example.test")).toMatchObject({
      to: "user@example.test",
      replyTo: "support@example.test",
    });
  });
});

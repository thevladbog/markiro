import { describe, expect, it, vi } from "vitest";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { loadEnv } from "../src/env";
import {
  createS3Client,
  ObjectStorageService,
} from "../src/modules/storage/object-storage.service";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

const env = loadEnv({
  ...PLATFORM_TEST_ENV,
  DATABASE_URL: "postgres://user:pass@localhost/db",
  BETTER_AUTH_SECRET: "insecure-test-placeholder",
  BETTER_AUTH_URL: "http://localhost:3000",
  PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
} as NodeJS.ProcessEnv);

describe("ObjectStorageService", () => {
  it("bounds S3 retries and uses the timeout-aware Node HTTP handler", async () => {
    const client = createS3Client(env);
    try {
      expect(await client.config.maxAttempts()).toBe(3);
      expect(client.config.requestHandler).toBeInstanceOf(NodeHttpHandler);
    } finally {
      client.destroy();
    }
  });

  it("keeps the bucket private and server-generated keys opaque", async () => {
    const send = vi.fn().mockResolvedValue({});
    const storage = new ObjectStorageService(env, { send } as never, async () => "signed-read");

    await storage.put("users/u/avatars/a.webp", Buffer.from("image"), "image/webp");
    const command = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      Bucket: "markiro-private",
      Key: "users/u/avatars/a.webp",
      ContentType: "image/webp",
      Body: Buffer.from("image"),
    });
    expect(command.input).not.toHaveProperty("ACL");
  });

  it("caps signed reads at five minutes", async () => {
    const presign = vi.fn().mockResolvedValue("signed-read");
    const storage = new ObjectStorageService(env, { send: vi.fn() } as never, presign);

    await expect(storage.presignRead("users/u/avatars/a.webp", 301)).rejects.toThrow();
    await expect(storage.presignRead("users/u/avatars/a.webp", 300)).resolves.toBe("signed-read");
    expect(presign).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: 300 });
    expect(presign).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe object keys before calling S3", async () => {
    const send = vi.fn();
    const storage = new ObjectStorageService(env, { send } as never);
    await expect(storage.delete("../other-tenant/avatar.webp")).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("treats a concurrent bucket-creation winner as success in development", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "NotFound" }))
      .mockRejectedValueOnce(
        Object.assign(new Error("created concurrently"), { name: "BucketAlreadyOwnedByYou" }),
      );
    const storage = new ObjectStorageService(env, { send } as never);

    await expect(storage.ensureBucket()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]?.constructor.name).toBe("CreateBucketCommand");
  });

  it("requires production buckets to be provisioned instead of creating them", async () => {
    const productionEnv = loadEnv({
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
    } satisfies NodeJS.ProcessEnv);
    const missing = Object.assign(new Error("missing"), { name: "NotFound" });
    const send = vi.fn().mockRejectedValue(missing);
    const storage = new ObjectStorageService(productionEnv, { send } as never);

    await expect(storage.ensureBucket()).rejects.toBe(missing);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

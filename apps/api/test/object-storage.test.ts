import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "../src/env";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";

const env = loadEnv({
  DATABASE_URL: "postgres://user:pass@localhost/db",
  BETTER_AUTH_SECRET: "insecure-test-placeholder",
  BETTER_AUTH_URL: "http://localhost:3000",
  PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
} as NodeJS.ProcessEnv);

describe("ObjectStorageService", () => {
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
  });

  it("rejects unsafe object keys before calling S3", async () => {
    const send = vi.fn();
    const storage = new ObjectStorageService(env, { send } as never);
    await expect(storage.delete("../other-tenant/avatar.webp")).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";

const key = Buffer.alloc(32, 7);

describe("MailCryptoService", () => {
  it("encrypts template data and round-trips it with delivery-id AAD", () => {
    const crypto = new MailCryptoService(key);
    const payload = {
      kind: "password-reset",
      actionUrl: "https://cabinet.example/reset/secret-token",
      recipientName: "Ирина",
      expiresInMinutes: 30,
    };

    const encrypted = crypto.encrypt("delivery-1", payload);
    expect(encrypted.encryptedPayload.includes(Buffer.from(payload.actionUrl))).toBe(false);
    expect(crypto.decrypt("delivery-1", encrypted)).toEqual(payload);
  });

  it("rejects ciphertext under another delivery id", () => {
    const crypto = new MailCryptoService(key);
    const encrypted = crypto.encrypt("delivery-1", { actionUrl: "https://example.test/token" });
    expect(() => crypto.decrypt("delivery-2", encrypted)).toThrow();
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => new MailCryptoService(Buffer.alloc(31))).toThrow();
  });
});

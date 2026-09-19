import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";

describe("ChzCryptoService", () => {
  const key = randomBytes(32);

  it("round-trips a token", () => {
    const svc = new ChzCryptoService(key);
    const payload = svc.encrypt("tenant-1", "jwt-token-value");
    expect(svc.decrypt("tenant-1", payload)).toBe("jwt-token-value");
  });

  it("binds ciphertext to the tenant via AAD", () => {
    const svc = new ChzCryptoService(key);
    const payload = svc.encrypt("tenant-1", "jwt-token-value");
    expect(() => svc.decrypt("tenant-2", payload)).toThrow();
  });

  it("rejects a key of the wrong length", () => {
    expect(() => new ChzCryptoService(randomBytes(16))).toThrow(/32 bytes/);
  });

  it("throws a clear error when the key is not configured", () => {
    const svc = new ChzCryptoService(undefined);
    expect(() => svc.encrypt("t", "x")).toThrow(/CHZ_TOKEN_ENCRYPTION_KEY/);
  });

  it("binds a ciphertext to its AAD", () => {
    const service = new ChzCryptoService(Buffer.alloc(32, 7));
    const sealed = service.encryptWithAad("t/o/1", "010460703469001421AbC\u001d93dGVz");
    expect(service.decryptWithAad("t/o/1", sealed)).toBe("010460703469001421AbC\u001d93dGVz");
    expect(() => service.decryptWithAad("t/o/2", sealed)).toThrow();
  });
});

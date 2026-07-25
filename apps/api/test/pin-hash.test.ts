import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashSecret, verifySecret } from "../src/lib/pin-hash";

describe("pin-hash (PBKDF2 PHC, station-compatible)", () => {
  // The SAME vector as apps/station/test/crypto.test.ts — this is the
  // executable interop contract between the two implementations.
  it("verifies the station's known vector", async () => {
    const salt = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    const derived = pbkdf2Sync("1234", salt, 100000, 32, "sha256");
    const phc = `pbkdf2$sha256$100000$${salt.toString("base64")}$${derived.toString("base64")}`;
    expect(await verifySecret("1234", phc)).toBe(true);
    expect(await verifySecret("0000", phc)).toBe(false);
  });

  it("produces a PHC string the station's format accepts", async () => {
    const phc = await hashSecret("735519");
    const parts = phc.split("$");
    expect(parts[0]).toBe("pbkdf2");
    expect(parts[1]).toBe("sha256");
    expect(parts[2]).toBe("100000");
    // 16-byte salt and 32-byte key, standard base64 WITH padding.
    expect(Buffer.from(parts[3]!, "base64")).toHaveLength(16);
    expect(Buffer.from(parts[4]!, "base64")).toHaveLength(32);
    expect(phc.endsWith("=")).toBe(true);
    expect(await verifySecret("735519", phc)).toBe(true);
    expect(await verifySecret("000000", phc)).toBe(false);
  });

  it("rejects malformed PHC strings without throwing", async () => {
    expect(await verifySecret("1234", "not-a-phc")).toBe(false);
    expect(await verifySecret("1234", "argon2$x$y$z$w")).toBe(false);
  });

  it("rejects an iteration count below the 10000 floor", async () => {
    const salt = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    const derived = pbkdf2Sync("1234", salt, 1, 32, "sha256");
    const phc = `pbkdf2$sha256$1$${salt.toString("base64")}$${derived.toString("base64")}`;
    expect(await verifySecret("1234", phc)).toBe(false);
  });

  it("rejects a PHC whose hash field decodes to fewer than 32 bytes, even for the correct secret", async () => {
    const salt = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    const derived = pbkdf2Sync("1234", salt, 100000, 4, "sha256");
    const phc = `pbkdf2$sha256$100000$${salt.toString("base64")}$${derived.toString("base64")}`;
    expect(await verifySecret("1234", phc)).toBe(false);
  });

  it("rejects a PHC whose hash field decodes to more than 32 bytes, even for the correct secret", async () => {
    const salt = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    const derived = pbkdf2Sync("1234", salt, 100000, 64, "sha256");
    const phc = `pbkdf2$sha256$100000$${salt.toString("base64")}$${derived.toString("base64")}`;
    expect(await verifySecret("1234", phc)).toBe(false);
  });

  it("rejects a non-canonical base64 salt field, even for the correct secret (C2)", async () => {
    const salt = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    const derived = pbkdf2Sync("1234", salt, 100000, 32, "sha256");
    // Buffer.from(x, "base64") silently drops the trailing "!" and still
    // decodes 16 bytes -- but this string is not the canonical encoding of
    // those bytes, so it must be rejected rather than accepted as-if clean.
    const nonCanonicalSalt = `${salt.toString("base64")}!`;
    const phc = `pbkdf2$sha256$100000$${nonCanonicalSalt}$${derived.toString("base64")}`;
    expect(await verifySecret("1234", phc)).toBe(false);
  });

  it("rejects a non-canonical base64 hash field, even for the correct secret (C2)", async () => {
    const salt = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    const derived = pbkdf2Sync("1234", salt, 100000, 32, "sha256");
    const nonCanonicalHash = `${derived.toString("base64")}!`;
    const phc = `pbkdf2$sha256$100000$${salt.toString("base64")}$${nonCanonicalHash}`;
    expect(await verifySecret("1234", phc)).toBe(false);
  });

  it("rejects a wrong-length (8-byte) salt, even for the correct secret (C2)", async () => {
    const shortSalt = Buffer.from(Array.from({ length: 8 }, (_, i) => i));
    const derived = pbkdf2Sync("1234", shortSalt, 100000, 32, "sha256");
    const phc = `pbkdf2$sha256$100000$${shortSalt.toString("base64")}$${derived.toString("base64")}`;
    expect(await verifySecret("1234", phc)).toBe(false);
  });
});

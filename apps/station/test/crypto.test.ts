import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashSecret, verifyPin, verifyBadge } from "../src/lib/crypto.js";

describe("crypto (PBKDF2 PHC)", () => {
  it("verifies a known vector cross-checked against node:crypto", async () => {
    const salt = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i));
    const derived = pbkdf2Sync("1234", Buffer.from(salt), 100000, 32, "sha256");
    const phc = `pbkdf2$sha256$100000$${Buffer.from(salt).toString("base64")}$${derived.toString("base64")}`;
    expect(await verifyPin("1234", phc)).toBe(true);
    expect(await verifyPin("0000", phc)).toBe(false);
  });

  it("round-trips a freshly hashed secret", async () => {
    const phc = await hashSecret("735519");
    expect(phc.startsWith("pbkdf2$sha256$")).toBe(true);
    expect(await verifyBadge("735519", phc)).toBe(true);
    expect(await verifyBadge("000000", phc)).toBe(false);
  });

  it("rejects malformed PHC strings without throwing", async () => {
    expect(await verifyPin("1234", "not-a-phc")).toBe(false);
    expect(await verifyPin("1234", "argon2$x$y$z$w")).toBe(false);
  });

  it("rejects a downgraded iteration count below the floor, even with an otherwise-correct hash (regression for M11)", async () => {
    const salt = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i));
    const iterations = 1; // far below the 10000-iteration floor
    const derived = pbkdf2Sync("1234", Buffer.from(salt), iterations, 32, "sha256");
    const phc = `pbkdf2$sha256$${iterations}$${Buffer.from(salt).toString("base64")}$${derived.toString("base64")}`;
    expect(await verifyPin("1234", phc)).toBe(false);
  });
});

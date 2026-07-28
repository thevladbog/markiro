import { describe, expect, it } from "vitest";
import {
  deriveDigestB64,
  formatPhc,
  parsePhc,
  PHC_ITERATIONS,
  verifyPhc,
} from "../src/crypto/phc.js";
import { hashSecret as stationHash } from "../../../apps/station/src/lib/crypto.js";

// A structurally valid 16-byte salt, borrowed from the station's DUMMY_PHC
// constant (apps/station/src/lib/auth.ts). Its plaintext is deliberately
// unknown — DUMMY_PHC exists only to equalise verification timing — so use
// this value ONLY for structural assertions, never to assert that some
// particular secret verifies against it.
const KNOWN_SALT_B64 = "fwGrIt01vwgBxxDlhqLVRQ==";

describe("parsePhc", () => {
  it("splits a well-formed verifier into its fields", () => {
    const phc = `pbkdf2$sha256$100000$${KNOWN_SALT_B64}$PGnhdQA2lW09CcvuOhCmvp0z4HbztWXaYIq7+dqmLoQ=`;
    expect(parsePhc(phc)).toEqual({
      iterations: 100000,
      saltB64: KNOWN_SALT_B64,
      digestB64: "PGnhdQA2lW09CcvuOhCmvp0z4HbztWXaYIq7+dqmLoQ=",
    });
  });

  it("rejects a malformed, foreign or downgraded verifier", () => {
    expect(parsePhc("nope")).toBeNull();
    expect(parsePhc("pbkdf2$sha512$100000$AA==$AA==")).toBeNull();
    expect(parsePhc(`argon2$sha256$100000$${KNOWN_SALT_B64}$AA==`)).toBeNull();
    // below MIN_ITERATIONS: a tampered bundle must not cheapen the derivation
    expect(parsePhc(`pbkdf2$sha256$1000$${KNOWN_SALT_B64}$AA==`)).toBeNull();
    // non-canonical base64 must not slip through
    expect(parsePhc(`pbkdf2$sha256$100000$${KNOWN_SALT_B64}$AA==!`)).toBeNull();
  });
});

describe("deriveDigestB64 / verifyPhc", () => {
  it("round-trips: a derived digest verifies against its own PHC string", async () => {
    const digest = await deriveDigestB64("BADGE-4412", KNOWN_SALT_B64, PHC_ITERATIONS);
    const phc = formatPhc(PHC_ITERATIONS, KNOWN_SALT_B64, digest);
    await expect(verifyPhc("BADGE-4412", phc)).resolves.toBe(true);
    await expect(verifyPhc("BADGE-9999", phc)).resolves.toBe(false);
  });

  it("is deterministic for the same secret and salt — this is what lets the kiosk derive once and look the result up in a map", async () => {
    const a = await deriveDigestB64("BADGE-4412", KNOWN_SALT_B64, PHC_ITERATIONS);
    const b = await deriveDigestB64("BADGE-4412", KNOWN_SALT_B64, PHC_ITERATIONS);
    expect(a).toBe(b);
  });

  it("returns false instead of throwing on a malformed verifier", async () => {
    await expect(verifyPhc("x", "not-a-phc-string")).resolves.toBe(false);
  });
});

describe("interop with the station verifier", () => {
  it("verifies a PHC string minted by apps/station/src/lib/crypto.ts", async () => {
    const phc = await stationHash("1234");
    await expect(verifyPhc("1234", phc)).resolves.toBe(true);
    await expect(verifyPhc("4321", phc)).resolves.toBe(false);
  });
});

import { pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);

/**
 * Server side of the operator credential-hash contract. MUST stay
 * byte-for-byte compatible with apps/station/src/lib/crypto.ts, which verifies
 * these strings offline: PHC `pbkdf2$sha256$<iter>$<saltB64>$<hashB64>`,
 * SHA-256, 100000 iterations, 32-byte key, 16-byte salt, standard base64 WITH
 * padding (a stock PHC encoder strips padding and breaks interop). The known
 * vector in test/pin-hash.test.ts is the executable spec.
 */
const ITERATIONS = 100_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** Verify floor: a foreign/tampered hash must not push the cost down. */
const MIN_ITERATIONS = 10_000;

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await pbkdf2Async(secret, salt, ITERATIONS, KEY_BYTES, "sha256");
  return `pbkdf2$sha256$${ITERATIONS}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifySecret(secret: string, phc: string): Promise<boolean> {
  const parts = phc.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS) return false;
  const salt = Buffer.from(parts[3]!, "base64");
  const expected = Buffer.from(parts[4]!, "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await pbkdf2Async(secret, salt, iterations, expected.length, "sha256");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

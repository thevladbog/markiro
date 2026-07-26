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

/**
 * Decodes a base64 field only if it is the CANONICAL encoding of its bytes
 * (re-encoding the decoded bytes reproduces the exact input string).
 * `Buffer.from(x, "base64")` is otherwise lenient — it silently drops
 * trailing garbage (e.g. `"AA==!"` decodes to a single zero byte) and
 * tolerates malformed padding — which would let a non-canonical PHC field
 * slip past a naive length check. Returns `null` for anything that doesn't
 * round-trip.
 */
function decodeCanonicalBase64(value: string): Buffer | null {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return null;
  return decoded;
}

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
  const salt = decodeCanonicalBase64(parts[3]!);
  const expected = decodeCanonicalBase64(parts[4]!);
  // Reject malformed/tampered hash fields up front: never derive a key whose
  // length is taken from untrusted input (that would let a truncated hash
  // "fail open" with far less entropy, and diverge from the station, which
  // always derives a fixed KEY_BITS = 256). The salt must also match the
  // fixed SALT_BYTES the contract mandates, not merely be non-empty.
  if (!salt || !expected) return false;
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
  const actual = await pbkdf2Async(secret, salt, iterations, KEY_BYTES, "sha256");
  return timingSafeEqual(actual, expected);
}

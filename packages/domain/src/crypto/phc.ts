/**
 * Shared PBKDF2/PHC verifier. Byte-compatible with the server
 * (`apps/api/src/lib/pin-hash.ts`) and the station
 * (`apps/station/src/lib/crypto.ts`): `pbkdf2$sha256$<iter>$<saltB64>$<hashB64>`,
 * SHA-256, 100000 iterations, 32-byte key, 16-byte salt, standard base64 WITH
 * padding. Uses WebCrypto, which exists both in browsers and in Node 24, so
 * this module stays dependency-free and runnable on a kiosk tablet.
 */
export const PHC_ITERATIONS = 100_000;
const KEY_BITS = 256;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** Verify floor: a foreign or tampered verifier must not cheapen the work. */
const MIN_ITERATIONS = 10_000;

export interface ParsedPhc {
  iterations: number;
  saltB64: string;
  digestB64: string;
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

/**
 * Decodes base64 only when the input is the CANONICAL encoding of its bytes.
 * `atob` is lenient about trailing garbage and padding, which would let a
 * non-canonical field past a naive length check.
 */
function decodeCanonical(value: string, expectedBytes: number): Uint8Array | null {
  let decoded: Uint8Array;
  try {
    decoded = fromB64(value);
  } catch {
    return null;
  }
  if (decoded.length !== expectedBytes) return null;
  if (toB64(decoded) !== value) return null;
  return decoded;
}

export function parsePhc(phc: string): ParsedPhc | null {
  const parts = phc.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return null;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS) return null;
  const saltB64 = parts[3]!;
  const digestB64 = parts[4]!;
  if (!decodeCanonical(saltB64, SALT_BYTES)) return null;
  if (!decodeCanonical(digestB64, KEY_BYTES)) return null;
  return { iterations, saltB64, digestB64 };
}

export function formatPhc(iterations: number, saltB64: string, digestB64: string): string {
  return `pbkdf2$sha256$${iterations}$${saltB64}$${digestB64}`;
}

/**
 * Whether `value` is the canonical base64 of a digest this module produces —
 * the same rule `parsePhc` applies to a verifier's last field, asked of a bare
 * digest.
 *
 * Lives here rather than in a caller because the encoding is `deriveDigestB64`'s
 * to define: the kiosk sends a digest over the wire (`CreateOrderDto.badgeDigest`)
 * and the server rebuilds a PHC string around it to look up, so the two ends
 * have to agree on the encoding down to the padding. A regex restated in a DTO
 * would be that agreement written twice.
 */
export function isCanonicalDigestB64(value: string): boolean {
  return decodeCanonical(value, KEY_BYTES) !== null;
}

export async function deriveDigestB64(
  secret: string,
  saltB64: string,
  iterations: number,
): Promise<string> {
  const salt = fromB64(saltB64);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    KEY_BITS,
  );
  return toB64(new Uint8Array(bits));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPhc(secret: string, phc: string): Promise<boolean> {
  const parsed = parsePhc(phc);
  if (!parsed) return false;
  const actual = await deriveDigestB64(secret, parsed.saltB64, parsed.iterations);
  return constantTimeEqual(actual, parsed.digestB64);
}

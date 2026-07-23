// Offline credential verifier. PHC format: pbkdf2$sha256$<iter>$<saltB64>$<hashB64>.
// Uses WebCrypto SubtleCrypto (present in the Tauri webview and in Node 24 as
// globalThis.crypto) — no native dependency.
const ITERATIONS = 100_000;
const KEY_BITS = 256;

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveBits(secret: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Computes a PHC verifier for a PIN or badge string, with a random 16-byte salt. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await deriveBits(secret, salt, ITERATIONS);
  return `pbkdf2$sha256$${ITERATIONS}$${toB64(salt)}$${toB64(derived)}`;
}

async function verifySecret(secret: string, phc: string): Promise<boolean> {
  const parts = phc.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromB64(parts[3]!);
    expected = fromB64(parts[4]!);
  } catch {
    return false;
  }
  const actual = await deriveBits(secret, salt, iterations);
  return timingSafeEqual(actual, expected);
}

export async function verifyPin(pin: string, phc: string): Promise<boolean> {
  return verifySecret(pin, phc);
}

export async function verifyBadge(code: string, phc: string): Promise<boolean> {
  return verifySecret(code, phc);
}

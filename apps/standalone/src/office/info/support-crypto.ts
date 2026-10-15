import type { SupportKey } from "./support-keys.js";

/**
 * The usage statistics of the support text, readable by the maker only. A
 * hybrid scheme over WebCrypto: an ephemeral ECDH P-256 key against the
 * recipient's public key, HKDF-SHA256 to an AES-256-GCM key, the payload
 * deflated first when the webview can (`CompressionStream`). The result is one
 * text token:
 *
 *   `MKS1.<kid>.<base64url(flag ‖ epk ‖ iv ‖ ciphertext ‖ tag)>`
 *
 * `flag` is one byte (1: the plaintext was deflated, raw deflate; 0: it was
 * not), `epk` the ephemeral public key as an uncompressed point (65 bytes),
 * `iv` 12 random bytes. The additional authenticated data is `MKS1.<kid>`
 * followed by the flag byte, so a changed version, key id or flag fails the
 * tag; the HKDF `info` is `MKS1.<kid>` followed by `epk`, which binds the key
 * to both. Nothing but the recipient's private key opens it
 * (`tools/standalone-support/decrypt.mjs`); the person who copies the text
 * sees an opaque token. The host's route stays plaintext: only the webview
 * encrypts, when it composes the bundle.
 */
export const BLOB_VERSION = "MKS1";

const EPK_BYTES = 65;
const IV_BYTES = 12;

/** What `encryptSupportPayload` may be told apart from the defaults (tests). */
export interface EncryptOptions {
  /** Deflate before encrypting; default: when the runtime has `CompressionStream`. */
  compress?: boolean;
  subtle?: SubtleCrypto;
  random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Raw deflate of `bytes` through the platform's stream. */
async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  // The writes settle as the reader drains; their failure surfaces on the reader.
  void writer.write(bytes).catch(() => undefined);
  void writer.close().catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concat(...chunks);
}

/** Encrypts `payload` for `key`; the token is safe to paste into a letter. */
export async function encryptSupportPayload(
  payload: string,
  key: SupportKey,
  options: EncryptOptions = {},
): Promise<string> {
  const subtle = options.subtle ?? globalThis.crypto.subtle;
  const random = options.random ?? ((bytes) => globalThis.crypto.getRandomValues(bytes));
  const compress = options.compress ?? typeof CompressionStream !== "undefined";
  const plain = utf8(payload);
  const body = compress ? await deflate(plain) : plain;
  const flag = Uint8Array.of(compress ? 1 : 0);

  const recipient = await subtle.importKey(
    "jwk",
    { kty: key.jwk.kty, crv: key.jwk.crv, x: key.jwk.x, y: key.jwk.y },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const epk = new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey));
  if (epk.length !== EPK_BYTES) throw new Error("unexpected ephemeral key size");
  const shared = await subtle.deriveBits(
    { name: "ECDH", public: recipient },
    ephemeral.privateKey,
    256,
  );
  const label = `${BLOB_VERSION}.${key.kid}`;
  const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aes = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: concat(utf8(label), epk) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = random(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: concat(utf8(label), flag) },
      aes,
      body,
    ),
  );
  return `${label}.${toBase64Url(concat(flag, epk, iv, sealed))}`;
}

/** The shape of a token the support text may carry (`SupportBlock.opaque`). */
export const BLOB_PATTERN = /^MKS1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{100,40000}$/u;

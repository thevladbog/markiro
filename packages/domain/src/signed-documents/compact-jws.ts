import { z } from "zod";

import { utf16BoundedString } from "../utf16-string.js";

/**
 * A compact JWS with ES256 (ECDSA P-256 SHA-256, the 64-byte IEEE P1363
 * signature): the format of the cloud's offline grants and of the standalone
 * product's license and update manifest (spec 2026-10-13 §4.1). The exact
 * bytes `header.payload` are signed, so nothing is re-serialized before
 * verification, and every segment must be canonical unpadded base64url.
 * `markiro_proto::trust` (Rust) is the twin; the fixtures of
 * `fixtures/standalone-license/` hold both to the same answers.
 */
export interface TrustedKey {
  kid: string;
  jwk: JsonWebKey;
}
export type CompactJwsFailure = "malformed" | "unknown_key" | "bad_signature";
export type CompactJwsVerification =
  { ok: true; kid: string; payload: Uint8Array } | { ok: false; reason: CompactJwsFailure };

const protectedHeaderSchema = z
  .object({ typ: z.string(), alg: z.literal("ES256"), kid: utf16BoundedString(1, 128) })
  .strict();

/** Unpadded base64url of `bytes`. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** The bytes of a canonical unpadded base64url segment; throws on anything else. */
export function decodeBase64UrlCanonical(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) {
    throw new Error("Invalid base64url");
  }
  const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  const canonical = btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  if (canonical !== segment) throw new Error("Noncanonical base64url");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** UTF-8 that keeps a byte order mark, so JSON.parse refuses it as serde_json does. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

// A lone UTF-16 surrogate: JSON.parse takes `"\ud800"`, serde_json does not.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** `text` holds no lone surrogate (`String.prototype.isWellFormed`, ES2024). */
export function isWellFormedText(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}

/**
 * `JSON.parse` as `markiro_proto::trust` reads a document: a `__proto__` key
 * (an own property Zod's `.strict()` does not see) and a lone surrogate in a
 * key or a string throw, as serde_json refuses them. Throws on anything else
 * `JSON.parse` throws on.
 */
export function parseJsonStrict(text: string): unknown {
  return JSON.parse(text, function strict(key: string, value: unknown) {
    if (key === "__proto__" || !isWellFormedText(key)) throw new Error("Refused JSON key");
    if (typeof value === "string" && !isWellFormedText(value)) {
      throw new Error("Refused JSON string");
    }
    return value;
  });
}

interface Segments {
  kid: string;
  payload: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
  signingInput: Uint8Array<ArrayBuffer>;
}

function segments(compact: string, typ: string): Segments | null {
  try {
    const parts = compact.split(".");
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (parts.length !== 3 || !encodedHeader || !encodedPayload || !encodedSignature) return null;
    const header = protectedHeaderSchema.parse(
      parseJsonStrict(decodeUtf8Strict(decodeBase64UrlCanonical(encodedHeader))),
    );
    if (header.typ !== typ) return null;
    return {
      kid: header.kid,
      payload: decodeBase64UrlCanonical(encodedPayload),
      signature: decodeBase64UrlCanonical(encodedSignature),
      signingInput: new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    };
  } catch {
    return null;
  }
}

function usable(jwk: JsonWebKey): boolean {
  return (
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    !("d" in jwk) &&
    (jwk.alg === undefined || jwk.alg === "ES256") &&
    (jwk.use === undefined || jwk.use === "sig")
  );
}

/**
 * Checks a compact JWS of type `typ` against `keys`: the header exactly
 * `{typ, alg: "ES256", kid}`, the `kid` named once in `keys` and not retired,
 * the signature over the exact bytes. The payload comes back as bytes: its
 * reading belongs to the caller (`verifyStandaloneLicense`).
 */
export async function verifyCompactJws(
  compact: string,
  options: { typ: string; keys: readonly TrustedKey[]; retiredKids?: readonly string[] },
): Promise<CompactJwsVerification> {
  const parts = segments(compact, options.typ);
  if (!parts) return { ok: false, reason: "malformed" };
  if (options.retiredKids?.includes(parts.kid)) return { ok: false, reason: "unknown_key" };
  const named = options.keys.filter((key) => key.kid === parts.kid);
  // An ambiguous keyset fails closed rather than trusting array order.
  const key = named.length === 1 ? named[0] : undefined;
  if (!key || !usable(key.jwk)) return { ok: false, reason: "unknown_key" };
  if (parts.signature.length !== 64) return { ok: false, reason: "bad_signature" };
  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "jwk",
      key.jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return { ok: false, reason: "unknown_key" };
  }
  try {
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      parts.signature,
      parts.signingInput,
    );
    return valid
      ? { ok: true, kid: parts.kid, payload: parts.payload }
      : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}

/** Signs `payload` (its JSON.stringify text) as a compact JWS `{typ, alg: "ES256", kid}`. */
export async function signCompactJws(
  privateKey: CryptoKey,
  header: { typ: string; kid: string },
  payload: unknown,
): Promise<string> {
  const encoder = new TextEncoder();
  const headerText = JSON.stringify(
    protectedHeaderSchema.parse({ typ: header.typ, alg: "ES256", kid: header.kid }),
  );
  // JSON.stringify gives undefined for undefined or a function, and escapes
  // a lone surrogate (`\ud800`) that parseJsonStrict and serde_json refuse:
  // sign only what the verifiers will read.
  const payloadText: unknown = JSON.stringify(payload);
  if (typeof payloadText !== "string") throw new Error("The payload is not JSON");
  try {
    parseJsonStrict(headerText);
    parseJsonStrict(payloadText);
  } catch {
    throw new Error("The header or payload holds a lone surrogate or a __proto__ key");
  }
  const encodedHeader = encodeBase64Url(encoder.encode(headerText));
  const encodedPayload = encodeBase64Url(encoder.encode(payloadText));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      encoder.encode(`${encodedHeader}.${encodedPayload}`),
    ),
  );
  if (signature.length !== 64) throw new Error("An ES256 signature is 64 bytes");
  return `${encodedHeader}.${encodedPayload}.${encodeBase64Url(signature)}`;
}

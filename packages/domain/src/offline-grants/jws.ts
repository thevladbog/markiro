import { grantProtectedHeaderSchema, offlineGrantSchema } from "./contracts.js";
import type { OfflineGrant } from "./types.js";

export interface VerificationKey {
  kid: string;
  origin: string;
  jwk: JsonWebKey;
}
export type VerifiedGrantResult =
  | { ok: true; grant: OfflineGrant; compact: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "unknown_key" | "wrong_origin" };

function decode(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) {
    throw new Error("Invalid base64url");
  }
  const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  const canonical = btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  if (canonical !== segment) throw new Error("Noncanonical base64url");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Verifies before local transactions. Callers must still revalidate owner/time/budget at commit. */
export async function verifyGrant(
  compact: string,
  keys: readonly VerificationKey[],
  serverOrigin: string,
): Promise<VerifiedGrantResult> {
  let header;
  let payload;
  let signature;
  let signingInput;
  try {
    const segments = compact.split(".");
    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    if (segments.length !== 3 || !encodedHeader || !encodedPayload || !encodedSignature) {
      return { ok: false, reason: "malformed" };
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    header = grantProtectedHeaderSchema.parse(JSON.parse(decoder.decode(decode(encodedHeader))));
    payload = offlineGrantSchema.parse(JSON.parse(decoder.decode(decode(encodedPayload))));
    signature = decode(encodedSignature);
    signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (signature.length !== 64) return { ok: false, reason: "bad_signature" };
  if (payload.issuer !== serverOrigin) return { ok: false, reason: "wrong_origin" };
  try {
    const origin = new URL(serverOrigin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.origin !== serverOrigin ||
      origin.origin === "null"
    ) {
      return { ok: false, reason: "wrong_origin" };
    }
  } catch {
    return { ok: false, reason: "wrong_origin" };
  }
  const namedKeys = keys.filter((key) => key.kid === header.kid);
  if (namedKeys.length === 0) return { ok: false, reason: "unknown_key" };
  const originKeys = namedKeys.filter((key) => key.origin === serverOrigin);
  if (originKeys.length === 0) return { ok: false, reason: "wrong_origin" };
  // Ambiguous key configuration fails closed rather than trusting array order.
  const key = originKeys.length === 1 ? originKeys[0] : undefined;
  if (
    !key ||
    key.jwk.kty !== "EC" ||
    key.jwk.crv !== "P-256" ||
    "d" in key.jwk ||
    (key.jwk.alg !== undefined && key.jwk.alg !== "ES256") ||
    (key.jwk.use !== undefined && key.jwk.use !== "sig")
  ) {
    return { ok: false, reason: "unknown_key" };
  }
  let publicKey;
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
      signature,
      signingInput,
    );
    return valid ? { ok: true, grant: payload, compact } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}

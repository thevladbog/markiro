import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

export interface CompactJwsPublicKey {
  kid: string;
  jwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
}
export interface CompactJwsKeyset {
  origin: string;
  keys: readonly CompactJwsPublicKey[];
  retiredKids: readonly string[];
}
export interface CompactJwsSigningKey {
  kid: string;
  privateKey: KeyObject;
}

/**
 * Checks one active P-256 key against its distributed public keyset (offline
 * grants, standalone licenses). Throws a bare Error without key material; every
 * caller replaces it with its own one-line message.
 */
export function loadCompactJwsSigningKey(input: {
  origin: string;
  kid: string;
  pem: string;
  keyset: CompactJwsKeyset;
}): CompactJwsSigningKey {
  const { origin, kid, pem, keyset } = input;
  if (keyset.origin !== origin || keyset.retiredKids.includes(kid)) throw new Error();
  for (const entry of keyset.keys) {
    const key = createPublicKey({
      key: { kty: entry.jwk.kty, crv: entry.jwk.crv, x: entry.jwk.x, y: entry.jwk.y },
      format: "jwk",
    });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
      throw new Error();
    const actual = key.export({ format: "jwk" });
    if (actual.x !== entry.jwk.x || actual.y !== entry.jwk.y) throw new Error();
  }
  const privateKey = createPrivateKey(pem);
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new Error();
  const actual = createPublicKey(privateKey).export({ format: "jwk" });
  const entry = keyset.keys.find((key) => key.kid === kid);
  if (!entry || entry.jwk.x !== actual.x || entry.jwk.y !== actual.y) throw new Error();
  return { kid, privateKey };
}

/**
 * ES256 over the exact `header.payload` bytes (no JSON canonicalization), header
 * `{alg, typ, kid}` in this order — the offline grants' bytes — and a 64-byte
 * IEEE P1363 signature.
 */
export function signCompactJws(
  config: CompactJwsSigningKey,
  typ: string,
  payload: unknown,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ, kid: config.kid })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const bytes = `${header}.${body}`;
  const signature = sign("sha256", Buffer.from(bytes), {
    key: config.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  if (signature.length !== 64) throw new Error("Invalid compact JWS signature length");
  return `${bytes}.${signature.toString("base64url")}`;
}

import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { grantKeysetSchema, type GrantKeyset } from "@markiro/platform-contracts";
import { offlineGrantSchema, type OfflineGrant } from "@markiro/domain";

export interface GrantSigningEnvironment {
  OFFLINE_GRANT_ORIGIN?: string | undefined;
  OFFLINE_GRANT_KID?: string | undefined;
  OFFLINE_GRANT_PRIVATE_KEY_PEM?: string | undefined;
  OFFLINE_GRANT_KEYSET_JSON?: string | undefined;
}
export interface GrantSigningConfiguration {
  origin: string;
  kid: string;
  privateKey: KeyObject;
  keyset: GrantKeyset;
}
export const GRANT_SIGNING_CONFIGURATION = Symbol("GRANT_SIGNING_CONFIGURATION");
/** No config keeps legacy startup operational. Errors never include key material. */
export function configureGrantSigning(
  env: GrantSigningEnvironment,
): GrantSigningConfiguration | null {
  const values = [
    env.OFFLINE_GRANT_ORIGIN,
    env.OFFLINE_GRANT_KID,
    env.OFFLINE_GRANT_PRIVATE_KEY_PEM,
    env.OFFLINE_GRANT_KEYSET_JSON,
  ];
  if (values.every((value) => value === undefined || value === "")) return null;
  try {
    const {
      OFFLINE_GRANT_ORIGIN: origin,
      OFFLINE_GRANT_KID: kid,
      OFFLINE_GRANT_PRIVATE_KEY_PEM: pem,
      OFFLINE_GRANT_KEYSET_JSON: json,
    } = env;
    if (!origin || !kid || !pem || !json) throw new Error();
    const keyset = grantKeysetSchema.parse(JSON.parse(json));
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
    return { origin, kid, privateKey, keyset };
  } catch {
    throw new Error("Invalid offline grant signing configuration");
  }
}
export function signOfflineGrant(config: GrantSigningConfiguration, grant: OfflineGrant): string {
  const validated = offlineGrantSchema.parse(grant);
  if (validated.issuer !== config.origin) throw new Error("Offline grant origin mismatch");
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", typ: "markiro-offline-grant+jws", kid: config.kid }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(validated)).toString("base64url");
  const bytes = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(bytes), {
    key: config.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  if (signature.length !== 64) throw new Error("Invalid offline grant signature length");
  return `${bytes}.${signature.toString("base64url")}`;
}

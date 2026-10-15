import type { KeyObject } from "node:crypto";
import {
  standaloneLicenseSigningKeysetSchema,
  type StandaloneLicenseSigningKeyset,
} from "@markiro/platform-contracts";
import { loadCompactJwsSigningKey } from "../../signing/compact-jws";
import { configureGrantSigning, type GrantSigningEnvironment } from "../device-grants/grant-keyset";

export interface StandaloneLicenseSigningEnvironment {
  STANDALONE_LICENSE_ISSUER?: string | undefined;
  STANDALONE_LICENSE_KID?: string | undefined;
  STANDALONE_LICENSE_PRIVATE_KEY_PEM?: string | undefined;
  STANDALONE_LICENSE_KEYSET_JSON?: string | undefined;
}
export interface StandaloneLicenseSigningConfiguration {
  issuer: string;
  kid: string;
  privateKey: KeyObject;
  keyset: StandaloneLicenseSigningKeyset;
}
export const STANDALONE_LICENSE_SIGNING = Symbol("STANDALONE_LICENSE_SIGNING");
export const STANDALONE_LICENSE_SIGNING_ERROR = "Invalid standalone license signing configuration";

/**
 * The license key is its own (spec 2026-10-13 §5.1): all four values absent keeps
 * the API up with issuance refused; a partial or mismatched set fails startup.
 * One-line stores (the Yandex runtime env file) may carry the PEM with `\n`
 * escapes. Errors never include key material.
 */
export function configureStandaloneLicenseSigning(
  env: StandaloneLicenseSigningEnvironment,
): StandaloneLicenseSigningConfiguration | null {
  const values = [
    env.STANDALONE_LICENSE_ISSUER,
    env.STANDALONE_LICENSE_KID,
    env.STANDALONE_LICENSE_PRIVATE_KEY_PEM,
    env.STANDALONE_LICENSE_KEYSET_JSON,
  ];
  if (values.every((value) => value === undefined || value === "")) return null;
  try {
    const {
      STANDALONE_LICENSE_ISSUER: issuer,
      STANDALONE_LICENSE_KID: kid,
      STANDALONE_LICENSE_PRIVATE_KEY_PEM: rawPem,
      STANDALONE_LICENSE_KEYSET_JSON: json,
    } = env;
    if (!issuer || !kid || !rawPem || !json) throw new Error();
    const pem = rawPem.includes("\\n") ? rawPem.replaceAll("\\n", "\n") : rawPem;
    const keyset = standaloneLicenseSigningKeysetSchema.parse(JSON.parse(json));
    const { privateKey } = loadCompactJwsSigningKey({ origin: issuer, kid, pem, keyset });
    return { issuer, kid, privateKey, keyset };
  } catch {
    throw new Error(STANDALONE_LICENSE_SIGNING_ERROR);
  }
}

/** True only when both are configured and a license public key is also a grant public key. */
export function standaloneLicenseReusesGrantKey(
  env: StandaloneLicenseSigningEnvironment & GrantSigningEnvironment,
): boolean {
  const loaded = (() => {
    try {
      return { grant: configureGrantSigning(env), license: configureStandaloneLicenseSigning(env) };
    } catch {
      return null;
    }
  })();
  if (!loaded) return false;
  const { grant, license } = loaded;
  if (!grant || !license) return false;
  const grantKeys = grant.keyset.keys;
  return license.keyset.keys.some((key) =>
    grantKeys.some((other) => other.jwk.x === key.jwk.x && other.jwk.y === key.jwk.y),
  );
}

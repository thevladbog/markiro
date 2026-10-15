import type { KeyObject } from "node:crypto";
import { grantKeysetSchema, type GrantKeyset } from "@markiro/platform-contracts";
import { offlineGrantSchema, type OfflineGrant } from "@markiro/domain";
import { loadCompactJwsSigningKey, signCompactJws } from "../../signing/compact-jws";

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
    const { privateKey } = loadCompactJwsSigningKey({ origin, kid, pem, keyset });
    return { origin, kid, privateKey, keyset };
  } catch {
    throw new Error("Invalid offline grant signing configuration");
  }
}
export function signOfflineGrant(config: GrantSigningConfiguration, grant: OfflineGrant): string {
  const validated = offlineGrantSchema.parse(grant);
  if (validated.issuer !== config.origin) throw new Error("Offline grant origin mismatch");
  return signCompactJws(config, "markiro-offline-grant+jws", validated);
}

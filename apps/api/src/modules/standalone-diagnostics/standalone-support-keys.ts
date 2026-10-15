import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { z } from "zod";
import type { SupportPrivateKey } from "./support-blob";

export interface StandaloneSupportKeysEnvironment {
  STANDALONE_SUPPORT_KEYS_JSON?: string | undefined;
}
export const STANDALONE_SUPPORT_KEYS = Symbol("STANDALONE_SUPPORT_KEYS");
export const STANDALONE_SUPPORT_KEYS_ERROR = "Invalid standalone support keys configuration";

const entrySchema = z
  .object({ kid: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), pem: z.string().min(1).max(4096) })
  .strict();
const listSchema = z.array(entrySchema).min(1).max(8);

/**
 * The support keys are PRIVATE and live only in the API's environment (Lockbox record
 * `STANDALONE_SUPPORT_KEYS_JSON`, plan ДИАГ): `[{kid, pem}]`, one JSON line, the PEM's newlines as
 * `\n`; SEC1 (`BEGIN EC PRIVATE KEY`, what `openssl ecparam -genkey` prints) and PKCS8 both load. Empty means
 * ingestion is off (the API starts); a set but unusable value fails the start with one sentence
 * that carries no key material. A second entry is a rotation.
 */
export function configureStandaloneSupportKeys(
  env: StandaloneSupportKeysEnvironment,
): readonly SupportPrivateKey[] | null {
  const raw = env.STANDALONE_SUPPORT_KEYS_JSON;
  if (raw === undefined || raw.trim() === "") return null;
  try {
    const entries = listSchema.parse(JSON.parse(raw));
    if (new Set(entries.map((entry) => entry.kid)).size !== entries.length) throw new Error();
    return entries.map(({ kid, pem }) => {
      const privateKey = createPrivateKey(pem.includes("\\n") ? pem.replaceAll("\\n", "\n") : pem);
      if (
        privateKey.type !== "private" ||
        privateKey.asymmetricKeyType !== "ec" ||
        privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
      )
        throw new Error();
      return { kid, privateKey };
    });
  } catch {
    throw new Error(STANDALONE_SUPPORT_KEYS_ERROR);
  }
}

/** `sup-` + 8 hex of SHA-256(04 ‖ x ‖ y): the id `decrypt.mjs --public-jwk` prints for the pair. */
export function expectedSupportKid(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(String(jwk.x), "base64url"),
    Buffer.from(String(jwk.y), "base64url"),
  ]);
  return `sup-${createHash("sha256").update(point).digest("hex").slice(0, 8)}`;
}

/** Kids that differ from their key's derived id (a warning at start: the owner may use `--kid`). */
export function supportKeyKidMismatches(keys: readonly SupportPrivateKey[]): string[] {
  return keys.filter((key) => key.kid !== expectedSupportKid(key.privateKey)).map((key) => key.kid);
}

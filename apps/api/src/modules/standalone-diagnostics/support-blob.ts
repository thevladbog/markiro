import {
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { inflateRawSync } from "node:zlib";

/**
 * Opens the token `MKS1.<kid>.<base64url(flag ‖ epk(65) ‖ iv(12) ‖ ciphertext ‖ tag(16))>` of a
 * «Сведения для поддержки» text (writer: `apps/standalone/src/office/info/support-crypto.ts`,
 * the maker's tool: `tools/standalone-support/decrypt.mjs`). ECDH P-256 + HKDF-SHA256 (empty
 * salt, info `MKS1.<kid>` ‖ epk) + AES-256-GCM, AAD `MKS1.<kid>` ‖ flag; flag 1 is raw deflate.
 *
 * The token is an operator's paste: every size is bounded before the next step, a changed key
 * id, flag, key, nonce or ciphertext all answer `undecryptable` (no oracle), and the inflate
 * stops at a ceiling so a 16 KiB bomb cannot grow into gigabytes. Imports `node:` modules only:
 * the standalone app's parity test reads this file by path.
 */
export type SupportBlobFailure =
  | "no_token"
  | "token_malformed"
  | "token_too_large"
  | "unknown_key"
  | "undecryptable"
  | "payload_too_large"
  | "payload_invalid";

export interface SupportPrivateKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
}

export type OpenedSupportBlob =
  | {
      ok: true;
      kid: string;
      compressed: boolean;
      json: unknown;
      /** SHA-256 of the canonical token string (hex): the idempotency key. */
      blobSha256: string;
    }
  | { ok: false; reason: SupportBlobFailure; kid?: string };

export const MAX_TOKEN_CHARS = 16 * 1024;
export const MAX_INFLATED_BYTES = 256 * 1024;
export const MAX_PAYLOAD_BYTES = 64 * 1024;

const EPK_BYTES = 65;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const TOKEN = /MKS1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+/u;
const KID = /^[A-Za-z0-9_-]{1,32}$/u;

function fail(reason: SupportBlobFailure, kid?: string): OpenedSupportBlob {
  return kid === undefined ? { ok: false, reason } : { ok: false, reason, kid };
}

export function openSupportBlob(
  text: string,
  keys: readonly SupportPrivateKey[],
): OpenedSupportBlob {
  const match = TOKEN.exec(text);
  if (match === null) return fail("no_token");
  const token = match[0];
  if (token.length > MAX_TOKEN_CHARS) return fail("token_too_large");
  const parts = token.split(".");
  const kid = parts[1];
  const body = parts[2];
  if (parts.length !== 3 || kid === undefined || body === undefined || !KID.test(kid))
    return fail("token_malformed");
  const bytes = Buffer.from(body, "base64url");
  // A lenient decoder ignores unused trailing bits; only the canonical text may reach the hash.
  if (bytes.toString("base64url") !== body) return fail("token_malformed", kid);
  if (bytes.length < 1 + EPK_BYTES + IV_BYTES + TAG_BYTES) return fail("token_malformed", kid);
  const flag = bytes[0];
  if (flag !== 0 && flag !== 1) return fail("token_malformed", kid);
  const key = keys.find((candidate) => candidate.kid === kid);
  if (key === undefined) return fail("unknown_key", kid);

  const epk = bytes.subarray(1, 1 + EPK_BYTES);
  const iv = bytes.subarray(1 + EPK_BYTES, 1 + EPK_BYTES + IV_BYTES);
  const sealed = bytes.subarray(1 + EPK_BYTES + IV_BYTES);
  let plain: Buffer;
  try {
    if (epk[0] !== 4) throw new Error("not an uncompressed point");
    const ephemeral = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: epk.subarray(1, 33).toString("base64url"),
        y: epk.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    const shared = diffieHellman({ privateKey: key.privateKey, publicKey: ephemeral });
    const label = Buffer.from(`MKS1.${kid}`, "utf8");
    const aes = Buffer.from(
      hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.concat([label, epk]), 32),
    );
    const decipher = createDecipheriv("aes-256-gcm", aes, iv);
    decipher.setAAD(Buffer.concat([label, Buffer.from([flag])]));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    plain = Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    return fail("undecryptable", kid);
  }

  if (flag === 1) {
    try {
      plain = inflateRawSync(plain, { maxOutputLength: MAX_INFLATED_BYTES });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      return fail(code === "ERR_BUFFER_TOO_LARGE" ? "payload_too_large" : "payload_invalid", kid);
    }
  }
  if (plain.length > MAX_PAYLOAD_BYTES) return fail("payload_too_large", kid);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
  } catch {
    return fail("payload_invalid", kid);
  }
  return {
    ok: true,
    kid,
    compressed: flag === 1,
    json,
    blobSha256: createHash("sha256").update(token).digest("hex"),
  };
}

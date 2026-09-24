import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const CODE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Stable digest of the effective code identities in one transport box. */
export function boxMembershipDigestV1(codeHashes: readonly string[]): string {
  const sorted = [...codeHashes].sort();
  for (let index = 0; index < sorted.length; index += 1) {
    const hash = sorted[index]!;
    if (!CODE_HASH_PATTERN.test(hash)) throw new Error("invalid box member hash");
    if (index > 0 && hash === sorted[index - 1]) throw new Error("duplicate box member hash");
  }
  return bytesToHex(sha256(utf8ToBytes(`markiro:box-members:v1\n${sorted.join("\n")}`)));
}

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { DomainError } from "../errors.js";
import { canonicalizeKm, type ParsedKm } from "../gs1/km.js";

/** Eligibility for duplication, not a check of the crypto signature's authenticity. */
export function parseDuplicateKm(raw: string): ParsedKm {
  const km = canonicalizeKm(raw);
  if (!(km.ais["93"] || (km.ais["91"] && km.ais["92"]))) {
    throw new DomainError("KM_REPRINT_INCOMPLETE", "Complete marking code required");
  }
  return km;
}

export function compareDuplicateKm(
  expected: string,
  scanned: string,
): "match" | "mismatch" | "invalid" {
  // A damaged saved payload is a storage failure, not an operator mismatch.
  const canonicalExpected = parseDuplicateKm(expected).raw;
  try {
    return parseDuplicateKm(scanned).raw === canonicalExpected ? "match" : "mismatch";
  } catch (error) {
    if (error instanceof DomainError) return "invalid";
    throw error;
  }
}

export function productLabelBytesDigest(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** Unlike kmHash, this includes all separators and the entire crypto tail. */
export function duplicatePayloadDigest(raw: string): string {
  return productLabelBytesDigest(utf8ToBytes(parseDuplicateKm(raw).raw));
}

function invalidJson(): never {
  throw new DomainError("PRODUCT_LABEL_JSON_INVALID", "Product label data must be finite JSON");
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? JSON.stringify(value) : invalidJson();
  if (typeof value !== "object" || ancestors.has(value)) return invalidJson();
  if (Object.getOwnPropertySymbols(value).length > 0) return invalidJson();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // Array.from exposes holes as undefined instead of silently hashing them as null.
      return `[${Array.from(value, (item: unknown) => canonicalJson(item, ancestors)).join(",")}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidJson();
    const fields = Object.keys(value)
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) return invalidJson();
        return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`;
      });
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Stable across JSON object-key order; array order and every value remain significant. */
export function productLabelValueDigest(value: unknown): string {
  return productLabelBytesDigest(utf8ToBytes(canonicalJson(value, new Set())));
}

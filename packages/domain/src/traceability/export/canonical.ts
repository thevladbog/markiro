import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

function quoteJsonString(text: string): string {
  // eslint-disable-next-line no-control-regex -- JSON control characters must use the escaping fallback.
  return /["\\\x00-\x1f\x7f-\uffff]/.test(text) ? JSON.stringify(text) : '"' + text + '"';
}

/**
 * Hash lossless JSON. Only the root events/findings are unordered selections.
 * Arrays inside saved snapshots retain their source order, including documents.
 * No date conversion, Unicode normalization or decimal coercion is performed.
 */
export function canonicalExportJson(input: unknown): string {
  const ancestors = new Set<object>();
  const serialize = (value: unknown, root = false, unordered = false): string => {
    if (value === null) return "null";
    if (typeof value === "string") return quoteJsonString(value);
    if (typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== "object") throw new TypeError("Export digest requires finite JSON values");
    if (ancestors.has(value)) throw new TypeError("Export digest cannot contain cycles");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length)
          throw new TypeError("Export digest requires dense JSON arrays");
        const parts = Array.from(value, (item: unknown) => serialize(item));
        if (unordered) parts.sort();
        return `[${parts.join(",")}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError("Export digest requires plain JSON objects");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(value).length !== Object.keys(value).length)
        throw new TypeError("Export digest cannot discard hidden or symbol properties");
      return `{${Object.keys(descriptors)
        .sort()
        .map((key) => {
          const descriptor = descriptors[key];
          if (!descriptor || !("value" in descriptor))
            throw new TypeError("Export digest cannot evaluate getters");
          return `${quoteJsonString(key)}:${serialize(descriptor.value, false, root && (key === "events" || key === "findings"))}`;
        })
        .join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  };
  return serialize(input, true);
}

export function canonicalExportDigest(input: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalExportJson(input))));
}

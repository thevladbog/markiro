/**
 * The file's checksum: SHA-256 of the canonical JSON of the whole file
 * without its `checksum` field. Canonical JSON writes object keys sorted
 * (JavaScript's default order), no spaces, and values as `JSON.stringify`
 * writes them, so the office (`apps/standalone/src/host/cloud-import.ts`),
 * which parses the file and computes the same text, gets the same digest
 * whatever order or whitespace the file has on disk.
 */

import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `sha256:<hex>` of the file without `checksum`. */
export function fileChecksum(file) {
  const { checksum: _ignored, ...rest } = file;
  return `sha256:${createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex")}`;
}

import { ServiceUnavailableException } from "@nestjs/common";
import { zipSync, type Zippable } from "fflate";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseUsRequestManifest, type UsRequestManifestV1 } from "./us-request-package-manifest";
import {
  US_REQUEST_PACKAGE_LIMITS as limits,
  type UsRequestPackageByteFile,
} from "./us-request-package-types";
import { stableStringify } from "./us-request-snapshot";

export interface UsRequestPackageExpectation {
  manifest: UsRequestManifestV1;
  files: readonly UsRequestPackageByteFile[];
}
const invalid = () =>
  new ServiceUnavailableException({ code: "us_request_package_archive_invalid" });
const sizeLimit = () => new ServiceUnavailableException({ code: "us_request_package_size_limit" });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const names = [
  "records.xlsx",
  "plan.pdf",
  "validation.json",
  "request-report.pdf",
  "manifest.json",
  "SHA256SUMS",
] as const;
const mediaTypes = {
  "records.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "plan.pdf": "application/pdf",
  "validation.json": "application/json",
  "request-report.pdf": "application/pdf",
  "manifest.json": "application/json",
  SHA256SUMS: "text/plain",
} as const;
function fileLimit(name: (typeof names)[number]): number {
  switch (name) {
    case "records.xlsx":
      return limits.workbook;
    case "plan.pdf":
      return limits.plan;
    case "validation.json":
      return limits.validation;
    case "request-report.pdf":
      return limits.report;
    case "manifest.json":
      return limits.manifest;
    case "SHA256SUMS":
      return limits.sums;
  }
}
const fileSchema = z
  .object({
    name: z.enum(names),
    mediaType: z.string(),
    byteSize: z.number().refine(Number.isSafeInteger).positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.instanceof(Buffer),
  })
  .strict();
function bounded(size: number, maximum: number): void {
  if (size > maximum) throw sizeLimit();
}
function plainData(value: object): void {
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== Object.keys(value).length ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some((d) => !("value" in d))
  )
    throw invalid();
}
function canonicalJson(bytes: Buffer): unknown {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!bytes.equals(Buffer.from(stableStringify(value), "utf8"))) throw invalid();
  return value;
}
/** Preflight actual bounds and descriptors before any ZIP allocation. */
function preflight(files: readonly UsRequestPackageByteFile[]) {
  if (!Array.isArray(files) || files.length < 4 || files.length > limits.entries) throw invalid();
  const values: readonly unknown[] = files;
  const parsed = values.map((file) => {
    if (!file || typeof file !== "object") throw invalid();
    plainData(file);
    return fileSchema.parse(file);
  });
  const ordered = names.filter(
    (name) =>
      (name !== "records.xlsx" && name !== "plan.pdf") || parsed.some((file) => file.name === name),
  );
  if (stableStringify(parsed.map((file) => file.name)) !== stableStringify(ordered))
    throw invalid();
  let total = 0,
    archiveSize = 22;
  for (const file of parsed) {
    if (file.mediaType !== mediaTypes[file.name] || file.byteSize !== file.bytes.length)
      throw invalid();
    bounded(file.bytes.length, fileLimit(file.name));
    total += file.bytes.length;
    archiveSize += 76 + 2 * file.name.length + file.bytes.length;
    bounded(total, limits.entriesTotal);
    bounded(archiveSize, limits.zip);
  }
  for (const file of parsed) if (hash(file.bytes) !== file.sha256) throw invalid();
  return { files: parsed, archiveSize };
}
function contents(files: readonly UsRequestPackageByteFile[]): UsRequestManifestV1 {
  const manifestFile = files.find((file) => file.name === "manifest.json"),
    sums = files.find((file) => file.name === "SHA256SUMS"),
    validation = files.find((file) => file.name === "validation.json");
  if (!manifestFile || !sums || !validation) throw invalid();
  const manifest = parseUsRequestManifest(canonicalJson(manifestFile.bytes));
  canonicalJson(validation.bytes);
  const payloads = files.slice(0, -2).map(({ bytes, ...descriptor }) => {
    void bytes;
    return descriptor;
  });
  if (stableStringify(payloads) !== stableStringify(manifest.files)) throw invalid();
  const checksums = files
    .slice(0, -1)
    .map((file) => `${file.sha256}  ${file.name}\n`)
    .join("");
  if (!sums.bytes.equals(Buffer.from(checksums, "ascii"))) throw invalid();
  return manifest;
}
function encodingFailure(error: unknown): never {
  let oversized = false;
  try {
    oversized =
      error instanceof ServiceUnavailableException &&
      stableStringify(error.getResponse()) ===
        stableStringify({ code: "us_request_package_size_limit" });
  } catch {
    /* A foreign exception response must not become a secondary failure. */
  }
  if (oversized) throw sizeLimit();
  throw invalid();
}

/** Stored, finite ASCII entries only. Local date components deliberately match fflate's DOS fields. */
export function encodeUsRequestPackageArchive(
  files: readonly UsRequestPackageByteFile[],
): UsRequestPackageByteFile<"package.zip"> {
  try {
    const checked = preflight(files);
    contents(checked.files);
    const entries: Zippable = {};
    for (const file of checked.files)
      entries[file.name] = [
        Buffer.from(file.bytes),
        { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0, 0), os: 0, attrs: 0 },
      ];
    const bytes = Buffer.from(zipSync(entries, { level: 0 }));
    bounded(bytes.length, limits.zip);
    if (bytes.length !== checked.archiveSize) throw invalid();
    return {
      name: "package.zip",
      mediaType: "application/zip",
      byteSize: bytes.length,
      sha256: hash(bytes),
      bytes,
    };
  } catch (error) {
    return encodingFailure(error);
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const entry = crcTable[(crc ^ byte) & 255];
    if (entry === undefined) throw invalid();
    crc = (crc >>> 8) ^ entry;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
type StoredRange = { file: UsRequestPackageByteFile; start: number; end: number; crc: number };

/** No decompressor, unchecked-size allocation or object-key collapse. Authority is the original expected set. */
export function verifyUsRequestPackageArchive(
  bytes: Uint8Array,
  expected: UsRequestPackageExpectation,
): void {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22 || bytes.byteLength > limits.zip)
      throw invalid();
    plainData(expected);
    if (stableStringify(Object.keys(expected).sort()) !== '["files","manifest"]') throw invalid();
    const checked = preflight(expected.files),
      trustedManifest = contents(checked.files);
    const manifest = parseUsRequestManifest(expected.manifest);
    if (
      stableStringify(manifest) !== stableStringify(trustedManifest) ||
      bytes.byteLength !== checked.archiveSize
    )
      throw invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const range = (start: number, size: number, end: number) => {
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(size) ||
        start < 0 ||
        size < 0 ||
        start > end ||
        size > end - start
      )
        throw invalid();
    };
    const u16 = (at: number) => {
      range(at, 2, bytes.byteLength);
      return view.getUint16(at, true);
    };
    const u32 = (at: number) => {
      range(at, 4, bytes.byteLength);
      return view.getUint32(at, true);
    };
    const eocd = bytes.byteLength - 22;
    if (
      u32(eocd) !== 0x06054b50 ||
      u16(eocd + 4) !== 0 ||
      u16(eocd + 6) !== 0 ||
      u16(eocd + 8) !== checked.files.length ||
      u16(eocd + 10) !== checked.files.length ||
      u16(eocd + 20) !== 0
    )
      throw invalid();
    const centralSize = u32(eocd + 12),
      centralStart = u32(eocd + 16);
    range(centralStart, centralSize, eocd);
    if (centralStart + centralSize !== eocd) throw invalid();
    const matchName = (at: number, name: string) => {
      for (let i = 0; i < name.length; i++)
        if (view.getUint8(at + i) !== name.charCodeAt(i)) throw invalid();
    };
    const ranges: StoredRange[] = [];
    let central = centralStart,
      local = 0,
      total = 0;
    for (const file of checked.files) {
      range(central, 46, eocd);
      const nameLength = u16(central + 28),
        size = u32(central + 24),
        crc = u32(central + 16);
      if (
        u32(central) !== 0x02014b50 ||
        u16(central + 4) !== 20 ||
        u16(central + 6) !== 20 ||
        u16(central + 8) !== 0 ||
        u16(central + 10) !== 0 ||
        u16(central + 12) !== 0 ||
        u16(central + 14) !== 33 ||
        u32(central + 20) !== size ||
        nameLength !== file.name.length ||
        u16(central + 30) !== 0 ||
        u16(central + 32) !== 0 ||
        u16(central + 34) !== 0 ||
        u16(central + 36) !== 0 ||
        u32(central + 38) !== 0 ||
        u32(central + 42) !== local ||
        size !== file.byteSize
      )
        throw invalid();
      total += size;
      if (total > limits.entriesTotal) throw invalid();
      range(central + 46, nameLength, eocd);
      matchName(central + 46, file.name);
      range(local, 30, centralStart);
      if (
        u32(local) !== 0x04034b50 ||
        u16(local + 4) !== 20 ||
        u16(local + 6) !== 0 ||
        u16(local + 8) !== 0 ||
        u16(local + 10) !== 0 ||
        u16(local + 12) !== 33 ||
        u32(local + 14) !== crc ||
        u32(local + 18) !== size ||
        u32(local + 22) !== size ||
        u16(local + 26) !== nameLength ||
        u16(local + 28) !== 0
      )
        throw invalid();
      range(local + 30, nameLength, centralStart);
      matchName(local + 30, file.name);
      const start = local + 30 + nameLength;
      range(start, size, centralStart);
      const end = start + size;
      ranges.push({ file, start, end, crc });
      local = end;
      central += 46 + nameLength;
    }
    if (local !== centralStart || central !== eocd) throw invalid();
    // All claimed ranges/profile fields are checked before the first archive slice.
    for (const entry of ranges) {
      const actual = bytes.subarray(entry.start, entry.end);
      if (
        crc32(actual) !== entry.crc ||
        hash(actual) !== entry.file.sha256 ||
        !entry.file.bytes.equals(actual)
      )
        throw invalid();
    }
  } catch {
    throw invalid();
  }
}

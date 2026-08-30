import { posix } from "node:path";

import { Inflate } from "fflate";
import { XMLParser } from "fast-xml-parser";

import type { InventoryChzStatus } from "@markiro/domain";

export const CHZ_MAX_INPUT_BYTES = 64 * 1024 * 1024;
// Cabinet XLSX exports are verbose: a 58,806-row, 7 MiB workbook expands to
// roughly 124 MiB of worksheet XML. These bounds cover up to 100,000 rows
// while the compressed upload remains subject to CHZ_MAX_INPUT_BYTES.
export const CHZ_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const CHZ_MAX_WORKSHEET_BYTES = 252 * 1024 * 1024;
export const CHZ_MAX_ROWS = 100_000;
export const CHZ_MAX_COLUMNS = 35;
export const CHZ_MAX_CELLS = 3_500_000;
export const CHZ_MAX_CELL_UTF8_BYTES = 64 * 1024;
const CHZ_MAX_ARCHIVE_ENTRIES = 128;
/**
 * Deliberately equal to `CHZ_MAX_INPUT_BYTES` rather than a tighter bound.
 *
 * `unzipBounded` serves both `.zip` and `.xlsx`, so a smaller archive cap held
 * every zip-based container to its own limit while an identically-sized plain
 * `.csv` was accepted. That is backwards for how the file actually arrives: a
 * cabinet export is routinely an `.xlsx`, and an export ordered over True API
 * is always a `.zip`. Raising `CHZ_MAX_INPUT_BYTES` alone therefore only ever
 * helped raw CSV.
 *
 * Zip bombs are not stopped here. `CHZ_MAX_UNCOMPRESSED_BYTES` stops them, and
 * it is enforced twice: against the central directory's declared total before
 * anything is inflated, and against the running total while inflating. Capping
 * the *compressed* size only caps the download, which the outer
 * `CHZ_MAX_INPUT_BYTES` check already does.
 */
const CHZ_MAX_ARCHIVE_BYTES = CHZ_MAX_INPUT_BYTES;
const CHZ_MAX_XML_METADATA_BYTES = 2 * 1024 * 1024;

export type ChzContainerKind = "csv" | "zip" | "xlsx";

export type ChzImportErrorCode =
  | "CHZ_CELL_LIMIT"
  | "CHZ_CELL_TOO_LARGE"
  | "CHZ_CONTAINER_MISMATCH"
  | "CHZ_CSV_INVALID"
  | "CHZ_EMPTY_RESULT_INVALID"
  | "CHZ_EXPECTED_GTIN_INVALID"
  | "CHZ_FILTER_GTIN_MISMATCH"
  | "CHZ_FILTER_INVALID"
  | "CHZ_FILTER_PACKAGING_MISMATCH"
  | "CHZ_FILTER_STATUS_MISMATCH"
  | "CHZ_HEADER_MISMATCH"
  | "CHZ_INPUT_TOO_LARGE"
  | "CHZ_INVALID_UTF8"
  | "CHZ_ROW_GTIN_MISMATCH"
  | "CHZ_ROW_KM_INVALID"
  | "CHZ_ROW_LIMIT"
  | "CHZ_ROW_PACKAGING_MISMATCH"
  | "CHZ_ROW_PARENT_SSCC_INVALID"
  | "CHZ_ROW_PRODUCTION_DATE_INVALID"
  | "CHZ_ROW_STATUS_MISMATCH"
  | "CHZ_ROW_WIDTH"
  | "CHZ_UNCOMPRESSED_LIMIT"
  | "CHZ_UNSUPPORTED_CONTAINER"
  | "CHZ_WORKSHEET_LIMIT"
  | "CHZ_XLSX_FORMULA_ONLY"
  | "CHZ_XLSX_INVALID"
  | "CHZ_XLSX_METADATA_LIMIT"
  | "CHZ_XLSX_NO_VISIBLE_SHEET"
  | "CHZ_XLSX_UNSUPPORTED_CELL"
  | "CHZ_ZIP_ENCRYPTED"
  | "CHZ_ZIP_EXPANSION_LIMIT"
  | "CHZ_ZIP_INVALID"
  | "CHZ_ZIP_MEMBER_COUNT"
  | "CHZ_ZIP_MEMBER_TYPE"
  | "CHZ_ZIP_TRAVERSAL"
  | "CHZ_ZIP_UNSUPPORTED_COMPRESSION";

export class ChzImportError extends Error {
  readonly code: ChzImportErrorCode;
  readonly rowNumber: number | undefined;
  readonly parsedStatus: InventoryChzStatus | undefined;
  readonly includedGtin14: string | undefined;

  constructor(
    code: ChzImportErrorCode,
    rowNumber?: number,
    filterFacts?: { parsedStatus: InventoryChzStatus; includedGtin14: string },
  ) {
    super(rowNumber === undefined ? code : `${code} at row ${rowNumber}`);
    this.name = "ChzImportError";
    this.code = code;
    this.rowNumber = rowNumber;
    this.parsedStatus = filterFacts?.parsedStatus;
    this.includedGtin14 = filterFacts?.includedGtin14;
  }

  withFilterFacts(facts: {
    parsedStatus: InventoryChzStatus;
    includedGtin14: string;
  }): ChzImportError {
    return new ChzImportError(this.code, this.rowNumber, facts);
  }
}

export interface ChzTabularRecord {
  rowNumber: number;
  cells: string[];
}

export interface ChzTabularDocument {
  containerKind: ChzContainerKind;
  records: ChzTabularRecord[];
}

interface ZipEntryMetadata {
  originalName: string;
  canonicalName: string;
  directory: boolean;
  compression: number;
  dataOffset: number;
  compressedSize: number;
  uncompressedSize: number;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function fail(code: ChzImportErrorCode, rowNumber?: number): never {
  throw new ChzImportError(code, rowNumber);
}

function utf8(bytes: Uint8Array, code: ChzImportErrorCode, rowNumber?: number): string {
  try {
    return textDecoder.decode(bytes);
  } catch {
    return fail(code, rowNumber);
  }
}

function assertUtf8(bytes: Uint8Array, code: ChzImportErrorCode): void {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
      const end = Math.min(offset + 1024 * 1024, bytes.length);
      decoder.decode(bytes.subarray(offset, end), { stream: end < bytes.length });
    }
  } catch {
    fail(code);
  }
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertCellLimit(value: string, rowNumber: number): void {
  if (utf8ByteLength(value) > CHZ_MAX_CELL_UTF8_BYTES) {
    fail("CHZ_CELL_TOO_LARGE", rowNumber);
  }
}

function parseCsv(bytes: Uint8Array): ChzTabularRecord[] {
  if (bytes.length > CHZ_MAX_UNCOMPRESSED_BYTES) fail("CHZ_UNCOMPRESSED_LIMIT");
  let text = utf8(bytes, "CHZ_INVALID_UTF8");
  if (text.startsWith("\ufeff")) text = text.slice(1);

  const records: ChzTabularRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let fieldStarted = false;
  let physicalLine = 1;
  let recordStartLine = 1;
  let totalCells = 0;

  const pushField = () => {
    assertCellLimit(field, recordStartLine);
    cells.push(field);
    if (cells.length > CHZ_MAX_COLUMNS) fail("CHZ_ROW_WIDTH", recordStartLine);
    totalCells += 1;
    if (totalCells > CHZ_MAX_CELLS) fail("CHZ_CELL_LIMIT", recordStartLine);
    field = "";
    fieldStarted = false;
    afterQuote = false;
  };

  const pushRecord = () => {
    pushField();
    records.push({ rowNumber: recordStartLine, cells });
    if (records.length > CHZ_MAX_ROWS) fail("CHZ_ROW_LIMIT", recordStartLine);
    cells = [];
    recordStartLine = physicalLine + 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else if (char === "\r") {
        if (text[index + 1] === "\n") index += 1;
        field += "\n";
        physicalLine += 1;
      } else {
        field += char;
        if (char === "\n") physicalLine += 1;
      }
      continue;
    }

    if (afterQuote && char !== "," && char !== "\r" && char !== "\n") {
      fail("CHZ_CSV_INVALID", recordStartLine);
    }
    if (char === '"') {
      if (fieldStarted) fail("CHZ_CSV_INVALID", recordStartLine);
      inQuotes = true;
      fieldStarted = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      pushRecord();
      physicalLine += 1;
      recordStartLine = physicalLine;
    } else {
      field += char;
      fieldStarted = true;
    }
  }

  if (inQuotes) fail("CHZ_CSV_INVALID", recordStartLine);
  if (fieldStarted || afterQuote || field.length > 0 || cells.length > 0) pushRecord();
  return records;
}

function canonicalArchiveName(name: string): string {
  const normalizedSlashes = name.replaceAll("\\", "/");
  if (
    normalizedSlashes.length === 0 ||
    normalizedSlashes.startsWith("/") ||
    /^[A-Za-z]:/.test(normalizedSlashes) ||
    normalizedSlashes.includes("\0")
  ) {
    fail("CHZ_ZIP_TRAVERSAL");
  }
  const segments = normalizedSlashes.split("/");
  const pathSegments = normalizedSlashes.endsWith("/") ? segments.slice(0, -1) : segments;
  if (pathSegments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("CHZ_ZIP_TRAVERSAL");
  }
  const normalized = posix.normalize(normalizedSlashes);
  if (normalized === ".." || normalized.startsWith("../")) fail("CHZ_ZIP_TRAVERSAL");
  return normalized;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const earliest = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return fail("CHZ_ZIP_INVALID");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function inspectZip(bytes: Uint8Array): ZipEntryMetadata[] {
  if (bytes.length > CHZ_MAX_ARCHIVE_BYTES) fail("CHZ_INPUT_TOO_LARGE");
  if (bytes.length < 22) fail("CHZ_ZIP_INVALID");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount > CHZ_MAX_ARCHIVE_ENTRIES ||
    entryCount === 0 ||
    centralOffset + centralSize > eocd
  ) {
    fail("CHZ_ZIP_INVALID");
  }

  const entries: ZipEntryMetadata[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      fail("CHZ_ZIP_INVALID");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (
      nextOffset > bytes.length ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff
    ) {
      fail("CHZ_ZIP_INVALID");
    }
    if ((flags & 1) !== 0) fail("CHZ_ZIP_ENCRYPTED");
    if (method !== 0 && method !== 8) fail("CHZ_ZIP_UNSUPPORTED_COMPRESSION");
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const originalName = utf8(nameBytes, "CHZ_ZIP_INVALID");
    const canonicalName = canonicalArchiveName(originalName);
    if (names.has(canonicalName)) fail("CHZ_ZIP_INVALID");

    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      fail("CHZ_ZIP_INVALID");
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc32 = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localUncompressedSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localHeaderEnd = localOffset + 30 + localNameLength + localExtraLength;
    if ((localFlags & 1) !== 0) fail("CHZ_ZIP_ENCRYPTED");
    if (localHeaderEnd > bytes.length) fail("CHZ_ZIP_INVALID");
    const localNameBytes = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    const localName = utf8(localNameBytes, "CHZ_ZIP_INVALID");
    canonicalArchiveName(localName);
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localNameLength !== nameLength ||
      localName !== originalName ||
      !sameBytes(localNameBytes, nameBytes)
    ) {
      fail("CHZ_ZIP_INVALID");
    }

    const dataEnd = localHeaderEnd + compressedSize;
    if (dataEnd > centralOffset) fail("CHZ_ZIP_INVALID");
    if ((flags & 0x0008) === 0) {
      if (
        localCrc32 !== crc32 ||
        localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize
      ) {
        fail("CHZ_ZIP_INVALID");
      }
    } else {
      if (localCrc32 !== 0 || localCompressedSize !== 0 || localUncompressedSize !== 0) {
        fail("CHZ_ZIP_INVALID");
      }
      const descriptorEndsAtRecordBoundary = (descriptorEnd: number): boolean =>
        descriptorEnd === centralOffset ||
        (descriptorEnd + 4 <= centralOffset && view.getUint32(descriptorEnd, true) === 0x04034b50);
      const descriptorMatches32 = (descriptorOffset: number): boolean => {
        const descriptorEnd = descriptorOffset + 12;
        return (
          descriptorEnd <= centralOffset &&
          descriptorEndsAtRecordBoundary(descriptorEnd) &&
          view.getUint32(descriptorOffset, true) === crc32 &&
          view.getUint32(descriptorOffset + 4, true) === compressedSize &&
          view.getUint32(descriptorOffset + 8, true) === uncompressedSize
        );
      };
      const descriptorMatches64 = (descriptorOffset: number): boolean => {
        const descriptorEnd = descriptorOffset + 20;
        return (
          descriptorEnd <= centralOffset &&
          descriptorEndsAtRecordBoundary(descriptorEnd) &&
          view.getUint32(descriptorOffset, true) === crc32 &&
          view.getBigUint64(descriptorOffset + 4, true) === BigInt(compressedSize) &&
          view.getBigUint64(descriptorOffset + 12, true) === BigInt(uncompressedSize)
        );
      };
      const hasDescriptorSignature =
        dataEnd + 4 <= centralOffset && view.getUint32(dataEnd, true) === 0x08074b50;
      const descriptorMatches =
        descriptorMatches32(dataEnd) ||
        descriptorMatches64(dataEnd) ||
        (hasDescriptorSignature &&
          (descriptorMatches32(dataEnd + 4) || descriptorMatches64(dataEnd + 4)));
      if (!descriptorMatches) {
        fail("CHZ_ZIP_INVALID");
      }
    }

    names.add(canonicalName);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > CHZ_MAX_UNCOMPRESSED_BYTES) fail("CHZ_ZIP_EXPANSION_LIMIT");
    entries.push({
      originalName,
      canonicalName,
      directory: originalName.endsWith("/"),
      compression: method,
      dataOffset: localHeaderEnd,
      compressedSize,
      uncompressedSize,
    });
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) fail("CHZ_ZIP_INVALID");
  return entries;
}

function unzipBounded(bytes: Uint8Array): {
  entries: ZipEntryMetadata[];
  contents: Map<string, Uint8Array>;
} {
  const entries = inspectZip(bytes);
  const contents = new Map<string, Uint8Array>();
  let actualTotal = 0;
  for (const entry of entries) {
    const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    let content: Uint8Array;
    if (entry.compression === 0) {
      if (compressed.length !== entry.uncompressedSize) fail("CHZ_ZIP_INVALID");
      content = compressed.slice();
    } else {
      content = new Uint8Array(entry.uncompressedSize);
      let offset = 0;
      let finished = false;
      const decoder = new Inflate((chunk, final) => {
        if (offset + chunk.length > content.length) fail("CHZ_ZIP_INVALID");
        content.set(chunk, offset);
        offset += chunk.length;
        finished = final;
      });
      try {
        decoder.push(compressed, true);
      } catch {
        return fail("CHZ_ZIP_INVALID");
      }
      if (!finished || offset !== entry.uncompressedSize) fail("CHZ_ZIP_INVALID");
    }
    actualTotal += content.length;
    if (actualTotal > CHZ_MAX_UNCOMPRESSED_BYTES) fail("CHZ_ZIP_EXPANSION_LIMIT");
    contents.set(entry.canonicalName, content);
  }
  return { entries, contents };
}

function parseZipCsv(bytes: Uint8Array): ChzTabularRecord[] {
  const { entries, contents } = unzipBounded(bytes);
  const members = entries.filter((entry) => !entry.directory);
  if (members.length !== 1) fail("CHZ_ZIP_MEMBER_COUNT");
  const member = members[0]!;
  if (!member.canonicalName.toLowerCase().endsWith(".csv")) fail("CHZ_ZIP_MEMBER_TYPE");
  return parseCsv(contents.get(member.canonicalName)!);
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function decodeXmlText(value: string): string {
  return value.replace(
    /&(?:(lt|gt|amp|quot|apos)|#(\d+)|#[xX]([0-9a-fA-F]+));/g,
    (match: string, name?: string, decimal?: string, hexadecimal?: string) => {
      const named: Readonly<Record<string, string>> = {
        lt: "<",
        gt: ">",
        amp: "&",
        quot: '"',
        apos: "'",
      };
      if (name !== undefined) return named[name] ?? match;
      const codePoint = Number.parseInt(decimal ?? hexadecimal!, decimal === undefined ? 16 : 10);
      if (
        codePoint !== 0x9 &&
        codePoint !== 0xa &&
        codePoint !== 0xd &&
        !(codePoint >= 0x20 && codePoint <= 0xd7ff) &&
        !(codePoint >= 0xe000 && codePoint <= 0xfffd) &&
        !(codePoint >= 0x10000 && codePoint <= 0x10ffff)
      ) {
        return match;
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return decodeXmlText(String(value));
  }
  const object = asObject(value);
  return typeof object["#text"] === "string" ? decodeXmlText(object["#text"]) : "";
}

function parseXml(
  bytes: Uint8Array,
  maxBytes: number,
  code: ChzImportErrorCode,
): Record<string, unknown> {
  if (bytes.length > maxBytes) fail(code);
  const source = utf8(bytes, "CHZ_XLSX_INVALID");
  return parseXmlSource(source);
}

function parseXmlSource(source: string): Record<string, unknown> {
  if (/<!DOCTYPE/i.test(source)) fail("CHZ_XLSX_INVALID");
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    processEntities: false,
    trimValues: false,
  });
  try {
    return asObject(parser.parse(source, true));
  } catch {
    return fail("CHZ_XLSX_INVALID");
  }
}

function asciiIndexOf(bytes: Uint8Array, value: string, start = 0, end = bytes.length): number {
  outer: for (let offset = start; offset + value.length <= end; offset += 1) {
    for (let index = 0; index < value.length; index += 1) {
      if (bytes[offset + index] !== value.charCodeAt(index)) continue outer;
    }
    return offset;
  }
  return -1;
}

function asciiStartsWith(bytes: Uint8Array, value: string, offset: number): boolean {
  return asciiIndexOf(bytes, value, offset, offset + value.length) === offset;
}

function isXmlTagNameBoundary(value: number | undefined): boolean {
  return value === 0x2f || value === 0x3e || (value !== undefined && isXmlWhitespace(value));
}

function xmlOpeningTagIndex(
  bytes: Uint8Array,
  name: string,
  start = 0,
  end = bytes.length,
): number {
  const prefix = `<${name}`;
  let offset = start;
  while (offset < end) {
    const candidate = asciiIndexOf(bytes, prefix, offset, end);
    if (candidate < 0) return -1;
    if (isXmlTagNameBoundary(bytes[candidate + prefix.length])) return candidate;
    offset = candidate + prefix.length;
  }
  return -1;
}

function asciiCaseInsensitiveIndexOf(bytes: Uint8Array, value: string): number {
  const lower = value.toLowerCase();
  outer: for (let offset = 0; offset + lower.length <= bytes.length; offset += 1) {
    for (let index = 0; index < lower.length; index += 1) {
      const byte = bytes[offset + index]!;
      const normalized = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
      if (normalized !== lower.charCodeAt(index)) continue outer;
    }
    return offset;
  }
  return -1;
}

function xmlTagEnd(bytes: Uint8Array, start: number, end: number): number {
  let quote: number | null = null;
  for (let offset = start; offset < end; offset += 1) {
    const value = bytes[offset]!;
    if (quote !== null) {
      if (value === quote) quote = null;
    } else if (value === 0x22 || value === 0x27) {
      quote = value;
    } else if (value === 0x3e) {
      return offset;
    }
  }
  return fail("CHZ_XLSX_INVALID");
}

function isXmlWhitespace(value: number): boolean {
  return value === 0x09 || value === 0x0a || value === 0x0d || value === 0x20;
}

function isSelfClosingXmlTag(bytes: Uint8Array, tagStart: number, tagEnd: number): boolean {
  let offset = tagEnd - 1;
  while (offset > tagStart && isXmlWhitespace(bytes[offset]!)) offset -= 1;
  return bytes[offset] === 0x2f;
}

function worksheetSkeleton(
  bytes: Uint8Array,
): { contentStart: number; contentEnd: number; worksheetOpenTag: string } | null {
  if (bytes.length > CHZ_MAX_WORKSHEET_BYTES) fail("CHZ_WORKSHEET_LIMIT");
  assertUtf8(bytes, "CHZ_XLSX_INVALID");
  const worksheetStart = xmlOpeningTagIndex(bytes, "worksheet");
  if (worksheetStart < 0) fail("CHZ_XLSX_INVALID");
  if (asciiCaseInsensitiveIndexOf(bytes.subarray(0, worksheetStart), "<!DOCTYPE") >= 0) {
    fail("CHZ_XLSX_INVALID");
  }
  const worksheetEnd = xmlTagEnd(bytes, worksheetStart, bytes.length);
  const worksheetOpenTag = utf8(
    bytes.subarray(worksheetStart, worksheetEnd + 1),
    "CHZ_XLSX_INVALID",
  );
  const sheetDataStart = xmlOpeningTagIndex(bytes, "sheetData", worksheetEnd + 1);
  if (sheetDataStart < 0) {
    parseXml(bytes, CHZ_MAX_XML_METADATA_BYTES, "CHZ_XLSX_METADATA_LIMIT");
    return null;
  }
  const sheetDataEnd = xmlTagEnd(bytes, sheetDataStart, bytes.length);
  if (isSelfClosingXmlTag(bytes, sheetDataStart, sheetDataEnd)) {
    parseXml(bytes, CHZ_MAX_XML_METADATA_BYTES, "CHZ_XLSX_METADATA_LIMIT");
    return null;
  }
  const closingStart = asciiIndexOf(bytes, "</sheetData>", sheetDataEnd + 1);
  if (closingStart < 0) fail("CHZ_XLSX_INVALID");

  const prefix = bytes.subarray(0, sheetDataEnd + 1);
  const suffix = bytes.subarray(closingStart);
  if (prefix.length + suffix.length > CHZ_MAX_XML_METADATA_BYTES) {
    fail("CHZ_XLSX_METADATA_LIMIT");
  }
  const skeleton = new Uint8Array(prefix.length + suffix.length);
  skeleton.set(prefix);
  skeleton.set(suffix, prefix.length);
  const worksheet = asObject(
    parseXml(skeleton, CHZ_MAX_XML_METADATA_BYTES, "CHZ_XLSX_METADATA_LIMIT")["worksheet"],
  );
  if (!Object.hasOwn(worksheet, "sheetData")) fail("CHZ_XLSX_INVALID");
  return {
    contentStart: sheetDataEnd + 1,
    contentEnd: closingStart,
    worksheetOpenTag,
  };
}

function richText(value: unknown): string {
  const container = asObject(value);
  if (Object.hasOwn(container, "t")) return textValue(container["t"]);
  return asArray(container["r"])
    .map((run) => textValue(asObject(run)["t"]))
    .join("");
}

function sharedStrings(contents: Map<string, Uint8Array>): string[] {
  const bytes = contents.get("xl/sharedStrings.xml");
  if (bytes === undefined) return [];
  const root = asObject(
    parseXml(bytes, CHZ_MAX_XML_METADATA_BYTES, "CHZ_XLSX_METADATA_LIMIT")["sst"],
  );
  const strings = asArray(root["si"]).map(richText);
  if (strings.length > CHZ_MAX_CELLS) fail("CHZ_CELL_LIMIT");
  for (const value of strings) assertCellLimit(value, 1);
  return strings;
}

function resolveWorksheetPath(target: string): string {
  const withoutLeadingSlash = target.startsWith("/") ? target.slice(1) : target;
  const candidate = target.startsWith("/")
    ? withoutLeadingSlash
    : posix.normalize(posix.join("xl", withoutLeadingSlash));
  const canonical = canonicalArchiveName(candidate);
  if (!canonical.startsWith("xl/worksheets/")) fail("CHZ_XLSX_INVALID");
  return canonical;
}

function firstVisibleWorksheet(contents: Map<string, Uint8Array>): Uint8Array {
  const workbookBytes = contents.get("xl/workbook.xml");
  const relationshipsBytes = contents.get("xl/_rels/workbook.xml.rels");
  if (workbookBytes === undefined || relationshipsBytes === undefined) fail("CHZ_XLSX_INVALID");
  const workbook = asObject(
    parseXml(workbookBytes, CHZ_MAX_XML_METADATA_BYTES, "CHZ_XLSX_METADATA_LIMIT")["workbook"],
  );
  const sheets = asArray(asObject(workbook["sheets"])["sheet"]);
  const visible = sheets.map(asObject).find((sheet) => {
    const state = textValue(sheet["@_state"]);
    return state === "" || state === "visible";
  });
  if (visible === undefined) fail("CHZ_XLSX_NO_VISIBLE_SHEET");
  const relationshipId = textValue(visible["@_r:id"]);
  if (relationshipId === "") fail("CHZ_XLSX_INVALID");
  const relationships = asObject(
    parseXml(relationshipsBytes, CHZ_MAX_XML_METADATA_BYTES, "CHZ_XLSX_METADATA_LIMIT")[
      "Relationships"
    ],
  );
  const relationship = asArray(relationships["Relationship"])
    .map(asObject)
    .find((candidate) => textValue(candidate["@_Id"]) === relationshipId);
  if (relationship === undefined) fail("CHZ_XLSX_INVALID");
  const target = textValue(relationship["@_Target"]);
  const worksheet = contents.get(resolveWorksheetPath(target));
  if (worksheet === undefined) fail("CHZ_XLSX_INVALID");
  return worksheet;
}

function columnIndex(reference: string, rowNumber: number): number {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(reference);
  if (match === null || Number(match[2]) !== rowNumber) fail("CHZ_XLSX_INVALID", rowNumber);
  let result = 0;
  for (const char of match[1]!) result = result * 26 + char.charCodeAt(0) - 64;
  return result - 1;
}

function xlsxCellValue(
  cell: Record<string, unknown>,
  strings: readonly string[],
  rowNumber: number,
): string {
  const hasFormula = Object.hasOwn(cell, "f");
  const hasValue = Object.hasOwn(cell, "v") || Object.hasOwn(cell, "is");
  if (hasFormula && !hasValue) fail("CHZ_XLSX_FORMULA_ONLY", rowNumber);
  const type = textValue(cell["@_t"]);
  let value: string;
  if (type === "inlineStr") {
    value = richText(cell["is"]);
  } else if (type === "s") {
    const rawIndex = textValue(cell["v"]);
    if (!/^\d+$/.test(rawIndex)) fail("CHZ_XLSX_INVALID", rowNumber);
    const shared = strings[Number(rawIndex)];
    if (shared === undefined) fail("CHZ_XLSX_INVALID", rowNumber);
    value = shared;
  } else if (type === "e") {
    return fail("CHZ_XLSX_UNSUPPORTED_CELL", rowNumber);
  } else if (type === "" || type === "str" || type === "n" || type === "b" || type === "d") {
    value = textValue(cell["v"]);
  } else {
    return fail("CHZ_XLSX_UNSUPPORTED_CELL", rowNumber);
  }
  if (hasFormula && value.length === 0) fail("CHZ_XLSX_FORMULA_ONLY", rowNumber);
  assertCellLimit(value, rowNumber);
  return value;
}

interface WorksheetParseState {
  records: ChzTabularRecord[];
  previousRow: number;
  totalCells: number;
}

function appendWorksheetRows(
  rows: readonly unknown[],
  strings: readonly string[],
  state: WorksheetParseState,
): void {
  for (const rawRow of rows) {
    if (state.records.length >= CHZ_MAX_ROWS) fail("CHZ_ROW_LIMIT");
    const row = asObject(rawRow);
    const rowNumber = Number(textValue(row["@_r"]));
    if (!Number.isInteger(rowNumber) || rowNumber <= state.previousRow) {
      fail("CHZ_XLSX_INVALID");
    }
    state.previousRow = rowNumber;
    const cells: string[] = [];
    let previousColumn = -1;
    for (const rawCell of asArray(row["c"])) {
      state.totalCells += 1;
      if (state.totalCells > CHZ_MAX_CELLS) fail("CHZ_CELL_LIMIT", rowNumber);
      const cell = asObject(rawCell);
      const index = columnIndex(textValue(cell["@_r"]), rowNumber);
      if (index <= previousColumn || index >= CHZ_MAX_COLUMNS) fail("CHZ_ROW_WIDTH", rowNumber);
      previousColumn = index;
      while (cells.length < index) cells.push("");
      cells.push(xlsxCellValue(cell, strings, rowNumber));
    }
    state.records.push({ rowNumber, cells });
  }
}

function parseWorksheetBatch(
  source: string,
  worksheetOpenTag: string,
  strings: readonly string[],
  state: WorksheetParseState,
): void {
  const batch = asObject(
    parseXmlSource(`${worksheetOpenTag}<sheetData>${source}</sheetData></worksheet>`)["worksheet"],
  );
  appendWorksheetRows(asArray(asObject(batch["sheetData"])["row"]), strings, state);
}

function parseWorksheet(bytes: Uint8Array, strings: readonly string[]): ChzTabularRecord[] {
  // Parsing a 100+ MiB worksheet as one fast-xml-parser tree takes multiple
  // gigabytes of memory. Validate the workbook skeleton once, then parse only
  // complete row batches while preserving global row and cell limits.
  const skeleton = worksheetSkeleton(bytes);
  if (skeleton === null) return [];

  const state: WorksheetParseState = { records: [], previousRow: 0, totalCells: 0 };
  const batches: string[] = [];
  let batchBytes = 0;
  let cursor = skeleton.contentStart;
  const flush = () => {
    if (batches.length === 0) return;
    parseWorksheetBatch(batches.join(""), skeleton.worksheetOpenTag, strings, state);
    batches.length = 0;
    batchBytes = 0;
  };

  while (cursor < skeleton.contentEnd) {
    while (cursor < skeleton.contentEnd && isXmlWhitespace(bytes[cursor]!)) cursor += 1;
    if (cursor >= skeleton.contentEnd) break;

    if (asciiStartsWith(bytes, "<!--", cursor)) {
      flush();
      const commentEnd = asciiIndexOf(bytes, "-->", cursor + 4, skeleton.contentEnd);
      if (commentEnd < 0) fail("CHZ_XLSX_INVALID");
      if (asciiIndexOf(bytes, "--", cursor + 4, commentEnd) >= 0) fail("CHZ_XLSX_INVALID");
      cursor = commentEnd + 3;
      continue;
    }

    if (xmlOpeningTagIndex(bytes, "row", cursor, cursor + "<row".length + 1) !== cursor) {
      fail("CHZ_XLSX_INVALID");
    }
    const openEnd = xmlTagEnd(bytes, cursor, skeleton.contentEnd);
    let rowEnd: number;
    if (isSelfClosingXmlTag(bytes, cursor, openEnd)) {
      rowEnd = openEnd + 1;
    } else {
      const closingStart = asciiIndexOf(bytes, "</row>", openEnd + 1, skeleton.contentEnd);
      if (closingStart < 0) fail("CHZ_XLSX_INVALID");
      rowEnd = closingStart + "</row>".length;
    }
    const rowSource = utf8(bytes.subarray(cursor, rowEnd), "CHZ_XLSX_INVALID");
    batches.push(rowSource);
    batchBytes += rowEnd - cursor;
    cursor = rowEnd;
    if (batchBytes >= 1024 * 1024 || batches.length >= 512) flush();
  }
  flush();
  return state.records;
}

function parseXlsx(bytes: Uint8Array): ChzTabularRecord[] {
  const { contents } = unzipBounded(bytes);
  return parseWorksheet(firstVisibleWorksheet(contents), sharedStrings(contents));
}

function hasZipSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const third = bytes[2];
  const fourth = bytes[3];
  return (
    (third === 0x03 && fourth === 0x04) ||
    (third === 0x05 && fourth === 0x06) ||
    (third === 0x07 && fourth === 0x08)
  );
}

function containerKind(filename: string, mimeType: string, bytes: Uint8Array): ChzContainerKind {
  const lowerName = filename.toLowerCase();
  const normalizedMime = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const extension = lowerName.endsWith(".xlsx")
    ? "xlsx"
    : lowerName.endsWith(".zip")
      ? "zip"
      : lowerName.endsWith(".csv")
        ? "csv"
        : null;
  if (extension === null) fail("CHZ_UNSUPPORTED_CONTAINER");
  const allowed: Readonly<Record<ChzContainerKind, ReadonlySet<string>>> = {
    csv: new Set(["text/csv", "application/csv", "text/plain", "application/octet-stream"]),
    zip: new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream"]),
    xlsx: new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
    ]),
  };
  if (!allowed[extension].has(normalizedMime)) fail("CHZ_CONTAINER_MISMATCH");
  if ((extension === "zip" || extension === "xlsx") !== hasZipSignature(bytes)) {
    fail("CHZ_CONTAINER_MISMATCH");
  }
  return extension;
}

export function readChzTabular(input: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): ChzTabularDocument {
  if (input.bytes.length > CHZ_MAX_INPUT_BYTES) fail("CHZ_INPUT_TOO_LARGE");
  const kind = containerKind(input.filename, input.mimeType, input.bytes);
  const records =
    kind === "csv"
      ? parseCsv(input.bytes)
      : kind === "zip"
        ? parseZipCsv(input.bytes)
        : parseXlsx(input.bytes);
  return { containerKind: kind, records };
}

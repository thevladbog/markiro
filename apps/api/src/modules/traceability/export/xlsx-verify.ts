import type { WorkbookCell, WorkbookModel, WorkbookSheet } from "@markiro/domain";
import { unzipSync } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const decoder = new TextDecoder("utf-8", { fatal: true });
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});
type XmlObject = Record<string, unknown>;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const lookup = CRC32_TABLE[(crc ^ byte) & 0xff];
    if (lookup === undefined) throw new Error("XLSX ZIP CRC table is incomplete");
    crc = (crc >>> 8) ^ lookup;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Inspect the central directory before decompression; fflate's object map hides duplicates. */
function zipEntries(bytes: Uint8Array): Map<string, number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0)
    throw new Error("XLSX ZIP end record is invalid");
  const entryCount = view.getUint16(end + 10, true);
  const directoryLength = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  if (
    entryCount === 0xffff ||
    directoryLength === 0xffffffff ||
    directoryStart === 0xffffffff ||
    view.getUint16(end + 8, true) !== entryCount ||
    directoryStart + directoryLength !== end
  )
    throw new Error("XLSX ZIP directory is unsupported or inconsistent");
  const entries = new Map<string, number>();
  let cursor = directoryStart;
  let uncompressedTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error("XLSX ZIP directory entry is malformed");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true);
    const uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      (flags !== 0 && flags !== 0x0800) ||
      (method !== 0 && method !== 8) ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      localOffset + 30 > directoryStart ||
      view.getUint32(localOffset, true) !== 0x04034b50 ||
      uncompressed > 128 * 1024 * 1024
    )
      throw new Error("XLSX ZIP entry is unsafe or unsupported");
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localDataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (
      localDataStart + compressed > directoryStart ||
      view.getUint16(localOffset + 6, true) !== flags ||
      view.getUint16(localOffset + 8, true) !== method ||
      decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)) !== name
    )
      throw new Error(`XLSX ZIP local header disagrees with central entry: ${name}`);
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressed = view.getUint32(localOffset + 18, true);
    const localUncompressed = view.getUint32(localOffset + 22, true);
    if (localCrc !== crc || localCompressed !== compressed || localUncompressed !== uncompressed)
      throw new Error(`XLSX ZIP local size or checksum differs from central entry: ${name}`);
    if (entries.has(name)) throw new Error(`XLSX ZIP duplicate entry: ${name}`);
    entries.set(name, crc);
    uncompressedTotal += uncompressed;
    if (uncompressedTotal > MAX_UNCOMPRESSED_BYTES)
      throw new Error("XLSX ZIP exceeds the decompression limit");
    cursor = next;
  }
  if (cursor !== end) throw new Error("XLSX ZIP directory has extra bytes");
  return entries;
}

function object(value: unknown, context: string): XmlObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`XLSX ${context} is missing or malformed`);
  return value as XmlObject;
}
function items(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
function xml(parts: Record<string, Uint8Array>, path: string): XmlObject {
  const bytes = parts[path];
  if (!bytes) throw new Error(`XLSX part missing: ${path}`);
  const source = decoder.decode(bytes);
  if (XMLValidator.validate(source) !== true) throw new Error(`XLSX XML malformed: ${path}`);
  if (/<(?:[\w.-]+:)?f(?:\s|\/|>)/i.test(source))
    throw new Error(`XLSX formula is forbidden: ${path}`);
  return object(parser.parse(source) as unknown, path);
}
interface InternalRelationship {
  readonly type: string;
  readonly target: string;
}
const RELATIONSHIP_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
function relationships(
  parts: Record<string, Uint8Array>,
  path: string,
): Map<string, InternalRelationship> {
  const root = object(xml(parts, path)["Relationships"], `${path} relationships`);
  const result = new Map<string, InternalRelationship>();
  for (const value of items(root["Relationship"])) {
    const relation = object(value, `${path} relationship`);
    const id = relation["@_Id"];
    const type = relation["@_Type"];
    const target = relation["@_Target"];
    if (
      relation["@_TargetMode"] !== undefined ||
      typeof id !== "string" ||
      id.length === 0 ||
      result.has(id) ||
      typeof type !== "string" ||
      typeof target !== "string" ||
      /(?:^[a-z][a-z\d+.-]*:|^\/\/|\\|\.\.)/i.test(target)
    )
      throw new Error(`XLSX relationship is external or malformed: ${path}`);
    result.set(id, { type, target });
  }
  return result;
}
function sharedText(value: unknown): string {
  const si = object(value, "shared string");
  const text = si["t"];
  if (typeof text === "string") return text;
  if (typeof text === "object" && text !== null && !Array.isArray(text)) {
    const content = (text as XmlObject)["#text"];
    if (typeof content === "string") return content;
  }
  throw new Error("XLSX shared string is not plain text");
}
function expectedCell(cell: WorkbookCell): {
  type: "blank" | "string" | "number" | "date";
  value?: string;
} {
  switch (cell.kind) {
    case "blank":
      return { type: "blank" };
    case "text":
      return { type: "string", value: cell.value };
    case "date": {
      const timestamp = Date.parse(`${cell.value}T00:00:00.000Z`);
      if (
        !Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString().slice(0, 10) !== cell.value
      )
        throw new Error("XLSX model has invalid civil date");
      // Excel's 1900 calendar includes the fictitious 1900-02-29.
      return { type: "date", value: String(timestamp / 86_400_000 + 25569) };
    }
    case "number": {
      const significantDigits = cell.sourceValue
        .replace(/^[+-]/, "")
        .replace(".", "")
        .replace(/^0+/, "")
        .replace(/0+$/, "").length;
      return String(cell.value) === cell.sourceValue &&
        significantDigits <= 15 &&
        Math.abs(cell.value) <= Number.MAX_SAFE_INTEGER
        ? { type: "number", value: cell.sourceValue }
        : { type: "string", value: cell.sourceValue };
    }
  }
}
function columnAddress(index: number): string {
  let number = index + 1;
  let letters = "";
  while (number > 0) {
    number -= 1;
    letters = String.fromCharCode(65 + (number % 26)) + letters;
    number = Math.floor(number / 26);
  }
  return letters;
}
function dateStyleIds(parts: Record<string, Uint8Array>): ReadonlySet<string> {
  const root = object(xml(parts, "xl/styles.xml")["styleSheet"], "styles");
  const formats = new Map<string, string>();
  const numFmts = root["numFmts"];
  if (numFmts !== undefined)
    for (const raw of items(object(numFmts, "number formats")["numFmt"])) {
      const format = object(raw, "number format");
      const id = format["@_numFmtId"];
      const code = format["@_formatCode"];
      if (typeof id !== "string" || typeof code !== "string" || formats.has(id))
        throw new Error("XLSX number format is malformed");
      formats.set(id, code);
    }
  const styles = items(object(root["cellXfs"], "cell styles")["xf"]);
  const dates = new Set<string>();
  for (const [index, raw] of styles.entries()) {
    const style = raw === "" ? {} : object(raw, `cell style ${index}`);
    if (
      style["@_applyNumberFormat"] === "1" &&
      formats.get(String(style["@_numFmtId"])) === "yyyy-mm-dd"
    )
      dates.add(String(index));
  }
  return dates;
}
function verifyCell(
  cell: unknown,
  expected: WorkbookCell | { kind: "text"; value: string },
  address: string,
  strings: readonly string[],
  dates: ReadonlySet<string>,
): void {
  const want = expectedCell(expected);
  if (want.type === "blank") {
    if (cell === undefined) return;
    throw new Error(`XLSX unexpected cell at blank ${address}`);
  }
  const actual = object(cell, `cell ${address}`);
  if (actual["@_r"] !== address) throw new Error(`XLSX cell address mismatch at ${address}`);
  if (want.type === "string") {
    if (actual["@_t"] !== "s") throw new Error(`XLSX cell ${address} is not explicit text`);
    const index = Number(actual["v"]);
    if (!Number.isInteger(index) || strings[index] !== want.value)
      throw new Error(`XLSX text mismatch at ${address}`);
    return;
  }
  if (actual["@_t"] !== undefined || actual["v"] !== want.value)
    throw new Error(`XLSX numeric/date value mismatch at ${address}`);
  if (want.type === "date" && !dates.has(String(actual["@_s"])))
    throw new Error(`XLSX date format is missing at ${address}`);
}
function verifySheet(
  root: XmlObject,
  sheet: WorkbookSheet,
  strings: readonly string[],
  dates: ReadonlySet<string>,
): void {
  const worksheet = object(root["worksheet"], `${sheet.name} worksheet`);
  const views = object(worksheet["sheetViews"], `${sheet.name} views`);
  const view = object(views["sheetView"], `${sheet.name} view`);
  const pane = object(view["pane"], `${sheet.name} frozen pane`);
  if (pane["@_state"] !== "frozen" || pane["@_ySplit"] !== "1")
    throw new Error(`XLSX ${sheet.name} header is not frozen`);
  const filter = worksheet["autoFilter"];
  if (sheet.autoFilter) {
    const expectedRange = `A1:${columnAddress(sheet.columns.length - 1)}${sheet.rows.length + 1}`;
    if (object(filter, `${sheet.name} filter`)["@_ref"] !== expectedRange)
      throw new Error(`XLSX ${sheet.name} filter range differs from its data`);
  } else if (filter !== undefined) {
    throw new Error(`XLSX ${sheet.name} has an unexpected filter`);
  }
  const rows = items(object(worksheet["sheetData"], `${sheet.name} data`)["row"]);
  if (rows.length !== sheet.rows.length + 1)
    throw new Error(`XLSX ${sheet.name} row count differs from the model`);
  const sourceColumn = sheet.columns.findIndex((column) => column.key === "source_record");
  for (const [rowIndex, rawRow] of rows.entries()) {
    const row = object(rawRow, `${sheet.name} row ${rowIndex + 1}`);
    if (row["@_r"] !== String(rowIndex + 1))
      throw new Error(`XLSX ${sheet.name} row order differs from the model`);
    const cells = new Map<string, unknown>();
    for (const rawCell of items(row["c"])) {
      const value = object(rawCell, `${sheet.name} cell`);
      const address = value["@_r"];
      if (typeof address !== "string" || cells.has(address))
        throw new Error(`XLSX ${sheet.name} duplicate or missing cell address`);
      cells.set(address, value);
    }
    const expected =
      rowIndex === 0
        ? sheet.columns.map(({ header }) => ({ kind: "text" as const, value: header }))
        : sheet.rows[rowIndex - 1]?.cells;
    if (!expected || expected.length !== sheet.columns.length)
      throw new Error(`XLSX ${sheet.name} model row width differs from headers`);
    if (rowIndex > 0 && sourceColumn >= 0) {
      const source = expected[sourceColumn];
      if (source?.kind !== "text" || source.value !== sheet.rows[rowIndex - 1]?.sourceRecord)
        throw new Error(`XLSX ${sheet.name} source ID differs from frozen provenance`);
    }
    for (const [columnIndex, expectedValue] of expected.entries()) {
      const address = `${columnAddress(columnIndex)}${rowIndex + 1}`;
      verifyCell(cells.get(address), expectedValue, address, strings, dates);
      cells.delete(address);
    }
    if (cells.size !== 0) throw new Error(`XLSX ${sheet.name} contains extra cells`);
  }
}

/** Reject archive hazards and compare serialized rows and values to the frozen model. */
export function verifyUsExportXlsx(bytes: Uint8Array, model: WorkbookModel): void {
  if (bytes.length < 4 || bytes.length > 128 * 1024 * 1024)
    throw new Error("XLSX byte length is outside the supported range");
  const entries = zipEntries(bytes);
  const names = [...entries.keys()];
  const allowed = new Set([
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/_rels/workbook.xml.rels",
    "xl/workbook.xml",
    "xl/styles.xml",
    "xl/sharedStrings.xml",
  ]);
  for (let index = 1; index <= model.sheets.length; index += 1) {
    allowed.add(`xl/worksheets/sheet${index}.xml`);
    allowed.add(`xl/worksheets/_rels/sheet${index}.xml.rels`);
  }
  if (names.length !== allowed.size || names.some((name) => !allowed.has(name)))
    throw new Error("XLSX archive contains an unexpected or forbidden part");
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes);
  } catch {
    throw new Error("XLSX ZIP archive is invalid");
  }
  if (Object.keys(parts).length !== names.length)
    throw new Error("XLSX archive contains an unexpected or forbidden part");
  for (const [name, declaredCrc] of entries) {
    const part = parts[name];
    if (!part || crc32(part) !== declaredCrc)
      throw new Error(`XLSX ZIP CRC differs from extracted part: ${name}`);
  }
  for (const name of names) xml(parts, name);
  const rootRelations = relationships(parts, "_rels/.rels");
  if (
    rootRelations.size !== 1 ||
    ![...rootRelations.values()].some(
      (entry) =>
        entry.type === `${RELATIONSHIP_TYPE}officeDocument` && entry.target === "xl/workbook.xml",
    )
  )
    throw new Error("XLSX root workbook relationship is invalid");
  const workbookRelations = relationships(parts, "xl/_rels/workbook.xml.rels");
  if (workbookRelations.size !== model.sheets.length + 2)
    throw new Error("XLSX workbook relationship count differs from the model");
  const workbook = object(xml(parts, "xl/workbook.xml")["workbook"], "workbook");
  const actualSheets = items(object(workbook["sheets"], "workbook sheets")["sheet"]);
  if (actualSheets.length !== model.sheets.length)
    throw new Error("XLSX sheet count differs from the model");
  for (const [index, sheet] of model.sheets.entries()) {
    const named = object(actualSheets[index], "workbook sheet");
    const relationId = named["@_r:id"];
    if (named["@_name"] !== sheet.name || typeof relationId !== "string")
      throw new Error("XLSX sheet names/order differ from the model");
    const relation = workbookRelations.get(relationId);
    if (
      relation?.type !== `${RELATIONSHIP_TYPE}worksheet` ||
      relation.target !== `worksheets/sheet${index + 1}.xml`
    )
      throw new Error(`XLSX ${sheet.name} worksheet relationship does not match its tab`);
    workbookRelations.delete(relationId);
    if (relationships(parts, `xl/worksheets/_rels/sheet${index + 1}.xml.rels`).size !== 0)
      throw new Error(`XLSX ${sheet.name} has an unexpected worksheet relationship`);
  }
  const remaining = [...workbookRelations.values()];
  if (
    remaining.length !== 2 ||
    !remaining.some(
      (entry) =>
        entry.type === `${RELATIONSHIP_TYPE}sharedStrings` && entry.target === "sharedStrings.xml",
    ) ||
    !remaining.some(
      (entry) => entry.type === `${RELATIONSHIP_TYPE}styles` && entry.target === "styles.xml",
    )
  )
    throw new Error("XLSX workbook support relationships are invalid");
  const shared = object(xml(parts, "xl/sharedStrings.xml")["sst"], "shared strings");
  const strings = items(shared["si"]).map(sharedText);
  const dates = dateStyleIds(parts);
  for (const [index, sheet] of model.sheets.entries())
    verifySheet(xml(parts, `xl/worksheets/sheet${index + 1}.xml`), sheet, strings, dates);
}

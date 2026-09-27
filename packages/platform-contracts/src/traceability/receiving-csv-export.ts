import { z } from "zod";
import { receivingLiveRecordSchema, type ReceivingLiveRecord } from "./receiving-live-records.js";

export const RECEIVING_CSV_EXPORT_VERSION = "markiro-receiving-export-v1";
export const RECEIVING_CSV_EXPORT_COLUMNS = [
  "format_version",
  "row_type",
  "event_id",
  "revision",
  "draft_version",
  "lifecycle_version",
  "status",
  "content_kind",
  "ordinal",
  "product_id",
  "lot_id",
  "tlc",
  "quantity",
  "unit_of_measure",
  "supplier_lot_reference",
  "source_kind",
  "source_location_id",
  "source_reference_url",
  "source_resolved_location_id",
  "document_id",
  "payload",
] as const;

const maxCell = 32_767;
const maxBytes = 16 * 1024 * 1024;
const maxDataRows = 201;
const maxVersion = 2_147_483_647;
const versionText = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(maxVersion));
export const receivingCsvExportQuerySchema = z
  .object({
    expectedDraftVersion: versionText,
    expectedLifecycleVersion: versionText,
  })
  .strict();

export type ReceivingCsvExportErrorCode = "export_value_too_large" | "invalid_export";
export class ReceivingCsvExportError extends Error {
  constructor(
    readonly code: ReceivingCsvExportErrorCode,
    readonly row?: number,
    readonly column?: string,
  ) {
    super(code);
    this.name = "ReceivingCsvExportError";
  }
}

function invalid(): never {
  throw new ReceivingCsvExportError("invalid_export");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

function withoutKeys<T extends object>(value: T, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function escapedCodePoint(value: string): string {
  return [...value]
    .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join("");
}

function escapeText(value: string): string {
  return value.replace(/[\\\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, (character) => {
    if (character === "\\") return "\\\\";
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return escapedCodePoint(character);
  });
}

function unescapeText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escape = value[++index];
    if (escape === "\\") result += "\\";
    else if (escape === "n") result += "\n";
    else if (escape === "r") result += "\r";
    else if (escape === "t") result += "\t";
    else if (escape === "u") {
      const digits = value.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/.test(digits)) invalid();
      result += String.fromCharCode(Number.parseInt(digits, 16));
      index += 4;
    } else invalid();
  }
  if (escapeText(result) !== value) invalid();
  return result;
}

function cell(value: string | number | null | undefined): string {
  if (value === undefined) return "absent:";
  if (value === null) return "null:";
  return `text:${escapeText(String(value))}`;
}

function payload(value: unknown): string {
  return `json:${escapeText(JSON.stringify(canonical(value)))}`;
}

function quoted(value: string, row: number, column: string): string {
  if (value.length > maxCell)
    throw new ReceivingCsvExportError("export_value_too_large", row, column);
  return `"${value.replaceAll('"', '""')}"`;
}

function row(values: readonly string[], rowNumber: number): string {
  if (values.length !== RECEIVING_CSV_EXPORT_COLUMNS.length) invalid();
  return values
    .map((value, index) => quoted(value, rowNumber, RECEIVING_CSV_EXPORT_COLUMNS[index] ?? ""))
    .join(",");
}

function fields(record: ReceivingLiveRecord, kind: "record" | "item" | "document") {
  return [
    cell(RECEIVING_CSV_EXPORT_VERSION),
    cell(kind),
    cell(record.id),
    cell(record.revision),
    cell(record.draftVersion),
    cell(record.lifecycle.lifecycleVersion),
    cell(record.status),
    cell(record.content.kind),
  ];
}

type DraftContent = Extract<ReceivingLiveRecord["content"], { kind: "draft" }>;
type FinalizedContent = Extract<ReceivingLiveRecord["content"], { kind: "finalized" }>;
type SavedItem =
  DraftContent["draft"]["items"][number] | FinalizedContent["snapshot"]["items"][number];
type SavedDocument = string | FinalizedContent["snapshot"]["documents"][number];

function itemFields(item: SavedItem) {
  const source = item.source;
  return [
    cell(item.productId),
    cell(item.lotId),
    cell(item.tlc),
    cell(item.quantity),
    cell(item.unitOfMeasure),
    cell(item.supplierLotReference),
    cell(source?.kind),
    cell(source?.kind === "location" ? source.locationId : undefined),
    cell(source?.kind === "reference" ? source.referenceValue : undefined),
    cell(source?.kind === "reference" ? source.resolvedLocationId : undefined),
  ];
}

/** Returns original generated bytes. Never applies the supplier input parser. */
export function encodeReceivingCsvExport(
  record: ReceivingLiveRecord,
  capturedAt: string,
): Uint8Array {
  const saved = receivingLiveRecordSchema.parse(record);
  if (!z.iso.datetime().safeParse(capturedAt).success) invalid();
  let items: SavedItem[];
  let documents: SavedDocument[];
  let bareRecord: unknown;
  if (saved.content.kind === "draft") {
    items = saved.content.draft.items;
    documents = saved.content.draft.documentIds;
    const draft = withoutKeys(saved.content.draft, ["items", "documentIds"]);
    bareRecord = { ...saved, content: { ...saved.content, draft } };
  } else {
    items = saved.content.snapshot.items;
    documents = saved.content.snapshot.documents;
    const snapshot = withoutKeys(saved.content.snapshot, ["items", "documents"]);
    bareRecord = { ...saved, content: { ...saved.content, snapshot } };
  }
  const data: string[] = [];
  data.push(
    row(
      [
        ...fields(saved, "record"),
        cell(undefined),
        ...Array.from({ length: 11 }, () => cell(undefined)),
        payload({ capturedAt, record: bareRecord }),
      ],
      1,
    ),
  );
  items.forEach((item, index) => {
    data.push(
      row(
        [
          ...fields(saved, "item"),
          cell(index + 1),
          ...itemFields(item),
          cell(undefined),
          payload(item),
        ],
        data.length + 1,
      ),
    );
  });
  documents.forEach((document, index) => {
    data.push(
      row(
        [
          ...fields(saved, "document"),
          cell(index + 1),
          ...Array.from({ length: 10 }, () => cell(undefined)),
          cell(typeof document === "string" ? document : document.document.documentId),
          payload(document),
        ],
        data.length + 1,
      ),
    );
  });
  if (data.length > maxDataRows) throw new ReceivingCsvExportError("export_value_too_large");
  const header = RECEIVING_CSV_EXPORT_COLUMNS.map((column) => quoted(column, 0, column)).join(",");
  const bytes = new TextEncoder().encode(`\uFEFF${header}\r\n${data.join("\r\n")}\r\n`);
  if (bytes.byteLength > maxBytes) throw new ReceivingCsvExportError("export_value_too_large");
  return bytes;
}

function parseRow(line: string): string[] {
  const result: string[] = [];
  let index = 0;
  while (index < line.length) {
    if (line[index++] !== '"') invalid();
    let value = "";
    let closed = false;
    while (index < line.length) {
      const character = line[index++];
      if (character === '"') {
        if (line[index] === '"') {
          value += '"';
          index++;
        } else {
          closed = true;
          break;
        }
      } else value += character;
      if (value.length > maxCell) invalid();
    }
    if (!closed) invalid();
    result.push(value);
    if (index === line.length) break;
    if (line[index++] !== ",") invalid();
    if (index === line.length) invalid();
  }
  return result;
}

function decodePayload(encoded: string): unknown {
  if (!encoded.startsWith("json:")) invalid();
  try {
    return JSON.parse(unescapeText(encoded.slice(5)));
  } catch {
    return invalid();
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Strict canonical decoder for integrity checks; never a business-record importer. */
export function decodeReceivingCsvExport(bytes: Uint8Array): {
  record: ReceivingLiveRecord;
  capturedAt: string;
} {
  if (bytes.byteLength > maxBytes || bytes.byteLength < 4) invalid();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalid();
  }
  if (!text.startsWith("\uFEFF") || text.startsWith("\uFEFF\uFEFF") || !text.endsWith("\r\n"))
    invalid();
  const lines = text.slice(1, -2).split("\r\n");
  if (lines.length < 2 || lines.length > maxDataRows + 1) invalid();
  const parsed = lines.map(parseRow);
  if (parsed.some((line) => line.length !== RECEIVING_CSV_EXPORT_COLUMNS.length)) invalid();
  if (RECEIVING_CSV_EXPORT_COLUMNS.some((column, index) => parsed[0]?.[index] !== column))
    invalid();
  const data = parsed.slice(1);
  const [first, ...rest] = data;
  if (!first || first[1] !== "text:record") invalid();
  const envelope = decodePayload(first[20] ?? "");
  if (
    !isObject(envelope) ||
    Object.keys(envelope).length !== 2 ||
    typeof envelope.capturedAt !== "string" ||
    !isObject(envelope.record)
  )
    invalid();
  const bare = envelope.record;
  const content = bare.content;
  if (!isObject(content)) invalid();
  const itemRows: unknown[] = [];
  const documentRows: unknown[] = [];
  let inDocuments = false;
  for (const current of rest) {
    if (!current) invalid();
    if (current[1] === "text:item" && !inDocuments) itemRows.push(decodePayload(current[20] ?? ""));
    else if (current[1] === "text:document") {
      inDocuments = true;
      documentRows.push(decodePayload(current[20] ?? ""));
    } else invalid();
  }
  let restored: unknown;
  if (content.kind === "draft" && isObject(content.draft)) {
    if ("items" in content.draft || "documentIds" in content.draft) invalid();
    restored = {
      ...bare,
      content: {
        ...content,
        draft: { ...content.draft, items: itemRows, documentIds: documentRows },
      },
    };
  } else if (content.kind === "finalized" && isObject(content.snapshot)) {
    if ("items" in content.snapshot || "documents" in content.snapshot) invalid();
    restored = {
      ...bare,
      content: {
        ...content,
        snapshot: { ...content.snapshot, items: itemRows, documents: documentRows },
      },
    };
  } else invalid();
  const result = receivingLiveRecordSchema.safeParse(restored);
  if (!result.success) invalid();
  let canonicalBytes: Uint8Array;
  try {
    canonicalBytes = encodeReceivingCsvExport(result.data, envelope.capturedAt);
  } catch {
    return invalid();
  }
  if (!sameBytes(bytes, canonicalBytes)) invalid();
  return { record: result.data, capturedAt: envelope.capturedAt };
}

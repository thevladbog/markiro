export const RECEIVING_CSV_VERSION = "markiro-receiving-v1";
export const RECEIVING_CSV_COLUMNS = [
  "product_id",
  "product_gtin",
  "lot_link_mode",
  "lot_id",
  "tlc",
  "source_kind",
  "source_location_id",
  "source_reference_url",
  "source_resolved_location_id",
  "quantity",
  "unit_of_measure",
  "exempt_supplier",
  "exempt_reason",
  "exempt_evidence_url",
  "exempt_tlc_handling",
  "proposed_tlc",
  "supplier_lot_reference",
  "notes",
] as const;
export type ReceivingCsvColumn = (typeof RECEIVING_CSV_COLUMNS)[number];
export type ReceivingCsvFileErrorCode =
  "version" | "byte_limit" | "invalid_utf8" | "nul" | "syntax" | "header" | "no_rows" | "row_limit";
export interface ReceivingCsvRawRow {
  rowNumber: number;
  lineNumber: number;
  cells: string[];
  issues: { code: "column_count" }[];
}
export type ReceivingCsvParseResult =
  | { ok: true; rows: ReceivingCsvRawRow[] }
  | { ok: false; error: { code: ReceivingCsvFileErrorCode; lineNumber: number } };

/** Pure bounded syntax decoder. Success does not mean row validity or permission to apply. */
export function parseReceivingCsv(
  bytes: Uint8Array,
  templateVersion: string,
): ReceivingCsvParseResult {
  const fail = (code: ReceivingCsvFileErrorCode, lineNumber = 1): ReceivingCsvParseResult => ({
    ok: false,
    error: { code, lineNumber },
  });
  if (templateVersion !== RECEIVING_CSV_VERSION) return fail("version");
  if (bytes.byteLength > 256 * 1024) return fail("byte_limit");
  let text: string;
  try {
    // Retain BOM here so exactly one may be removed explicitly below.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("invalid_utf8");
  }
  if (text.startsWith("\ufeff")) text = text.slice(1);
  if (text.includes("\0")) return fail("nul");
  if (!text.length) return fail("no_rows");
  const records: { cells: string[]; lineNumber: number }[] = [];
  let cells: string[] = [];
  let cell = "";
  let state: "start" | "unquoted" | "quoted" | "closed" = "start";
  let lineNumber = 1;
  let startLine = 1;
  const endCell = () => {
    cells.push(cell);
    cell = "";
    state = "start";
  };
  const endRecord = () => {
    endCell();
    records.push({ cells, lineNumber: startLine });
    cells = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\r" && text[index + 1] !== "\n") return fail("syntax", lineNumber);
    if (char === "\n" || char === "\r") {
      const newline = char === "\r" ? "\r\n" : "\n";
      if (char === "\r") index++;
      if (state === "quoted") cell += newline;
      else endRecord();
      lineNumber++;
      if (state !== "quoted") startLine = lineNumber;
    } else if (char === '"') {
      if (state === "start") state = "quoted";
      else if (state === "quoted") {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else state = "closed";
      } else return fail("syntax", lineNumber);
    } else if (state === "quoted") cell += char;
    else if (char === ",") endCell();
    else {
      if (state === "closed") return fail("syntax", lineNumber);
      cell += char;
      state = "unquoted";
    }
    if (records.length > 101) return fail("row_limit", startLine);
  }
  if (state === "quoted") return fail("syntax", lineNumber);
  if (state !== "start" || cells.length > 0 || cell.length > 0) endRecord();
  const [header, ...data] = records;
  if (
    !header ||
    header.cells.length !== RECEIVING_CSV_COLUMNS.length ||
    RECEIVING_CSV_COLUMNS.some((column, index) => header.cells[index] !== column)
  )
    return fail("header");
  if (!data.length) return fail("no_rows");
  if (data.length > 100) return fail("row_limit", data[100]?.lineNumber ?? lineNumber);
  return {
    ok: true,
    rows: data.map((record, index) => ({
      ...record,
      rowNumber: index + 1,
      issues:
        record.cells.length === RECEIVING_CSV_COLUMNS.length ? [] : [{ code: "column_count" }],
    })),
  };
}

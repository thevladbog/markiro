import { createHash } from "node:crypto";
import type { Blob } from "node:buffer";
import type Stream from "node:stream";
import type { WorkbookCell, WorkbookModel, WorkbookRow, WorkbookSheet } from "@markiro/domain";
import { unzipSync, zipSync } from "fflate";
import writeExcelFile, { type Feature, type Row, type Sheet } from "write-excel-file/node";
import {
  getCellAddress,
  getOrderOfSiblings,
  getSelfClosingTagMarkup,
  insertElementMarkupAccordingToOrderOfSiblings,
} from "write-excel-file/utility";
import { verifyUsExportXlsx } from "./xlsx-verify";

type WriterFileContent = Stream | Buffer | Blob;

export interface UsExportXlsxFailure {
  readonly code: "XLSX_RENDER_FAILED";
  readonly sourceRecord: string;
  readonly fieldKey: string;
}

export class UsExportXlsxError extends Error {
  constructor(
    readonly failure: UsExportXlsxFailure,
    message: string,
  ) {
    super(message);
    this.name = "UsExportXlsxError";
  }
}

const unsupported = (sourceRecord: string, fieldKey: string, detail: string): never => {
  throw new UsExportXlsxError({ code: "XLSX_RENDER_FAILED", sourceRecord, fieldKey }, detail);
};

function safeText(value: string, sourceRecord: string, fieldKey: string): string {
  if (value.length > 32767)
    unsupported(sourceRecord, fieldKey, "XLSX cell exceeds 32767 characters");
  for (const character of value) {
    const point = character.codePointAt(0);
    if (
      point === undefined ||
      (point < 32 && point !== 9 && point !== 10 && point !== 13) ||
      (point >= 0xd800 && point <= 0xdfff) ||
      point === 0xfffe ||
      point === 0xffff
    )
      unsupported(sourceRecord, fieldKey, "XLSX cell contains an unsupported character");
  }
  return value;
}

function safeDate(value: string, sourceRecord: string, fieldKey: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) unsupported(sourceRecord, fieldKey, "Invalid civil date");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    unsupported(sourceRecord, fieldKey, "Invalid civil date");
  // The chosen writer uses the 1900 date system's post-leap-bug offset.
  if (value < "1900-03-01")
    unsupported(sourceRecord, fieldKey, "Civil date predates the writer's exact Excel date range");
  return date;
}

function cellValue(cell: WorkbookCell, row: WorkbookRow, fieldKey: string): Row[number] {
  switch (cell.kind) {
    case "blank":
      return null;
    case "text":
      return { value: safeText(cell.value, row.sourceRecord, fieldKey), type: String };
    case "date":
      return {
        value: safeDate(cell.value, row.sourceRecord, fieldKey),
        type: Date,
        format: "yyyy-mm-dd",
      };
    case "number": {
      if (
        !Number.isFinite(cell.value) ||
        !/^[+-]?\d+(?:\.\d+)?$/.test(cell.sourceValue) ||
        Number(cell.sourceValue) !== cell.value
      )
        unsupported(row.sourceRecord, fieldKey, "Numeric source value and model number disagree");
      safeText(cell.sourceValue, row.sourceRecord, fieldKey);
      // Excel numeric <v> stores `String(number)`, which drops scale/leading zeros.
      // A lexical mismatch is represented as an explicit string, not rounded.
      const significantDigits = cell.sourceValue
        .replace(/^[+-]/, "")
        .replace(".", "")
        .replace(/^0+/, "")
        .replace(/0+$/, "").length;
      if (
        String(cell.value) !== cell.sourceValue ||
        significantDigits > 15 ||
        Math.abs(cell.value) > Number.MAX_SAFE_INTEGER
      )
        return { value: cell.sourceValue, type: String };
      return { value: cell.value, type: Number };
    }
  }
}

function writerSheet(sheet: WorkbookSheet): Sheet<WriterFileContent> {
  const sourceColumn = sheet.columns.findIndex((column) => column.key === "source_record");
  const data: Row[] = [
    sheet.columns.map((column) => ({
      value: safeText(column.header, `header:${sheet.name}`, column.key),
      type: String,
    })),
    ...sheet.rows.map((row) => {
      if (row.cells.length !== sheet.columns.length)
        unsupported(row.sourceRecord, "row", "XLSX row width differs from the model headers");
      if (
        sourceColumn >= 0 &&
        (row.cells[sourceColumn]?.kind !== "text" ||
          row.cells[sourceColumn]?.value !== row.sourceRecord)
      )
        unsupported(
          row.sourceRecord,
          "source_record",
          "XLSX source ID differs from frozen row provenance",
        );
      return row.cells.map((cell, index) =>
        cellValue(cell, row, sheet.columns[index]?.key ?? "unknown"),
      );
    }),
  ];
  return {
    sheet: sheet.name,
    data,
    stickyRowsCount: sheet.freezeHeader ? 1 : 0,
    dateFormat: "yyyy-mm-dd",
  };
}

function verifiedAutoFilterFeature(model: WorkbookModel): Feature<WriterFileContent> {
  const order =
    getOrderOfSiblings("xl/worksheets/sheet{id}.xml", "worksheet") ??
    unsupported("workbook", "auto_filter", "Writer has no worksheet element order");
  return {
    files: {
      transform: {
        "xl/worksheets/sheet{id}.xml": {
          transform(xml, _options, { sheetIndex }) {
            const sheet = model.sheets[sheetIndex];
            if (!sheet?.autoFilter) return xml;
            if (sheet.columns.length === 0)
              unsupported(`header:${sheet.name}`, "auto_filter", "Cannot filter an empty header");
            const last = getCellAddress(sheet.rows.length, sheet.columns.length - 1);
            const ref = `A1:${last}`;
            return insertElementMarkupAccordingToOrderOfSiblings(
              xml,
              getSelfClosingTagMarkup("autoFilter", { ref }),
              order,
              "worksheet",
            );
          },
        },
      },
    },
  };
}

/** Render only an already-validated immutable model; no catalog, clock or network reads. */
export async function renderUsExportXlsx(
  model: WorkbookModel,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  if (model.sheets.length === 0) unsupported("workbook", "sheets", "XLSX model has no sheets");
  try {
    const sheets = model.sheets.map(writerSheet);
    const writerBytes = new Uint8Array(
      await writeExcelFile(sheets, { features: [verifiedAutoFilterFeature(model)] }).toBuffer(),
    );
    // The Node writer stamps ZIP entries with wall time. Re-archive only its
    // generated parts with fixed metadata; no cell/source XML is transformed.
    const bytes = zipSync(unzipSync(writerBytes), {
      mtime: new Date("1980-01-01T00:00:00.000Z"),
      level: 6,
    });
    verifyUsExportXlsx(bytes, model);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error instanceof UsExportXlsxError) throw error;
    return unsupported(
      "workbook",
      "render",
      error instanceof Error ? error.message : "XLSX render failed",
    );
  }
}

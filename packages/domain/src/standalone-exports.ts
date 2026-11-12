import { strToU8, zipSync } from "fflate";

import { encodeSemicolonCsv } from "./document-text-encoding.js";
import { DomainError } from "./errors.js";
import { formatGismtAggregationCis, GismtAggregationError } from "./gismt-aggregation.js";
import { formatSsccWithAi } from "./gs1/sscc.js";
import {
  sanitizeShiftExportFilenameSegment,
  ShiftExportDomainError,
  type ShiftExportPart,
} from "./shift-exports.js";

export const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME_TYPE = "text/csv; charset=utf-8";
const UNF_HEADER = ["Штрихкод или код маркировки", "Код упаковки"];

export const STANDALONE_SHIFT_EXPORT_FORMATS = [
  { id: "shift_csv_unf_all", label: "[1C][csv] Общая выгрузка", version: 1 },
  { id: "shift_csv_unf_box_codes", label: "[1C][csv] Выгрузка Короба - Коды", version: 1 },
  { id: "shift_csv_unf_pallet_boxes", label: "[1C][csv] Выгрузка Палеты - Короба", version: 1 },
] as const;

export const STANDALONE_SET_EXPORT_FORMATS = [
  { id: "shift_csv_unf_set_items", label: "[1C][csv] Выгрузка Наборы - Коды", version: 1 },
  { id: "shift_xlsx_chz_set_registry", label: "[ЧЗ][xlsx] Реестр наборов", version: 1 },
] as const;

export type StandaloneShiftExportFormat = (typeof STANDALONE_SHIFT_EXPORT_FORMATS)[number];
export type StandaloneSetExportFormat = (typeof STANDALONE_SET_EXPORT_FORMATS)[number];
type StandaloneExportFormat = StandaloneShiftExportFormat | StandaloneSetExportFormat;
export type StandaloneExportPart = Omit<ShiftExportPart, "mimeType"> & {
  mimeType: ShiftExportPart["mimeType"] | typeof XLSX_MIME_TYPE;
};

export function getStandaloneExportFormat(
  id: string,
  version: number,
): StandaloneExportFormat | undefined {
  return [...STANDALONE_SHIFT_EXPORT_FORMATS, ...STANDALONE_SET_EXPORT_FORMATS].find(
    (format) => format.id === id && format.version === version,
  );
}

export interface StandaloneUnfSource {
  boxes: readonly { sscc: string; codes: readonly string[] }[];
  pallets: readonly { sscc: string; boxSsccs: readonly string[] }[];
}

export interface StandaloneExportSet {
  code: string;
  items: readonly string[];
}

export function renderStandaloneUnfExport(
  format: StandaloneShiftExportFormat,
  shiftNumber: string,
  source: StandaloneUnfSource,
): StandaloneExportPart {
  const boxes = source.boxes.map(({ sscc, codes }) => ({ sscc: exportSscc(sscc), codes }));
  const productRows = boxes.flatMap(({ sscc, codes }) => codes.map((code) => [code, sscc]));
  const palletRows = source.pallets.flatMap(({ sscc, boxSsccs }) => {
    const parent = exportSscc(sscc);
    return boxSsccs.map((box) => [exportSscc(box), parent] as const);
  });
  const boxCount = new Set([...boxes.map(({ sscc }) => sscc), ...palletRows.map(([box]) => box)])
    .size;
  return csvPart(format, shiftNumber, [...productRows, ...palletRows], {
    codeCount: productRows.length,
    boxCount,
    palletCount: source.pallets.length,
  });
}

export function renderStandaloneSetExport(
  formatId: StandaloneSetExportFormat["id"],
  shiftNumber: string,
  sets: readonly StandaloneExportSet[],
): StandaloneExportPart {
  const counts = {
    codeCount: sets.reduce((count, set) => count + set.items.length, 0),
    boxCount: 0,
    palletCount: 0,
  };
  if (formatId === "shift_csv_unf_set_items") {
    return csvPart(
      STANDALONE_SET_EXPORT_FORMATS[0],
      shiftNumber,
      sets.flatMap(({ code, items }) => items.map((item) => [item, code])),
      counts,
    );
  }
  const rows = [
    ["Код идентификации набора", "Код идентификации вложения"],
    ...sets.flatMap(({ code, items }) => {
      const setCis = identificationCode(code);
      return items.map((item) => [setCis, identificationCode(item)]);
    }),
  ];
  return {
    ...counts,
    partNumber: 1,
    physicalLineCount: rows.length,
    filename: exportFilename(STANDALONE_SET_EXPORT_FORMATS[1], shiftNumber, "xlsx"),
    mimeType: XLSX_MIME_TYPE,
    bytes: registryWorkbook(rows),
  };
}

function csvPart(
  format: StandaloneExportFormat,
  shiftNumber: string,
  rows: readonly (readonly string[])[],
  counts: Pick<StandaloneExportPart, "codeCount" | "boxCount" | "palletCount">,
): StandaloneExportPart {
  return {
    ...counts,
    partNumber: 1,
    physicalLineCount: rows.length + 1,
    filename: exportFilename(format, shiftNumber, "csv"),
    mimeType: CSV_MIME_TYPE,
    bytes: encodeSemicolonCsv(UNF_HEADER, rows),
  };
}

function exportFilename(
  format: StandaloneExportFormat,
  shiftNumber: string,
  extension: string,
): string {
  return `${sanitizeShiftExportFilenameSegment(shiftNumber)}_${sanitizeShiftExportFilenameSegment(format.label)}.${extension}`;
}

function exportSscc(value: string): string {
  try {
    return formatSsccWithAi(value);
  } catch (error) {
    if (error instanceof DomainError) throw new ShiftExportDomainError("INVALID_BOX_SSCC");
    throw error;
  }
}

function identificationCode(value: string): string {
  try {
    return formatGismtAggregationCis(value);
  } catch (error) {
    if (error instanceof GismtAggregationError) throw new ShiftExportDomainError("INVALID_CIS");
    throw error;
  }
}

const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function registryWorkbook(rows: readonly (readonly string[])[]): Uint8Array {
  const sheetRows = rows.map((cells, index) => {
    const row = index + 1;
    const content = cells
      .map(
        (value, column) =>
          `<c r="${column === 0 ? "A" : "B"}${row}" t="inlineStr"><is><t>${spreadsheetText(value)}</t></is></c>`,
      )
      .join("");
    return `<row r="${row}">${content}</row>`;
  });
  const contentTypes = [
    `<Types xmlns="${CONTENT_TYPES_NS}">`,
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    "</Types>",
  ].join("");
  const rootRels =
    `<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook =
    `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}">` +
    '<sheets><sheet name="Реестр наборов" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const workbookRels =
    `<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const sheet =
    `<worksheet xmlns="${SHEET_NS}"><cols><col min="1" max="2" width="37" customWidth="1"/></cols>` +
    `<sheetData>${sheetRows.join("")}</sheetData></worksheet>`;

  return zipSync(
    {
      "[Content_Types].xml": strToU8(XML + contentTypes),
      "_rels/.rels": strToU8(XML + rootRels),
      "xl/workbook.xml": strToU8(XML + workbook),
      "xl/_rels/workbook.xml.rels": strToU8(XML + workbookRels),
      "xl/worksheets/sheet1.xml": strToU8(XML + sheet),
    },
    { mtime: new Date(1980, 0, 1) },
  );
}

function spreadsheetText(value: string): string {
  return value
    .replace(/_x[0-9a-f]{4}_/gi, (escape) => `_x005F_${escape.slice(1)}`)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

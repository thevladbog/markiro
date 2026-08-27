import { encodeLfText, encodeSemicolonCsv } from "./document-text-encoding.js";
import {
  GISMT_AGGREGATION_OVERHEAD_LINE_COUNT,
  GismtAggregationError,
  formatGismtAggregationSscc,
  gismtAggregationBoxLineCount,
  renderGismtAggregationXml,
  type GismtAggregationBox,
  type GismtAggregationRenderResult,
} from "./gismt-aggregation.js";

export type ShiftExportFormatId =
  | "shift_txt_flat"
  | "shift_txt_boxes"
  | "shift_csv_flat"
  | "shift_csv_boxes"
  | "shift_xml_gismt_aggregation";

export type ShiftExportBoxMode = "flat" | "boxes";

export interface ShiftExportFormatDescriptor {
  id: ShiftExportFormatId;
  version: 1 | 2;
  label: string;
  extension: "txt" | "csv" | "xml";
  mimeType:
    "text/plain; charset=utf-8" | "text/csv; charset=utf-8" | "application/xml; charset=utf-8";
  boxMode: ShiftExportBoxMode;
}

export type ShiftExportSource =
  | { mode: "flat"; codes: readonly string[] }
  | { mode: "boxes"; boxes: readonly { sscc: string; codes: readonly string[] }[] };

export interface RenderShiftExportInput {
  formatId: ShiftExportFormatId;
  formatVersion: number;
  productName: string;
  shiftDate: string;
  maxLines: number | null;
  source: ShiftExportSource;
  /** Tenant's tax id (ИНН); required by the GISMT aggregation XML (`LP_TIN`). */
  organizationInn?: string | null;
}

export interface ShiftExportPart {
  partNumber: number;
  physicalLineCount: number;
  codeCount: number;
  boxCount: number;
  filename: string;
  mimeType: ShiftExportFormatDescriptor["mimeType"];
  bytes: Uint8Array;
}

export type ShiftExportDomainErrorCode =
  | "FORMAT_NOT_FOUND"
  | "FORMAT_SOURCE_MISMATCH"
  | "EMPTY_SOURCE"
  | "INVALID_LINE_LIMIT"
  | "BOX_EXCEEDS_LINE_LIMIT"
  | "INVALID_BOX_SSCC"
  | "INVALID_CIS"
  | "ORG_INN_MISSING";

export class ShiftExportDomainError extends Error {
  constructor(readonly code: ShiftExportDomainErrorCode) {
    super(code);
    this.name = "ShiftExportDomainError";
  }
}

export const SHIFT_EXPORT_FORMATS = Object.freeze([
  Object.freeze({
    id: "shift_txt_flat",
    version: 1,
    label: "[TXT][Без коробов] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "flat",
  } as const),
  Object.freeze({
    id: "shift_txt_boxes",
    version: 2,
    label: "[TXT][С коробами] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "boxes",
  } as const),
  Object.freeze({
    id: "shift_csv_flat",
    version: 1,
    label: "[CSV][Без коробов] Отчет смены",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    boxMode: "flat",
  } as const),
  Object.freeze({
    id: "shift_csv_boxes",
    version: 2,
    label: "[CSV][С коробами] Отчет смены",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    boxMode: "boxes",
  } as const),
  Object.freeze({
    id: "shift_xml_gismt_aggregation",
    version: 1,
    label: "[XML][ГИСМТ] Отчет об агрегации",
    extension: "xml",
    mimeType: "application/xml; charset=utf-8",
    boxMode: "boxes",
  } as const),
] as const satisfies readonly ShiftExportFormatDescriptor[]);

/**
 * Frozen v1 descriptors for the boxes formats: version 2 switched the SSCC
 * to the 20-digit 00-prefixed form, but already-created v1 exports must keep
 * re-rendering (retry) and re-downloading byte-identically. Not advertised —
 * `SHIFT_EXPORT_FORMATS` is what the UI offers for NEW exports.
 */
const LEGACY_SHIFT_EXPORT_FORMATS = Object.freeze([
  Object.freeze({
    id: "shift_txt_boxes",
    version: 1,
    label: "[TXT][С коробами] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "boxes",
  } as const),
  Object.freeze({
    id: "shift_csv_boxes",
    version: 1,
    label: "[CSV][С коробами] Отчет смены",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    boxMode: "boxes",
  } as const),
] as const satisfies readonly ShiftExportFormatDescriptor[]);

interface ShiftExportBlock {
  lines?: readonly string[];
  csvRows?: readonly (readonly string[])[];
  xmlBox?: GismtAggregationBox;
  physicalLineCount: number;
  codeCount: number;
  boxCount: number;
}

interface ShiftExportPartBlocks {
  blocks: readonly ShiftExportBlock[];
  physicalLineCount: number;
}

export function getShiftExportFormat(id: string, version: number): ShiftExportFormatDescriptor {
  const descriptor = [...SHIFT_EXPORT_FORMATS, ...LEGACY_SHIFT_EXPORT_FORMATS].find(
    (candidate) => candidate.id === id && candidate.version === version,
  );

  if (!descriptor) {
    throw new ShiftExportDomainError("FORMAT_NOT_FOUND");
  }

  return descriptor;
}

export function renderShiftExport(input: RenderShiftExportInput): ShiftExportPart[] {
  const descriptor = getShiftExportFormat(input.formatId, input.formatVersion);

  if (input.source.mode !== descriptor.boxMode) {
    throw new ShiftExportDomainError("FORMAT_SOURCE_MISMATCH");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.shiftDate)) {
    throw new Error("Invalid shift date");
  }

  validateLineLimit(input.maxLines);

  const organizationInn = input.organizationInn?.trim() ?? "";
  if (descriptor.extension === "xml" && organizationInn === "") {
    throw new ShiftExportDomainError("ORG_INN_MISSING");
  }

  const blocks = createBlocks(descriptor, input.source);
  if (blocks.reduce((total, block) => total + block.codeCount, 0) === 0) {
    throw new ShiftExportDomainError("EMPTY_SOURCE");
  }

  const partBlocks = splitBlocks(descriptor, blocks, input.maxLines);
  const hasMultipleParts = partBlocks.length > 1;
  const productName = sanitizeShiftExportFilenameSegment(input.productName);

  return partBlocks.map((part, index) => {
    const partNumber = index + 1;
    const xmlRendered =
      descriptor.extension === "xml"
        ? renderXmlPart(organizationInn, part.blocks.map((block) => requireXmlBox(block)))
        : null;
    const codeCount =
      xmlRendered?.codeCount ?? part.blocks.reduce((total, block) => total + block.codeCount, 0);
    const boxCount =
      xmlRendered?.boxCount ?? part.blocks.reduce((total, block) => total + block.boxCount, 0);
    const body = xmlRendered?.bytes ?? encodePart(descriptor, part.blocks);

    return {
      partNumber,
      physicalLineCount: xmlRendered?.physicalLineCount ?? part.physicalLineCount,
      codeCount,
      boxCount,
      filename: createFilename({
        descriptor,
        productName,
        shiftDate: input.shiftDate,
        codeCount,
        boxCount,
        partNumber,
        hasMultipleParts,
      }),
      mimeType: descriptor.mimeType,
      bytes: body,
    };
  });
}

export function sanitizeShiftExportFilenameSegment(value: string): string {
  const sanitized = value
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}-]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return sanitized || "продукция";
}

function validateLineLimit(maxLines: number | null): void {
  if (maxLines !== null && (!Number.isInteger(maxLines) || maxLines < 2 || maxLines > 1_000_000)) {
    throw new ShiftExportDomainError("INVALID_LINE_LIMIT");
  }
}

function createBlocks(
  descriptor: ShiftExportFormatDescriptor,
  source: ShiftExportSource,
): ShiftExportBlock[] {
  if (source.mode === "flat") {
    return source.codes.map((code) => {
      return {
        ...(descriptor.extension === "csv" ? { csvRows: [[code]] } : { lines: [code] }),
        physicalLineCount: descriptor.extension === "csv" ? countCsvPhysicalLines(code) : 1,
        codeCount: 1,
        boxCount: 0,
      };
    });
  }

  return source.boxes.map((box) => {
    if (descriptor.extension === "xml") {
      return {
        xmlBox: box,
        physicalLineCount: gismtAggregationBoxLineCount(box),
        codeCount: box.codes.length,
        boxCount: 1,
      };
    }

    const ssccOut = descriptor.version >= 2 ? formatBoxSscc(box.sscc) : box.sscc;
    if (descriptor.extension === "txt") {
      const lines = [ssccOut, ...box.codes, ""];
      return {
        lines,
        physicalLineCount: lines.length,
        codeCount: box.codes.length,
        boxCount: 1,
      };
    }

    const csvRows = box.codes.map((code) => [ssccOut, code]);

    return {
      csvRows,
      physicalLineCount: box.codes.reduce((total, code) => total + countCsvPhysicalLines(code), 0),
      codeCount: box.codes.length,
      boxCount: 1,
    };
  });
}

function splitBlocks(
  descriptor: ShiftExportFormatDescriptor,
  blocks: readonly ShiftExportBlock[],
  maxLines: number | null,
): ShiftExportPartBlocks[] {
  const headerLines =
    descriptor.extension === "csv"
      ? 1
      : descriptor.extension === "xml"
        ? GISMT_AGGREGATION_OVERHEAD_LINE_COUNT
        : 0;

  if (maxLines === null) {
    return [
      {
        blocks,
        physicalLineCount:
          headerLines + blocks.reduce((total, block) => total + block.physicalLineCount, 0),
      },
    ];
  }

  const parts: ShiftExportPartBlocks[] = [];
  let currentBlocks: ShiftExportBlock[] = [];
  let currentPhysicalLineCount = headerLines;

  for (const block of blocks) {
    if (headerLines + block.physicalLineCount > maxLines) {
      throw new ShiftExportDomainError("BOX_EXCEEDS_LINE_LIMIT");
    }

    if (currentBlocks.length > 0 && currentPhysicalLineCount + block.physicalLineCount > maxLines) {
      parts.push({ blocks: currentBlocks, physicalLineCount: currentPhysicalLineCount });
      currentBlocks = [];
      currentPhysicalLineCount = headerLines;
    }

    currentBlocks.push(block);
    currentPhysicalLineCount += block.physicalLineCount;
  }

  parts.push({ blocks: currentBlocks, physicalLineCount: currentPhysicalLineCount });
  return parts;
}

function encodePart(
  descriptor: ShiftExportFormatDescriptor,
  blocks: readonly ShiftExportBlock[],
): Uint8Array {
  if (descriptor.extension === "csv") {
    return encodeSemicolonCsv(
      descriptor.boxMode === "flat" ? ["code"] : ["box_sscc", "code"],
      blocks.flatMap((block) => block.csvRows ?? []),
    );
  }
  return encodeLfText(blocks.flatMap((block) => block.lines ?? []));
}

function createFilename(input: {
  descriptor: ShiftExportFormatDescriptor;
  productName: string;
  shiftDate: string;
  codeCount: number;
  boxCount: number;
  partNumber: number;
  hasMultipleParts: boolean;
}): string {
  const boxCountSegment = input.descriptor.boxMode === "boxes" ? `_${input.boxCount}box` : "";
  const partSegment = input.hasMultipleParts ? `_часть_${input.partNumber}` : "";

  return `${input.productName}_${input.codeCount}pcs${boxCountSegment}_${input.shiftDate}${partSegment}.${input.descriptor.extension}`;
}

function formatBoxSscc(sscc: string): string {
  try {
    return formatGismtAggregationSscc(sscc);
  } catch (error) {
    if (error instanceof GismtAggregationError) {
      throw new ShiftExportDomainError("INVALID_BOX_SSCC");
    }
    throw error;
  }
}

function renderXmlPart(
  organizationInn: string,
  boxes: readonly GismtAggregationBox[],
): GismtAggregationRenderResult {
  try {
    return renderGismtAggregationXml({ organizationInn, boxes });
  } catch (error) {
    if (error instanceof GismtAggregationError) {
      throw new ShiftExportDomainError(
        error.code === "INVALID_SSCC" ? "INVALID_BOX_SSCC" : error.code,
      );
    }
    throw error;
  }
}

function requireXmlBox(block: ShiftExportBlock): GismtAggregationBox {
  if (block.xmlBox === undefined) throw new Error("Missing XML aggregation box");
  return block.xmlBox;
}

function countCsvPhysicalLines(value: string): number {
  let count = 1;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\r") {
      count += 1;
      if (value[index + 1] === "\n") {
        index += 1;
      }
    } else if (character === "\n") {
      count += 1;
    }
  }

  return count;
}

import { encodeLfText, encodeSemicolonCsv } from "./document-text-encoding.js";
import {
  GISMT_AGGREGATION_OVERHEAD_LINE_COUNT,
  GismtAggregationError,
  formatGismtAggregationSscc,
  gismtAggregationBoxLineCount,
  gismtAggregationPalletLineCount,
  renderGismtAggregationXml,
  type GismtAggregationBox,
  type GismtAggregationPallet,
  type GismtAggregationRenderResult,
} from "./gismt-aggregation.js";

export type ShiftExportFormatId =
  | "shift_txt_flat"
  | "shift_txt_boxes"
  | "shift_csv_flat"
  | "shift_csv_boxes"
  | "shift_xml_gismt_aggregation"
  | "shift_txt_pallets"
  | "shift_csv_pallets"
  | "shift_xml_gismt_aggregation_pallets";

export type ShiftExportBoxMode = "flat" | "boxes" | "pallets";

export interface ShiftExportFormatDescriptor {
  id: ShiftExportFormatId;
  version: 1 | 2;
  label: string;
  extension: "txt" | "csv" | "xml";
  mimeType:
    "text/plain; charset=utf-8" | "text/csv; charset=utf-8" | "application/xml; charset=utf-8";
  boxMode: ShiftExportBoxMode;
}

/** A pallet stacking one or more closed boxes, as the export source sees it. */
export interface ShiftExportPalletGroup {
  sscc: string;
  boxes: readonly { sscc: string; codes: readonly string[] }[];
}

export type ShiftExportSource =
  | { mode: "flat"; codes: readonly string[] }
  | { mode: "boxes"; boxes: readonly { sscc: string; codes: readonly string[] }[] }
  | {
      mode: "pallets";
      /** Ordered (by the caller) so the rendered document is deterministic -- see the API's `closed_at` ordering. */
      pallets: readonly ShiftExportPalletGroup[];
      /** Boxes that stand on no pallet; rendered after every pallet. */
      looseBoxes: readonly { sscc: string; codes: readonly string[] }[];
    };

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
  | "PALLET_EXCEEDS_LINE_LIMIT"
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
  Object.freeze({
    id: "shift_txt_pallets",
    version: 1,
    label: "[TXT][Паллеты] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "pallets",
  } as const),
  Object.freeze({
    id: "shift_csv_pallets",
    version: 1,
    label: "[CSV][Паллеты] Отчет смены",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    boxMode: "pallets",
  } as const),
  Object.freeze({
    id: "shift_xml_gismt_aggregation_pallets",
    version: 1,
    label: "[XML][ГИСМТ] Паллетная агрегация",
    extension: "xml",
    mimeType: "application/xml; charset=utf-8",
    boxMode: "pallets",
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
  /**
   * Set only by a pallet-group block: every member box's OWN aggregation
   * data, standing in for what would otherwise be several `xmlBox` blocks.
   * Kept together with `xmlPallet` in ONE block so a pallet group never
   * splits across parts (see `buildPalletGroupBlock`).
   */
  xmlBoxes?: readonly GismtAggregationBox[];
  /** Set only by a pallet-group block: the aggregate referencing `xmlBoxes`. */
  xmlPallet?: GismtAggregationPallet;
  /**
   * True only for a block built by `buildPalletGroupBlock` (every extension,
   * not just XML) -- so a line-limit overflow can be reported as
   * `PALLET_EXCEEDS_LINE_LIMIT` rather than the misleading `BOX_EXCEEDS_LINE_LIMIT`,
   * which names a single box, not a whole pallet's worth of them.
   */
  isPalletGroup?: boolean;
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
  if (descriptor.extension === "xml") {
    renderXmlPart(organizationInn, blocks);
  }
  if (blocks.reduce((total, block) => total + block.codeCount, 0) === 0) {
    throw new ShiftExportDomainError("EMPTY_SOURCE");
  }

  const partBlocks = splitBlocks(descriptor, blocks, input.maxLines);
  const hasMultipleParts = partBlocks.length > 1;
  const productName = sanitizeShiftExportFilenameSegment(input.productName);

  return partBlocks.map((part, index) => {
    const partNumber = index + 1;
    const xmlRendered =
      descriptor.extension === "xml" ? renderXmlPart(organizationInn, part.blocks) : null;
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

  if (source.mode === "boxes") {
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
        physicalLineCount: box.codes.reduce(
          (total, code) => total + countCsvPhysicalLines(ssccOut) + countCsvPhysicalLines(code) - 1,
          0,
        ),
        codeCount: box.codes.length,
        boxCount: 1,
      };
    });
  }

  // Pallets first (in the caller's order -- the API orders them by
  // `closed_at`), loose boxes after. Each pallet group is ONE atomic block
  // (see `buildPalletGroupBlock`); each loose box keeps the same per-box
  // splitting granularity as the `boxes` mode above.
  return [
    ...source.pallets.map((pallet) => buildPalletGroupBlock(descriptor, pallet)),
    ...source.looseBoxes.map((box) => palletModeBoxBlock(descriptor, box, "")),
  ];
}

/**
 * A pallet group's boxes and its own aggregate reference, bundled as ONE
 * indivisible block: "a pallet block never splits" means its member boxes'
 * own pack_content (XML) / rows (CSV) / lines (TXT) travel with the pallet's
 * aggregate line into the same export part, never separated by `splitBlocks`.
 */
function buildPalletGroupBlock(
  descriptor: ShiftExportFormatDescriptor,
  pallet: ShiftExportPalletGroup,
): ShiftExportBlock {
  const palletColumn = descriptor.extension === "csv" ? formatBoxSscc(pallet.sscc) : "";
  const boxBlocks = pallet.boxes.map((box) => palletModeBoxBlock(descriptor, box, palletColumn));
  const codeCount = boxBlocks.reduce((total, block) => total + block.codeCount, 0);
  const boxCount = boxBlocks.length;
  const physicalLineCountOfBoxes = boxBlocks.reduce(
    (total, block) => total + block.physicalLineCount,
    0,
  );

  if (descriptor.extension === "xml") {
    const xmlPallet: GismtAggregationPallet = {
      sscc: pallet.sscc,
      boxSsccs: pallet.boxes.map((box) => box.sscc),
    };
    return {
      xmlBoxes: boxBlocks.map(requireXmlBox),
      xmlPallet,
      isPalletGroup: true,
      physicalLineCount: physicalLineCountOfBoxes + gismtAggregationPalletLineCount(xmlPallet),
      codeCount,
      boxCount,
    };
  }

  if (descriptor.extension === "txt") {
    return {
      lines: [formatBoxSscc(pallet.sscc), ...boxBlocks.flatMap((block) => block.lines ?? [])],
      isPalletGroup: true,
      physicalLineCount: 1 + physicalLineCountOfBoxes,
      codeCount,
      boxCount,
    };
  }

  return {
    csvRows: boxBlocks.flatMap((block) => block.csvRows ?? []),
    isPalletGroup: true,
    physicalLineCount: physicalLineCountOfBoxes,
    codeCount,
    boxCount,
  };
}

/**
 * One box's own contribution to a pallets-mode export: identical XML/TXT
 * shape whether the box stands on a pallet or on none, since a box's own
 * `pack_content`/line never differs by pallet membership -- only the CSV
 * `pallet_sscc` column does, via `palletColumn` (`""` for a loose box).
 */
function palletModeBoxBlock(
  descriptor: ShiftExportFormatDescriptor,
  box: { sscc: string; codes: readonly string[] },
  palletColumn: string,
): ShiftExportBlock {
  if (descriptor.extension === "xml") {
    return {
      xmlBox: box,
      physicalLineCount: gismtAggregationBoxLineCount(box),
      codeCount: box.codes.length,
      boxCount: 1,
    };
  }

  const ssccOut = formatBoxSscc(box.sscc);

  if (descriptor.extension === "txt") {
    const lines = [ssccOut, ...box.codes, ""];
    return { lines, physicalLineCount: lines.length, codeCount: box.codes.length, boxCount: 1 };
  }

  const csvRows = box.codes.map((code) => [palletColumn, ssccOut, code]);
  return {
    csvRows,
    physicalLineCount: box.codes.reduce(
      (total, code) => total + csvRowPhysicalLineCount([palletColumn, ssccOut, code]),
      0,
    ),
    codeCount: box.codes.length,
    boxCount: 1,
  };
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
      // A pallet group is one atomic block (see `buildPalletGroupBlock`), so an
      // overflow here means the WHOLE pallet -- its own aggregate line plus
      // every member box -- does not fit, not that a single box is too big.
      throw new ShiftExportDomainError(
        block.isPalletGroup ? "PALLET_EXCEEDS_LINE_LIMIT" : "BOX_EXCEEDS_LINE_LIMIT",
      );
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

function csvHeaderFor(boxMode: ShiftExportBoxMode): readonly string[] {
  if (boxMode === "flat") return ["code"];
  if (boxMode === "boxes") return ["box_sscc", "code"];
  return ["pallet_sscc", "box_sscc", "code"];
}

function encodePart(
  descriptor: ShiftExportFormatDescriptor,
  blocks: readonly ShiftExportBlock[],
): Uint8Array {
  if (descriptor.extension === "csv") {
    return encodeSemicolonCsv(
      csvHeaderFor(descriptor.boxMode),
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
  const boxCountSegment =
    input.descriptor.boxMode === "boxes" || input.descriptor.boxMode === "pallets"
      ? `_${input.boxCount}box`
      : "";
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
  blocks: readonly ShiftExportBlock[],
): GismtAggregationRenderResult {
  try {
    return renderGismtAggregationXml({
      organizationInn,
      boxes: blocks.flatMap(collectXmlBoxes),
      pallets: blocks.flatMap(collectXmlPallets),
    });
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

/** A block is either one plain box (`xmlBox`) or a pallet group's several (`xmlBoxes`). */
function collectXmlBoxes(block: ShiftExportBlock): readonly GismtAggregationBox[] {
  return block.xmlBoxes ?? [requireXmlBox(block)];
}

function collectXmlPallets(block: ShiftExportBlock): readonly GismtAggregationPallet[] {
  return block.xmlPallet ? [block.xmlPallet] : [];
}

/**
 * Physical lines a single CSV row spans: each field contributes its own
 * `countCsvPhysicalLines`, but the row itself is only ONE record, so
 * `fields.length - 1` of those per-field line breaks are shared with the
 * SAME record rather than starting a new one. Generalizes the two-column
 * formula the `boxes` mode block-builder already inlines above.
 */
function csvRowPhysicalLineCount(fields: readonly string[]): number {
  return (
    fields.reduce((total, field) => total + countCsvPhysicalLines(field), 0) - (fields.length - 1)
  );
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

export type ShiftExportFormatId =
  | "shift_txt_flat"
  | "shift_txt_boxes"
  | "shift_csv_flat"
  | "shift_csv_boxes";

export type ShiftExportBoxMode = "flat" | "boxes";

export interface ShiftExportFormatDescriptor {
  id: ShiftExportFormatId;
  version: 1;
  label: string;
  extension: "txt" | "csv";
  mimeType: "text/plain; charset=utf-8" | "text/csv; charset=utf-8";
  boxMode: ShiftExportBoxMode;
}

export type ShiftExportSource =
  | { mode: "flat"; codes: readonly string[] }
  | { mode: "boxes"; boxes: readonly { sscc: string; codes: readonly string[] }[] };

export interface RenderShiftExportInput {
  formatId: ShiftExportFormatId;
  formatVersion: 1;
  productName: string;
  shiftDate: string;
  maxLines: number | null;
  source: ShiftExportSource;
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
  | "BOX_EXCEEDS_LINE_LIMIT";

export class ShiftExportDomainError extends Error {
  constructor(readonly code: ShiftExportDomainErrorCode) {
    super(code);
    this.name = "ShiftExportDomainError";
  }
}

export const SHIFT_EXPORT_FORMATS = Object.freeze([
  {
    id: "shift_txt_flat",
    version: 1,
    label: "[TXT][Без коробов] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "flat",
  },
  {
    id: "shift_txt_boxes",
    version: 1,
    label: "[TXT][С коробами] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "boxes",
  },
  {
    id: "shift_csv_flat",
    version: 1,
    label: "[CSV][Без коробов] Отчет смены",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    boxMode: "flat",
  },
  {
    id: "shift_csv_boxes",
    version: 1,
    label: "[CSV][С коробами] Отчет смены",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    boxMode: "boxes",
  },
] as const satisfies readonly ShiftExportFormatDescriptor[]);

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
const textEncoder = new TextEncoder();

interface ShiftExportBlock {
  lines: readonly string[];
  codeCount: number;
  boxCount: number;
}

interface ShiftExportPartBlocks {
  blocks: readonly ShiftExportBlock[];
  physicalLineCount: number;
}

export function getShiftExportFormat(id: string, version: number): ShiftExportFormatDescriptor {
  const descriptor = SHIFT_EXPORT_FORMATS.find(
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

  const blocks = createBlocks(descriptor, input.source);
  if (blocks.reduce((total, block) => total + block.codeCount, 0) === 0) {
    throw new ShiftExportDomainError("EMPTY_SOURCE");
  }

  const partBlocks = splitBlocks(descriptor, blocks, input.maxLines);
  const hasMultipleParts = partBlocks.length > 1;
  const productName = sanitizeShiftExportFilenameSegment(input.productName);

  return partBlocks.map((part, index) => {
    const partNumber = index + 1;
    const codeCount = part.blocks.reduce((total, block) => total + block.codeCount, 0);
    const boxCount = part.blocks.reduce((total, block) => total + block.boxCount, 0);
    const body = encodePart(descriptor, part.blocks);

    return {
      partNumber,
      physicalLineCount: part.physicalLineCount,
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
  if (
    maxLines !== null &&
    (!Number.isInteger(maxLines) || maxLines < 2 || maxLines > 1_000_000)
  ) {
    throw new ShiftExportDomainError("INVALID_LINE_LIMIT");
  }
}

function createBlocks(
  descriptor: ShiftExportFormatDescriptor,
  source: ShiftExportSource,
): ShiftExportBlock[] {
  if (source.mode === "flat") {
    return source.codes.map((code) => ({
      lines: [descriptor.extension === "csv" ? csvField(code) : code],
      codeCount: 1,
      boxCount: 0,
    }));
  }

  return source.boxes.map((box) => ({
    lines:
      descriptor.extension === "txt"
        ? [box.sscc, ...box.codes, ""]
        : box.codes.map((code) => `${csvField(box.sscc)};${csvField(code)}`),
    codeCount: box.codes.length,
    boxCount: 1,
  }));
}

function splitBlocks(
  descriptor: ShiftExportFormatDescriptor,
  blocks: readonly ShiftExportBlock[],
  maxLines: number | null,
): ShiftExportPartBlocks[] {
  const headerLines = descriptor.extension === "csv" ? 1 : 0;

  if (maxLines === null) {
    return [
      {
        blocks,
        physicalLineCount: headerLines + blocks.reduce((total, block) => total + block.lines.length, 0),
      },
    ];
  }

  const parts: ShiftExportPartBlocks[] = [];
  let currentBlocks: ShiftExportBlock[] = [];
  let currentPhysicalLineCount = headerLines;

  for (const block of blocks) {
    if (headerLines + block.lines.length > maxLines) {
      throw new ShiftExportDomainError("BOX_EXCEEDS_LINE_LIMIT");
    }

    if (
      currentBlocks.length > 0 &&
      currentPhysicalLineCount + block.lines.length > maxLines
    ) {
      parts.push({ blocks: currentBlocks, physicalLineCount: currentPhysicalLineCount });
      currentBlocks = [];
      currentPhysicalLineCount = headerLines;
    }

    currentBlocks.push(block);
    currentPhysicalLineCount += block.lines.length;
  }

  parts.push({ blocks: currentBlocks, physicalLineCount: currentPhysicalLineCount });
  return parts;
}

function encodePart(
  descriptor: ShiftExportFormatDescriptor,
  blocks: readonly ShiftExportBlock[],
): Uint8Array {
  const lines = blocks.flatMap((block) => block.lines);
  const content =
    descriptor.extension === "csv"
      ? [descriptor.boxMode === "flat" ? "code" : "box_sscc;code", ...lines].join("\r\n") + "\r\n"
      : lines.join("\n") + "\n";
  const encoded = textEncoder.encode(content);

  if (descriptor.extension === "txt") {
    return encoded;
  }

  const bytes = new Uint8Array(UTF8_BOM.length + encoded.length);
  bytes.set(UTF8_BOM);
  bytes.set(encoded, UTF8_BOM.length);
  return bytes;
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
  const boxCountSegment = input.descriptor.boxMode === "boxes" ? `_${input.boxCount}` : "";
  const partSegment = input.hasMultipleParts ? `_часть_${input.partNumber}` : "";

  return `${input.productName}_${input.codeCount}${boxCountSegment}_${input.shiftDate}${partSegment}.${input.descriptor.extension}`;
}

function csvField(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

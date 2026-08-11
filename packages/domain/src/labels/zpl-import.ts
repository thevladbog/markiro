import { DomainError } from "../errors.js";
import {
  mmToDots,
  parseLabelTemplate,
  type LabelElement,
  type LabelTemplateSpec,
} from "./model.js";
import {
  assertImportInputLimits,
  importedElementId,
  MAX_LABEL_CODE_COMMANDS,
  MAX_LABEL_CODE_ELEMENTS,
  parseTemplatePayload,
  type LabelImportResult,
} from "./import.js";

interface ZplState {
  line: number;
  xDots: number;
  yDots: number;
  fontHeightDots: number;
  fontWidthDots: number;
  align?: "left" | "center" | "right";
  maxWidthDots?: number;
  hexIndicator?: string;
  barcode?: { format: "code128" | "ean13" | "datamatrix" | "qr"; sizeDots: number };
  graphic?: { widthDots: number; heightDots: number; thicknessDots: number };
  data?: string;
}

const TOKEN_RE = /\^(XA|XZ|PW|LL|FO|A0|FB|FD|FS|FH|BC|BE|BX|BQ|GB|GFA|[A-Z][A-Z0-9]?)([^^]*)/g;
const SUPPORTED = new Set([
  "XA",
  "XZ",
  "PW",
  "LL",
  "FO",
  "A0",
  "FB",
  "FD",
  "FS",
  "FH",
  "BC",
  "BE",
  "BX",
  "BQ",
  "GB",
]);

function fail(line: number, source: string, message: string): never {
  throw new DomainError("LABEL_CODE_INVALID", message, { cause: { line, source } });
}

function parseNumbers(value: string, count: number, line: number, source: string): number[] {
  const values = value.split(",").map((part) => Number(part.trim()));
  if (values.length < count || values.slice(0, count).some((number) => !Number.isFinite(number))) {
    fail(line, source, `invalid numeric ZPL arguments: ${value}`);
  }
  return values;
}

function requiredNumber(values: number[], index: number, line: number, source: string): number {
  const value = values[index];
  if (value === undefined) fail(line, source, "missing numeric ZPL argument");
  return value;
}

function decodeFieldData(value: string, indicator: string | undefined): string {
  if (!indicator) return value;
  const escaped = new RegExp(`${indicator}([0-9A-Fa-f]{2}|1)`, "g");
  return value.replace(escaped, (_match, code: string) =>
    code === "1" ? "" : String.fromCharCode(Number.parseInt(code, 16)),
  );
}

function dotsToMm(dots: number, dpi: 203 | 300): number {
  return (dots * 25.4) / dpi;
}

function pointsFromDots(dots: number, dpi: 203 | 300): number {
  return Math.max(4, Math.min(72, (dots * 72) / dpi));
}

function barcodeSize(args: string, line: number, source: string): number {
  const withoutOrientation = args.trim().replace(/^[A-Z],?/, "");
  return requiredNumber(parseNumbers(withoutOrientation, 1, line, source), 0, line, source);
}

function alignFromZpl(value: string | undefined): "left" | "center" | "right" | undefined {
  if (value === "C") return "center";
  if (value === "R") return "right";
  if (value === "L") return "left";
  return undefined;
}

function tokenCount(input: string): number {
  return (input.match(/\^/g) ?? []).length;
}

function finalizeField(
  state: ZplState,
  dpi: 203 | 300,
  elements: LabelElement[],
  sourceLines: Record<string, number>,
): void {
  if (state.data === undefined && !state.barcode && !state.graphic) return;
  const ordinal = elements.length + 1;
  if (ordinal > MAX_LABEL_CODE_ELEMENTS) {
    throw new DomainError(
      "LABEL_CODE_LIMIT",
      `label code exceeds ${MAX_LABEL_CODE_ELEMENTS} elements`,
    );
  }
  const id = importedElementId("zpl", ordinal);
  const xMm = dotsToMm(state.xDots, dpi);
  const yMm = dotsToMm(state.yDots, dpi);

  if (state.graphic) {
    const widthMm = dotsToMm(state.graphic.widthDots, dpi);
    const heightMm = dotsToMm(state.graphic.heightDots, dpi);
    const thicknessMm = Math.max(0.1, dotsToMm(state.graphic.thicknessDots, dpi));
    const isLine =
      state.graphic.widthDots <= state.graphic.thicknessDots ||
      state.graphic.heightDots <= state.graphic.thicknessDots;
    const element: LabelElement = isLine
      ? {
          kind: "line",
          id,
          xMm,
          yMm,
          x2Mm: xMm + widthMm,
          y2Mm: yMm + heightMm,
          thicknessMm,
        }
      : { kind: "box", id, xMm, yMm, widthMm, heightMm, thicknessMm };
    elements.push(element);
    sourceLines[id] = state.line;
    return;
  }

  if (state.barcode) {
    let payload = decodeFieldData(state.data ?? "", state.hexIndicator);
    if (state.barcode.format === "qr" && payload.startsWith("QA,")) payload = payload.slice(3);
    const parsed = parseTemplatePayload(payload, state.line);
    const element: LabelElement = {
      kind: "barcode",
      id,
      xMm,
      yMm,
      format: state.barcode.format,
      data: parsed.kind === "field" ? parsed.field : { literal: parsed.value },
      sizeMm: Math.max(0.1, dotsToMm(state.barcode.sizeDots, dpi)),
    };
    elements.push(element);
    sourceLines[id] = state.line;
    return;
  }

  const payload = decodeFieldData(state.data ?? "", state.hexIndicator);
  const parsed = parseTemplatePayload(payload, state.line);
  const common = {
    id,
    xMm,
    yMm,
    fontSizePt: pointsFromDots(state.fontHeightDots, dpi),
    maxWidthMm: state.maxWidthDots === undefined ? undefined : dotsToMm(state.maxWidthDots, dpi),
  };
  const textCommon = state.align ? { ...common, align: state.align } : common;
  const element: LabelElement =
    parsed.kind === "field"
      ? { kind: "field", ...textCommon, field: parsed.field }
      : { kind: "text", ...textCommon, text: parsed.value };
  elements.push(element);
  sourceLines[id] = state.line;
}

export function parseZplLabel(input: string, dpi: 203 | 300): LabelImportResult {
  assertImportInputLimits(input);
  if (tokenCount(input) > MAX_LABEL_CODE_COMMANDS) {
    throw new DomainError(
      "LABEL_CODE_LIMIT",
      `label code exceeds ${MAX_LABEL_CODE_COMMANDS} commands`,
    );
  }

  let widthDots: number | undefined;
  let heightDots: number | undefined;
  const elements: LabelElement[] = [];
  const sourceLineByElementId: Record<string, number> = {};
  const warnings: LabelImportResult["warnings"] = [];

  for (const [lineIndex, source] of input.split(/\r?\n/).entries()) {
    const line = lineIndex + 1;
    const tokens = Array.from(source.matchAll(TOKEN_RE));
    if (tokens.length === 0) {
      if (source.trim())
        warnings.push({
          line,
          source,
          code: "UNSUPPORTED_COMMAND",
          message: "unsupported ZPL line",
        });
      continue;
    }
    let state: ZplState | null = null;
    for (const token of tokens) {
      const name = token[1]!;
      const args = token[2] ?? "";
      if (!SUPPORTED.has(name)) {
        warnings.push({
          line,
          source,
          code: "UNSUPPORTED_COMMAND",
          message: `unsupported ZPL command ^${name}`,
        });
        continue;
      }
      switch (name) {
        case "PW":
          widthDots = requiredNumber(parseNumbers(args, 1, line, source), 0, line, source);
          break;
        case "LL":
          heightDots = requiredNumber(parseNumbers(args, 1, line, source), 0, line, source);
          break;
        case "FO": {
          const numbers = parseNumbers(args, 2, line, source);
          const xDots = requiredNumber(numbers, 0, line, source);
          const yDots = requiredNumber(numbers, 1, line, source);
          state = {
            line,
            xDots,
            yDots,
            fontHeightDots: 24,
            fontWidthDots: 24,
          };
          break;
        }
        case "A0": {
          if (!state) fail(line, source, "ZPL font command requires ^FO");
          const orientation = args.trim().charAt(0) || "N";
          if (orientation !== "N") fail(line, source, "only non-rotated ZPL text is supported");
          const numbers = parseNumbers(args.trim().slice(1), 2, line, source);
          state.fontHeightDots = requiredNumber(numbers, 0, line, source);
          state.fontWidthDots = requiredNumber(numbers, 1, line, source);
          break;
        }
        case "FB": {
          if (!state) fail(line, source, "ZPL field block requires ^FO");
          const parts = args.split(",");
          const width = Number(parts[0]);
          if (!Number.isFinite(width) || width <= 0)
            fail(line, source, "invalid ZPL field block width");
          state.maxWidthDots = width;
          const alignment = alignFromZpl(parts[3]?.trim());
          if (alignment) state.align = alignment;
          break;
        }
        case "FH":
          if (!state) fail(line, source, "ZPL hex field command requires ^FO");
          state.hexIndicator = args.trim().charAt(0) || "_";
          break;
        case "FD":
          if (!state) fail(line, source, "ZPL data command requires ^FO");
          state.data = args;
          break;
        case "BC":
          if (!state) fail(line, source, "ZPL barcode command requires ^FO");
          state.barcode = { format: "code128", sizeDots: barcodeSize(args, line, source) };
          break;
        case "BE":
          if (!state) fail(line, source, "ZPL barcode command requires ^FO");
          state.barcode = { format: "ean13", sizeDots: barcodeSize(args, line, source) };
          break;
        case "BX":
          if (!state) fail(line, source, "ZPL barcode command requires ^FO");
          state.barcode = { format: "datamatrix", sizeDots: barcodeSize(args, line, source) };
          break;
        case "BQ":
          if (!state) fail(line, source, "ZPL barcode command requires ^FO");
          state.barcode = {
            format: "qr",
            sizeDots: requiredNumber(
              parseNumbers(args.split(",").slice(-1).join(","), 1, line, source),
              0,
              line,
              source,
            ),
          };
          break;
        case "GB": {
          if (!state) fail(line, source, "ZPL graphic box command requires ^FO");
          const numbers = parseNumbers(args, 3, line, source);
          const width = requiredNumber(numbers, 0, line, source);
          const height = requiredNumber(numbers, 1, line, source);
          const thickness = requiredNumber(numbers, 2, line, source);
          state.graphic = { widthDots: width, heightDots: height, thicknessDots: thickness };
          break;
        }
        case "FS":
          if (state) {
            finalizeField(state, dpi, elements, sourceLineByElementId);
            state = null;
          }
          break;
        case "XA":
        case "XZ":
          break;
      }
    }
    if (state?.data !== undefined || state?.barcode || state?.graphic) {
      finalizeField(state, dpi, elements, sourceLineByElementId);
    }
  }

  if (widthDots === undefined || heightDots === undefined) {
    throw new DomainError("LABEL_CODE_INVALID", "ZPL source must include ^PW and ^LL");
  }
  const spec: LabelTemplateSpec = parseLabelTemplate({
    widthMm: dotsToMm(widthDots, dpi),
    heightMm: dotsToMm(heightDots, dpi),
    dpi,
    language: "zpl",
    elements,
  });
  return { spec, warnings, sourceLineByElementId };
}

export { mmToDots };

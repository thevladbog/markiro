import { DomainError } from "../errors.js";
import {
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

function fail(line: number, source: string, message: string): never {
  throw new DomainError("LABEL_CODE_INVALID", message, { cause: { line, source } });
}

function splitTsplArguments(source: string, line: number): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === "," && !quoted) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (quoted) fail(line, source, "unterminated TSPL quoted argument");
  values.push(current.trim());
  return values;
}

function required(values: string[], index: number, line: number, source: string): string {
  const value = values[index];
  if (value === undefined || value === "") fail(line, source, "missing TSPL argument");
  return value;
}

function numberAt(values: string[], index: number, line: number, source: string): number {
  const value = Number(required(values, index, line, source));
  if (!Number.isFinite(value)) fail(line, source, "invalid numeric TSPL argument");
  return value;
}

function dotsToMm(dots: number, dpi: 203 | 300): number {
  return (dots * 25.4) / dpi;
}

function parseSize(value: string, line: number, source: string): number {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*mm\s*$/i.exec(value);
  if (!match) fail(line, source, "TSPL SIZE must use millimetres");
  return Number(match[1]);
}

function addElement(
  elements: LabelElement[],
  element: LabelElement,
  sourceLines: Record<string, number>,
  line: number,
): void {
  if (elements.length >= MAX_LABEL_CODE_ELEMENTS) {
    throw new DomainError("LABEL_CODE_LIMIT", `label code exceeds ${MAX_LABEL_CODE_ELEMENTS} elements`);
  }
  elements.push(element);
  sourceLines[element.id] = line;
}

function parseText(
  args: string[],
  line: number,
  source: string,
  dpi: 203 | 300,
  ordinal: number,
): LabelElement {
  const xMm = dotsToMm(numberAt(args, 0, line, source), dpi);
  const yMm = dotsToMm(numberAt(args, 1, line, source), dpi);
  if (required(args, 2, line, source) !== "0") fail(line, source, "only TSPL font \"0\" is supported");
  if (numberAt(args, 3, line, source) !== 0) fail(line, source, "only non-rotated TSPL text is supported");
  const fontSizePt = Math.max(4, Math.min(72, numberAt(args, 4, line, source)));
  const widthScale = numberAt(args, 5, line, source);
  if (widthScale <= 0) fail(line, source, "TSPL text scale must be positive");
  const possibleAlignment = args[6];
  const hasAlignment = possibleAlignment === "1" || possibleAlignment === "2" || possibleAlignment === "3";
  const align = hasAlignment
    ? possibleAlignment === "1"
      ? "left"
      : possibleAlignment === "2"
        ? "center"
        : "right"
    : undefined;
  const payload = required(args, hasAlignment ? 7 : 6, line, source);
  const parsed = parseTemplatePayload(payload, line);
  const common = {
    id: importedElementId("tspl", ordinal),
    xMm,
    yMm,
    fontSizePt,
  };
  if (parsed.kind === "field") {
    return align ? { kind: "field", ...common, align, field: parsed.field } : { kind: "field", ...common, field: parsed.field };
  }
  return align ? { kind: "text", ...common, align, text: parsed.value } : { kind: "text", ...common, text: parsed.value };
}

function parseBarcode(
  args: string[],
  line: number,
  source: string,
  dpi: 203 | 300,
  ordinal: number,
): LabelElement {
  const xMm = dotsToMm(numberAt(args, 0, line, source), dpi);
  const yMm = dotsToMm(numberAt(args, 1, line, source), dpi);
  const type = required(args, 2, line, source).toUpperCase();
  const format = type === "128" ? "code128" : type === "EAN13" ? "ean13" : undefined;
  if (!format) fail(line, source, `unsupported TSPL barcode type ${type}`);
  const sizeMm = Math.max(0.1, dotsToMm(numberAt(args, 3, line, source), dpi));
  if (numberAt(args, 5, line, source) !== 0) fail(line, source, "only non-rotated TSPL barcodes are supported");
  const parsed = parseTemplatePayload(required(args, 8, line, source), line);
  return {
    kind: "barcode",
    id: importedElementId("tspl", ordinal),
    xMm,
    yMm,
    format,
    sizeMm,
    data: parsed.kind === "field" ? parsed.field : { literal: parsed.value },
  };
}

export function parseTsplLabel(input: string, dpi: 203 | 300): LabelImportResult {
  assertImportInputLimits(input);
  const lines = input.split(/\r?\n/);
  if (lines.filter((line) => line.trim()).length > MAX_LABEL_CODE_COMMANDS) {
    throw new DomainError("LABEL_CODE_LIMIT", `label code exceeds ${MAX_LABEL_CODE_COMMANDS} commands`);
  }
  let widthMm: number | undefined;
  let heightMm: number | undefined;
  const elements: LabelElement[] = [];
  const sourceLineByElementId: Record<string, number> = {};
  const warnings: LabelImportResult["warnings"] = [];

  for (const [index, source] of lines.entries()) {
    const line = index + 1;
    const trimmed = source.trim();
    if (!trimmed) continue;
    const match = /^([A-Za-z]+)\s*(.*)$/.exec(trimmed);
    if (!match) fail(line, source, "invalid TSPL statement");
    const command = match[1]!.toUpperCase();
    const args = splitTsplArguments(match[2] ?? "", line);
    switch (command) {
      case "SIZE":
        if (widthMm !== undefined || heightMm !== undefined) fail(line, source, "TSPL source contains multiple SIZE statements");
        widthMm = parseSize(required(args, 0, line, source), line, source);
        heightMm = parseSize(required(args, 1, line, source), line, source);
        break;
      case "GAP":
      case "DIRECTION":
      case "REFERENCE":
      case "CLS":
      case "PRINT":
        break;
      case "TEXT":
        addElement(elements, parseText(args, line, source, dpi, elements.length + 1), sourceLineByElementId, line);
        break;
      case "BARCODE":
        addElement(elements, parseBarcode(args, line, source, dpi, elements.length + 1), sourceLineByElementId, line);
        break;
      case "DMATRIX": {
        const xMm = dotsToMm(numberAt(args, 0, line, source), dpi);
        const yMm = dotsToMm(numberAt(args, 1, line, source), dpi);
        const sizeMm = Math.max(0.1, dotsToMm(numberAt(args, 2, line, source), dpi));
        const parsed = parseTemplatePayload(required(args, 4, line, source), line);
        addElement(
          elements,
          {
            kind: "barcode",
            id: importedElementId("tspl", elements.length + 1),
            xMm,
            yMm,
            format: "datamatrix",
            sizeMm,
            data: parsed.kind === "field" ? parsed.field : { literal: parsed.value },
          },
          sourceLineByElementId,
          line,
        );
        break;
      }
      case "QRCODE": {
        const xMm = dotsToMm(numberAt(args, 0, line, source), dpi);
        const yMm = dotsToMm(numberAt(args, 1, line, source), dpi);
        if (numberAt(args, 5, line, source) !== 0) fail(line, source, "only non-rotated TSPL QR codes are supported");
        const parsed = parseTemplatePayload(required(args, 6, line, source), line);
        addElement(
          elements,
          {
            kind: "barcode",
            id: importedElementId("tspl", elements.length + 1),
            xMm,
            yMm,
            format: "qr",
            sizeMm: Math.max(0.1, dotsToMm(numberAt(args, 3, line, source), dpi)),
            data: parsed.kind === "field" ? parsed.field : { literal: parsed.value },
          },
          sourceLineByElementId,
          line,
        );
        break;
      }
      case "BAR": {
        const xMm = dotsToMm(numberAt(args, 0, line, source), dpi);
        const yMm = dotsToMm(numberAt(args, 1, line, source), dpi);
        const widthMm = dotsToMm(numberAt(args, 2, line, source), dpi);
        const heightMm = dotsToMm(numberAt(args, 3, line, source), dpi);
        addElement(
          elements,
          {
            kind: "line",
            id: importedElementId("tspl", elements.length + 1),
            xMm,
            yMm,
            x2Mm: xMm + widthMm,
            y2Mm: yMm + heightMm,
            thicknessMm: Math.max(0.1, Math.min(widthMm || 0.1, heightMm || 0.1)),
          },
          sourceLineByElementId,
          line,
        );
        break;
      }
      case "BOX": {
        const xMm = dotsToMm(numberAt(args, 0, line, source), dpi);
        const yMm = dotsToMm(numberAt(args, 1, line, source), dpi);
        const xEndMm = dotsToMm(numberAt(args, 2, line, source), dpi);
        const yEndMm = dotsToMm(numberAt(args, 3, line, source), dpi);
        const width = xEndMm - xMm;
        const height = yEndMm - yMm;
        if (width <= 0 || height <= 0) fail(line, source, "TSPL BOX end must be below and right of start");
        addElement(
          elements,
          {
            kind: "box",
            id: importedElementId("tspl", elements.length + 1),
            xMm,
            yMm,
            widthMm: width,
            heightMm: height,
            thicknessMm: Math.max(0.1, dotsToMm(numberAt(args, 4, line, source), dpi)),
          },
          sourceLineByElementId,
          line,
        );
        break;
      }
      default:
        warnings.push({ line, source, code: "UNSUPPORTED_COMMAND", message: `unsupported TSPL command ${command}` });
        break;
    }
  }

  if (widthMm === undefined || heightMm === undefined) {
    throw new DomainError("LABEL_CODE_INVALID", "TSPL source must include SIZE");
  }
  const spec: LabelTemplateSpec = parseLabelTemplate({
    widthMm,
    heightMm,
    dpi,
    language: "tspl",
    elements,
  });
  return { spec, warnings, sourceLineByElementId };
}

export { splitTsplArguments };

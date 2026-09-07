import bwipjs from "bwip-js";
import { DomainError } from "../errors.js";
import { toGs1Data } from "./gs1-data-matrix.js";

const MAX_LITERAL_DATA_MATRIX_UTF8_BYTES = 512;

/**
 * Renders the raw stored KM as a faithful GS1 DataMatrix: FNC1 in the first
 * position and between variable-length AIs, so a cash-register/ОФД scanner
 * decodes it as a GS1 symbol (reporting AIM symbology identifier `]d2`) and
 * parses out AI 01/21/93 rather than treating it as plain data.
 */
export function renderDataMatrixSvg(text: string): string {
  return bwipjs.toSVG({
    bcid: "datamatrix",
    text: `^FNC1${toGs1Data(text)}`,
    parsefnc: true,
    scale: 3,
  });
}

/**
 * Renders a literal (non-GS1) Data Matrix for document verification URLs and
 * other bounded artifacts. Unlike KM rendering, it does not parse AIs or add
 * FNC1 control characters.
 */
export function renderLiteralDataMatrixSvg(text: string): string {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes === 0 || bytes > MAX_LITERAL_DATA_MATRIX_UTF8_BYTES) {
    throw new DomainError(
      "LITERAL_DATA_MATRIX_TEXT_INVALID",
      "Literal Data Matrix text must contain between 1 and 512 UTF-8 bytes.",
    );
  }

  return bwipjs.toSVG({ bcid: "datamatrix", text, scale: 3 });
}

export function renderQrSvg(text: string): string {
  return bwipjs.toSVG({ bcid: "qrcode", text, scale: 3 });
}

export function renderCode128Svg(text: string, options: { includeText?: boolean } = {}): string {
  return bwipjs.toSVG({
    bcid: "code128",
    text,
    scale: 2,
    height: 10,
    includetext: options.includeText ?? true,
    textxalign: "center",
  });
}

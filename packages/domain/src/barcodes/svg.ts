import bwipjs from "bwip-js";
import { DomainError } from "../errors.js";
import { parseKmSegments } from "../gs1/km.js";

const MAX_LITERAL_DATA_MATRIX_UTF8_BYTES = 512;

/**
 * Builds the raw GS1 byte stream for Data Matrix. Using bwip-js's
 * `(AI)value` element-string syntax is unsafe for real Chestny ZNAK values:
 * literal parentheses are valid in serials/crypto tails but that syntax
 * interprets them as AI boundaries. The lower-level `datamatrix` encoder
 * accepts an explicit leading FNC1 and explicit FNC1 field separators instead.
 *
 * Segment splitting (including `]d2`-stripping) is delegated to
 * `parseKmSegments`, the same parser `parseKm` uses on ingest, so the
 * renderer can never diverge from ingest parsing.
 */
function toGs1Data(raw: string): string {
  const { gtin14, serial, ais } = parseKmSegments(raw);
  // parsefnc treats `^FNC1` as control syntax and `^^` as one literal caret.
  const escapeValue = (value: string) => value.replace(/\^/g, "^^");
  const trailing = ais.map(({ ai, value }) => `^FNC1${ai}${escapeValue(value)}`).join("");
  return `01${gtin14}21${escapeValue(serial)}${trailing}`;
}

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
  const bytes = Buffer.byteLength(text, "utf8");
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

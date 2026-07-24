import bwipjs from "bwip-js";
import { DomainError } from "../errors.js";
import { parseKmSegments } from "../gs1/km.js";

/**
 * Converts a raw Chestny ZNAK KM (`01<gtin14>21<serial><GS>93<tail>…`, possibly
 * `]d2`-prefixed) into bwip-js's `(AI)value(AI)value…` GS1 element-string
 * convention — the only input form `gs1datamatrix` accepts (it rejects the
 * flat GS-separated digit stream, even with `parse: true`; verified empirically).
 * bwip-js inserts the FNC1/GS separator itself, only where GS1 requires it
 * (after a variable-length AI that isn't the last element).
 *
 * Segment splitting (including `]d2`-stripping) is delegated to
 * `parseKmSegments`, the same parser `parseKm` uses on ingest, so the
 * renderer can never diverge from ingest parsing.
 *
 * Guards against literal `(`/`)` in a value, which would otherwise be
 * misparsed by bwip-js as a spurious AI boundary (verified empirically: an
 * unescaped `(` inside a value silently produces a different, corrupted
 * symbol instead of an error).
 */
function toGs1ElementString(raw: string): string {
  const { gtin14, serial, ais } = parseKmSegments(raw);
  const segments = [{ ai: "01", value: gtin14 }, { ai: "21", value: serial }, ...ais];
  return segments
    .map(({ ai, value }) => {
      if (value.includes("(") || value.includes(")")) {
        throw new DomainError(
          "KM_PAREN_INJECTION",
          `KM AI ${ai} value contains a literal parenthesis, which bwip-js's GS1 element-string input cannot represent`,
        );
      }
      return `(${ai})${value}`;
    })
    .join("");
}

/**
 * Renders the raw stored KM as a faithful GS1 DataMatrix: FNC1 in the first
 * position and between variable-length AIs, so a cash-register/ОФД scanner
 * decodes it as a GS1 symbol (reporting AIM symbology identifier `]d2`) and
 * parses out AI 01/21/93 rather than treating it as plain data.
 */
export function renderDataMatrixSvg(text: string): string {
  return bwipjs.toSVG({ bcid: "gs1datamatrix", text: toGs1ElementString(text), scale: 3 });
}

export function renderQrSvg(text: string): string {
  return bwipjs.toSVG({ bcid: "qrcode", text, scale: 3 });
}

export function renderCode128Svg(text: string): string {
  return bwipjs.toSVG({
    bcid: "code128",
    text,
    scale: 2,
    height: 10,
    includetext: true,
    textxalign: "center",
  });
}

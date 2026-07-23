import bwipjs from "bwip-js";
import { DomainError } from "../errors.js";

const GS = "\u001d";

interface KmSegment {
  ai: string;
  value: string;
}

/**
 * Structurally splits a raw Chestny ZNAK KM (`01<gtin14>21<serial><GS>93<tail>…`)
 * into ordered GS1 Application Identifier segments, preserving encounter order.
 *
 * This does NOT validate the GTIN check digit (that is `parseKm`'s job on
 * ingest) — it is a pure structural split so the renderer can faithfully
 * reproduce whatever raw KM is already stored.
 */
function splitKmSegments(raw: string): KmSegment[] {
  if (!raw.startsWith("01")) {
    throw new DomainError("KM_NO_GTIN", "KM must start with AI 01");
  }
  const gtin14 = raw.slice(2, 16);
  if (!/^\d{14}$/.test(gtin14)) {
    throw new DomainError("KM_NO_GTIN", "KM AI 01 value must be a 14-digit GTIN");
  }
  let rest = raw.slice(16);
  if (!rest.startsWith("21")) {
    throw new DomainError("KM_NO_SERIAL", "KM must carry AI 21 serial after the GTIN");
  }
  rest = rest.slice(2);
  const segments: KmSegment[] = [{ ai: "01", value: gtin14 }];
  const gsAt = rest.indexOf(GS);
  segments.push({ ai: "21", value: gsAt === -1 ? rest : rest.slice(0, gsAt) });
  rest = gsAt === -1 ? "" : rest.slice(gsAt + 1);
  while (rest.length > 0) {
    if (rest.startsWith(GS)) {
      rest = rest.slice(1);
      continue;
    }
    if (rest.length <= 2) break;
    const ai = rest.slice(0, 2);
    const end = rest.indexOf(GS);
    segments.push({ ai, value: end === -1 ? rest.slice(2) : rest.slice(2, end) });
    rest = end === -1 ? "" : rest.slice(end + 1);
  }
  return segments;
}

/**
 * Converts KM segments into bwip-js's `(AI)value(AI)value…` GS1 element-string
 * convention — the only input form `gs1datamatrix` accepts (it rejects the
 * flat GS-separated digit stream, even with `parse: true`; verified empirically).
 * bwip-js inserts the FNC1/GS separator itself, only where GS1 requires it
 * (after a variable-length AI that isn't the last element).
 *
 * Guards against literal `(`/`)` in a value, which would otherwise be
 * misparsed by bwip-js as a spurious AI boundary (verified empirically: an
 * unescaped `(` inside a value silently produces a different, corrupted
 * symbol instead of an error).
 */
function toGs1ElementString(raw: string): string {
  return splitKmSegments(raw)
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
  return bwipjs.toSVG({ bcid: "code128", text, scale: 2, height: 10, includetext: true, textxalign: "center" });
}

import { DomainError } from "../errors.js";
import {
  mmToDots,
  ptToDots,
  type LabelBarcodeElement,
  type LabelBoxElement,
  type LabelField,
  type LabelFieldElement,
  type LabelLineElement,
  type LabelTemplateSpec,
  type LabelTextElement,
} from "./model.js";
import { buildGfaCommand, type RasterizeTextFn } from "./raster-types.js";

export { buildGfaCommand } from "./raster-types.js";
export type { RasterResult, RasterizeTextFn } from "./raster-types.js";

export interface GenerateZplDeps {
  rasterizeText?: RasterizeTextFn;
}

/**
 * True when `text` contains any character outside the printable Latin-1
 * range (ASCII 0x20-0x7E, Latin-1 Supplement 0xA0-0xFF) — Cyrillic, CJK,
 * emoji, etc. — that ZPL's built-in scalable font (`^A0`) cannot render, so
 * the text must be rasterized to an image instead. Iterates by code POINT
 * (not UTF-16 code unit) so astral characters (surrogate pairs) are never
 * mistaken for two in-range Latin-1 code units.
 */
export function needsImageRendering(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isPrintableAscii = code >= 0x20 && code <= 0x7e;
    const isPrintableLatin1Supplement = code >= 0xa0 && code <= 0xff;
    if (!isPrintableAscii && !isPrintableLatin1Supplement) return true;
  }
  return false;
}

/** `^FH`'s configurable hex-indicator character, used throughout this module. */
const HEX_INDICATOR = "_";
/**
 * ASCII 29 (Group Separator) — GS1's separator between variable-length AI
 * values. Built via `fromCharCode` (rather than a source-level escape) so no
 * raw control byte is ever embedded in this file.
 */
const GS = String.fromCharCode(0x1d);

function hexEscapeByte(ch: string): string {
  return HEX_INDICATOR + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
}

/**
 * Escapes `^FD` field data for safe transmission as ZPL. `^` (0x5E, the
 * Format prefix) and `~` (0x7E, the Control prefix) would otherwise be
 * misread as the start of a new command if they appeared inside the data
 * string; the hex-indicator character itself (`_`, 0x5F) must ALSO be
 * escaped so a literal underscore already present in the text is never
 * misread as the start of one of these escapes.
 *
 * Escaping goes through ZPL's `^FH` (Field Hexadecimal Indicator)
 * mechanism: prefixing the field with `^FH_` and writing `_xx` (two
 * uppercase hex digits) in place of each byte that needs it — this is the
 * "char substitution via ^FH hex" option from the two documented choices,
 * chosen over a bare backslash-substitution scheme because `^FH` is the
 * ZPL-native, printer-verified way to embed these bytes (see the
 * `renderGs1DataMatrixTail` doc comment below for the FNC1/GS case, which
 * reuses this exact mechanism).
 *
 * Returns the text UNCHANGED (empty `fh` prefix) when none of these three
 * characters occur, so the common case's ZPL output stays minimal and easy
 * to golden-test.
 */
function escapeFdData(text: string): { fh: string; data: string } {
  if (!/[\^~_]/.test(text)) return { fh: "", data: text };
  const data = text.replace(/[\^~_]/g, (ch) => hexEscapeByte(ch));
  return { fh: `^FH${HEX_INDICATOR}`, data };
}

/**
 * Builds the `^FH.../^FD.../^FS` tail for a GS1 DataMatrix payload (the
 * `km.code` field bound to a `datamatrix` barcode element) carrying the
 * leading FNC1 flag plus any embedded GS (AI) separators.
 *
 * FNC1 — the "this is GS1-formatted data" flag, always the FIRST character
 * of a GS1 DataMatrix message — is Zebra's documented `_1` escape: a
 * DEDICATED two-character sequence recognized by `^FH`'s hex-indicator
 * parser, NOT a `_xx` two-hex-digit byte escape. There is no ordinary
 * single-byte ASCII value for a symbology's function character, which is
 * exactly why Zebra reserved the otherwise-invalid/incomplete hex pair
 * `_1` for this one special case (a REAL `_xx` escape always has two hex
 * digits after the indicator). This matches Zebra's own documented
 * explanation of the common "printer literally prints `_1`" failure mode
 * on older firmware/simulators that don't recognize the special case (they
 * fall back to treating it as hex 5F followed by a literal `1`, i.e.
 * `_5F1`, instead of the dedicated FNC1 escape) — see
 * https://efficientbi.com/knowledge-base/barcode-printed-from-older-zebra-printer-has-extra-_1-in-gs1-code-zebra-problem/
 * — and a working `^BX`/`^FH_`/`_1`-prefixed GS1 DataMatrix ZPL example at
 * https://www.mail-archive.com/forum.help400@listas.combios.es/msg17312.html
 *
 * Embedded GS (ASCII 29, the separator GS1 uses BETWEEN variable-length AI
 * values mid-message) is an ORDINARY hex-escaped byte — `_1D` — under the
 * exact same `^FH_` mechanism used for `^`/`~`/`_` above; no special case
 * is needed since GS has a real single-byte value (0x1D).
 *
 * Escaping order matters: `^`/`~`/`_` are escaped FIRST, then raw GS bytes
 * are expanded to the literal three characters `_1D` SECOND — so the
 * underscore that expansion introduces is never re-escaped by the first
 * pass (which would corrupt it into `_5F1D`).
 */
function renderGs1DataMatrixTail(raw: string): string {
  const escapedSpecials = raw.replace(/[\^~_]/g, (ch) => hexEscapeByte(ch));
  const escaped = escapedSpecials.replace(new RegExp(GS, "g"), "_1D");
  return `^FH${HEX_INDICATOR}^FD_1${escaped}^FS`;
}

function alignToJustification(align: "left" | "center" | "right" | undefined): "L" | "C" | "R" {
  if (align === "center") return "C";
  if (align === "right") return "R";
  return "L";
}

/**
 * Renders a `text` or `field` element's resolved string as either native
 * ZPL text (`^A0N,<h>,<w>` + optional `^FB` block for align/maxWidth) or,
 * when the resolved text needs non-Latin-1 script rendering, a rasterized
 * `^GFA` image field. Shared by both element kinds since they differ only
 * in where their display text comes from (literal vs. `data` lookup).
 */
async function renderTextLikeElement(
  element: LabelTextElement | LabelFieldElement,
  text: string,
  spec: LabelTemplateSpec,
  deps: GenerateZplDeps,
): Promise<string> {
  const x = mmToDots(element.xMm, spec.dpi);
  const y = mmToDots(element.yMm, spec.dpi);

  if (needsImageRendering(text)) {
    if (!deps.rasterizeText) {
      throw new DomainError(
        "RASTER_REQUIRED",
        `label text "${text}" contains characters outside printable Latin-1 and needs image rendering, but no rasterizeText dependency was provided`,
      );
    }
    const fontSizePx = ptToDots(element.fontSizePt, spec.dpi);
    // Generic CSS family name, not an admin-specific bundled font: the
    // domain model has no per-element font-family selection, and this
    // package stays DOM/font-agnostic per the plan's Global Constraints —
    // the real rasterizer (apps/admin, Task 5) maps this however it likes.
    const raster = await deps.rasterizeText(text, {
      fontFamily: "sans-serif",
      fontSizePx,
      bold: element.bold ?? false,
    });
    return `^FO${x},${y}${buildGfaCommand(raster)}^FS`;
  }

  const heightDots = ptToDots(element.fontSizePt, spec.dpi);
  // Built-in scalable font 0 has no separate bold-weight parameter (that's
  // only meaningful for downloaded/TrueType fonts via ^A@); `bold` is fully
  // honored on the raster branch above (passed to rasterizeText) and is a
  // documented no-op for native ^A0 text, matching real ZPL font
  // capabilities rather than faking a heavier glyph via width tricks.
  const font = `^A0N,${heightDots},${heightDots}`;
  const { fh, data } = escapeFdData(text);

  if (element.maxWidthMm !== undefined) {
    const widthDots = mmToDots(element.maxWidthMm, spec.dpi);
    const justification = alignToJustification(element.align);
    const block = `^FB${widthDots},1,0,${justification},0`;
    return `^FO${x},${y}${font}${block}${fh}^FD${data}^FS`;
  }

  return `^FO${x},${y}${font}${fh}^FD${data}^FS`;
}

function resolveBarcodeSource(
  source: LabelBarcodeElement["data"],
  data: Record<LabelField, string>,
): { value: string; field?: LabelField } {
  if (typeof source === "string") return { value: data[source], field: source };
  return { value: source.literal };
}

function renderBarcodeElement(
  element: LabelBarcodeElement,
  data: Record<LabelField, string>,
  dpi: LabelTemplateSpec["dpi"],
): string {
  const x = mmToDots(element.xMm, dpi);
  const y = mmToDots(element.yMm, dpi);
  const { value, field } = resolveBarcodeSource(element.data, data);

  switch (element.format) {
    case "code128": {
      const heightDots = mmToDots(element.sizeMm, dpi);
      const { fh, data: escaped } = escapeFdData(value);
      return `^FO${x},${y}^BCN,${heightDots},N,N,N${fh}^FD${escaped}^FS`;
    }
    case "ean13": {
      const heightDots = mmToDots(element.sizeMm, dpi);
      const { fh, data: escaped } = escapeFdData(value);
      return `^FO${x},${y}^BEN,${heightDots}${fh}^FD${escaped}^FS`;
    }
    case "datamatrix": {
      const moduleDots = mmToDots(element.sizeMm, dpi);
      // Only the `km.code` FIELD (the Chestny ZNAK GS1 marking-code string,
      // AI-encoded with embedded GS separators) gets the GS1 FNC1/GS
      // treatment automatically — an arbitrary `{ literal }` override is
      // assumed to be exactly what the template author typed, not
      // necessarily GS1-formatted data, so it is NOT auto-escaped as GS1.
      if (field === "km.code") {
        return `^FO${x},${y}^BXN,${moduleDots},200${renderGs1DataMatrixTail(value)}`;
      }
      const { fh, data: escaped } = escapeFdData(value);
      return `^FO${x},${y}^BXN,${moduleDots},200${fh}^FD${escaped}^FS`;
    }
    case "qr": {
      const moduleDots = mmToDots(element.sizeMm, dpi);
      // ^BQ's magnification factor is documented as bounded 1-10; clamp so
      // an oversized module request still produces a valid command instead
      // of one the printer would reject outright.
      const mag = Math.max(1, Math.min(10, moduleDots));
      const { fh, data: escaped } = escapeFdData(value);
      // "QA," prefix: QR error-correction/mode selector understood by
      // Zebra's ^BQ (mode A / automatic input, most common convention).
      return `^FO${x},${y}^BQN,2,${mag}${fh}^FDQA,${escaped}^FS`;
    }
  }
}

/**
 * Renders a `line` element as a ZPL `^GB` (Graphic Box) spanning from
 * `(xMm,yMm)` to `(x2Mm,y2Mm)`. ZPL has no dedicated line-draw primitive —
 * a "line" IS a thin box — so the thinner axis is clamped up to at least
 * the requested thickness (otherwise a perfectly horizontal/vertical line
 * would emit a degenerate 0-dot box on that axis). A genuinely diagonal
 * line (both axes non-zero) degrades to its bounding rectangle: a
 * documented ZPL limitation, not a bug, since `^GB` cannot stroke a
 * diagonal.
 */
function renderLineElement(element: LabelLineElement, dpi: LabelTemplateSpec["dpi"]): string {
  const thicknessDots = mmToDots(element.thicknessMm, dpi);
  const spanXDots = mmToDots(Math.abs(element.x2Mm - element.xMm), dpi);
  const spanYDots = mmToDots(Math.abs(element.y2Mm - element.yMm), dpi);
  const widthDots = Math.max(spanXDots, thicknessDots);
  const heightDots = Math.max(spanYDots, thicknessDots);
  const originXDots = mmToDots(Math.min(element.xMm, element.x2Mm), dpi);
  const originYDots = mmToDots(Math.min(element.yMm, element.y2Mm), dpi);
  return `^FO${originXDots},${originYDots}^GB${widthDots},${heightDots},${thicknessDots}^FS`;
}

function renderBoxElement(element: LabelBoxElement, dpi: LabelTemplateSpec["dpi"]): string {
  const x = mmToDots(element.xMm, dpi);
  const y = mmToDots(element.yMm, dpi);
  const widthDots = mmToDots(element.widthMm, dpi);
  const heightDots = mmToDots(element.heightMm, dpi);
  const thicknessDots = mmToDots(element.thicknessMm, dpi);
  return `^FO${x},${y}^GB${widthDots},${heightDots},${thicknessDots}^FS`;
}

/**
 * Generates a complete ZPL document (`^XA ... ^XZ`) for `spec`, filling in
 * `text`/`field` elements' display text and `barcode` elements' encoded
 * data from `data`. Cyrillic/CJK/etc. text is rasterized through
 * `deps.rasterizeText` when provided; without it, such text throws
 * `DomainError("RASTER_REQUIRED", ...)` rather than silently printing
 * garbage or dropping the element.
 */
export async function generateZpl(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string>,
  deps: GenerateZplDeps = {},
): Promise<string> {
  const widthDots = mmToDots(spec.widthMm, spec.dpi);
  const heightDots = mmToDots(spec.heightMm, spec.dpi);

  const lines: string[] = ["^XA", `^PW${widthDots}`, `^LL${heightDots}`];

  // Sequential (not Promise.all): keeps element order deterministic in the
  // emitted document regardless of how fast/slow individual rasterizeText
  // calls resolve, and keeps a test double's call order predictable.
  for (const element of spec.elements) {
    switch (element.kind) {
      case "text":
        lines.push(await renderTextLikeElement(element, element.text, spec, deps));
        break;
      case "field":
        lines.push(await renderTextLikeElement(element, data[element.field] ?? "", spec, deps));
        break;
      case "barcode":
        lines.push(renderBarcodeElement(element, data, spec.dpi));
        break;
      case "line":
        lines.push(renderLineElement(element, spec.dpi));
        break;
      case "box":
        lines.push(renderBoxElement(element, spec.dpi));
        break;
    }
  }

  lines.push("^XZ");
  return lines.join("\n") + "\n";
}

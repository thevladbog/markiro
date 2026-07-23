/**
 * TSPL (TSC TSPL2) label document generator — emits complete, printer-ready
 * TSPL source text compatible with TSC thermal printers.
 *
 * BINARY CARRIER STRATEGY (BITMAP DATA):
 * When text requires rasterization (Cyrillic, CJK, etc.), the rasterized
 * bitmap is embedded in a TSPL `BITMAP` command whose raw binary payload is
 * carried as a plain JavaScript string with one Latin-1 character per byte
 * (via `String.fromCharCode(byte)` for each 0x00-0xFF value). This is NOT
 * UTF-8 or hex-encoded; it is the actual binary bytes, packed into JS's
 * native string type. This design choice made by the entire `@markiro/domain`
 * package (ZPL/TSPL/raster modules all use this same representation) has one
 * critical TRANSPORT REQUIREMENT:
 *
 * CRITICAL: When sending a TSPL document (or any `buildBitmapCommand` result)
 * to a printer, to a file, or to any external system, the sender MUST encode
 * the string using Latin-1 (ISO-8859-1) or binary encoding, NOT UTF-8. UTF-8
 * would multi-byte-encode any character code >= 0x80, corrupting every bit in
 * the binary payload (e.g., byte 0x80 becomes 0xC2 0x80 in UTF-8, destroying
 * the bitmap data). The receiving printer or file system MUST see exactly the
 * byte sequence embedded in the string: one byte per character. Both the
 * downstream print station (Plan 05) and any admin Blob/file download handler
 * must enforce Latin-1/binary encoding. See this task's report for a
 * durability note linking to the verification checklist.
 *
 * OPEN HARDWARE QUESTION (GS1 DataMatrix / FNC1):
 * TSPL's plain `DMATRIX` command (used for `km.code` GS1 DataMatrix barcodes)
 * has UNVERIFIED GS1/FNC1 handling. The `km.code` value is emitted RAW into
 * the DMATRIX command — verbatim, with embedded GS (0x1D) bytes passed through
 * as-is, with no FNC1 prefix and no escaping beyond the ordinary `""-doubling
 * for string literals. This worked for ZPL's documented `^FH` FNC1 convention,
 * but TSC's manual for TSPL `DMATRIX` contains only a generic control-character
 * escape (`cXXX` form, e.g. `c126` for `~`) with no specific GS1 example or
 * verified mode parameter. Plan 05's hardware verification pass MUST:
 *   1. Print a test label with a GS1 DataMatrix (km.code with embedded GS bytes).
 *   2. Scan the printed barcode on a physical TSC printer to verify it renders
 *      as valid GS1 and decodes correctly.
 *   3. If rendering fails, investigate:
 *      - Whether DMATRIX needs an explicit FNC1 prefix (e.g., a documented
 *        control-character escape like `c232` or `c157` per TSC's own table).
 *      - Whether a firmware update or newer DMATRIX parameter mode is required.
 *   4. Document the outcome (success / required firmware / parameter change) in
 *      the Plan 05 report so Plan 06+ can close this question durably.
 */

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
import { buildBitmapCommand, rasterAlignOffsetDots, type RasterizeTextFn } from "./raster-types.js";
import { needsImageRendering } from "./text.js";

export { buildBitmapCommand, rasterAlignOffsetDots } from "./raster-types.js";
export type { RasterResult, RasterizeTextFn } from "./raster-types.js";
// Re-exported for symmetry with zpl.ts (same shared check, same barrel shape).
export { needsImageRendering } from "./text.js";

export interface GenerateTsplDeps {
  rasterizeText?: RasterizeTextFn;
}

/**
 * Escapes a TSPL string-literal parameter's content by doubling any literal
 * `"` (TSPL's own string-escaping convention — there is no backslash
 * escape). Every string-valued command parameter this module emits
 * (`TEXT`, `BARCODE`, `DMATRIX`, `QRCODE` content) is passed through this.
 */
function escapeTsplString(text: string): string {
  return text.replace(/"/g, '""');
}

/**
 * Maps the domain model's `align` to TSPL `TEXT`'s optional alignment
 * parameter (added in firmware V6.73 EZ): 1 = Left, 2 = Center, 3 = Right.
 * Returns `undefined` for an unset `align` so the caller can omit the
 * parameter entirely and fall back to TSPL's own default (left).
 */
function alignToTsplAlignment(
  align: "left" | "center" | "right" | undefined,
): 1 | 2 | 3 | undefined {
  if (align === "left") return 1;
  if (align === "center") return 2;
  if (align === "right") return 3;
  return undefined;
}

/**
 * Renders a `text` or `field` element's resolved string as either native
 * TSPL text (`TEXT x,y,"0",0,<xmul>,<ymul>[,<alignment>],"..."`) or, when
 * the resolved text contains any non-ASCII character, a rasterized
 * `BITMAP` command (see `text.ts`'s `needsImageRendering` doc comment for
 * why the native path is ASCII-only rather than Latin-1). Mirrors
 * `zpl.ts`'s `renderTextLikeElement` (same signature, same raster-fallback
 * structure) since text/field elements differ only in where their display
 * text comes from.
 *
 * TEXT SIZING (verified against the TSC TSPL2 Programming Manual): font
 * `"0"` is documented as "Monotype CG Triumvirate Bold Condensed with
 * stretchable width/height" — an internal TRUE TYPE font, NOT one of the
 * numbered fixed-pitch bitmap fonts (1-8). For the numbered bitmap fonts,
 * `TEXT`'s x-multiplication/y-multiplication parameters are a small integer
 * scale factor (1-10x) applied to a fixed base glyph size. For font `"0"`
 * (and `"ROMAN.TTF"`), the manual explicitly documents these SAME two
 * parameter slots as instead specifying the true type font's width/height
 * DIRECTLY IN POINTS (1 point = 1/72 inch — the exact unit our domain
 * model's `fontSizePt` already uses). So `fontSizePt` is passed straight
 * through as both parameters (a non-stretched, proportionally-scaled
 * glyph) with NO `ptToDots` conversion — `x`/`y` (the position) are still
 * converted to dots as usual, only the font-size parameters are points.
 * This is the "OR the '0' font accepts point size" branch flagged as an
 * open question in this task's brief; pinned here with this golden test.
 *
 * `bold` has no native effect here (font `"0"` has no separate weight
 * parameter, matching ZPL's `^A0` built-in font) — it is fully honored on
 * the raster branch below (passed to `rasterizeText`) only, exactly like
 * `zpl.ts`. `maxWidthMm` has no NATIVE TSPL equivalent either: unlike ZPL's
 * `^FB` (a field-block command that takes an explicit width to wrap/justify
 * text within), TSPL's `TEXT` alignment parameter has no accompanying
 * width — it aligns relative to the given `x`/`y` alone, so the NATIVE
 * branch below accepts but ignores `maxWidthMm` (a deliberate, documented
 * no-op rather than inventing an unsupported wrapping behavior). The
 * RASTER branch is different: since it emits a plain positioned `BITMAP`
 * (not a native alignment-aware command), it honors `align`/`maxWidthMm`
 * itself by shifting the bitmap's x via `rasterAlignOffsetDots` — see that
 * function's doc comment.
 *
 * VERTICAL-BASELINE HEURISTIC (rasterized branch only, documented trade-off
 * not a bug — identical to `zpl.ts`'s own note on its raster branch, see
 * that doc comment for the full rationale): the bitmap is positioned with
 * its TOP-LEFT corner at `(x, y)`, but `apps/admin/src/labels/rasterizer.ts`
 * draws the glyphs `textBaseline = "middle"` vertically CENTERED inside a
 * `1.5em`-tall box rather than flush against the box's top edge, so a
 * rasterized glyph sits ~`0.25em` lower than a native-ASCII glyph would at
 * the identical `yMm`. WYSIWYG still holds: `PreviewPane.tsx` composites
 * this exact same bitmap on screen, so the preview and the print are always
 * pixel-identical even though this offset exists relative to native text.
 */
async function renderTextLikeElement(
  element: LabelTextElement | LabelFieldElement,
  text: string,
  spec: LabelTemplateSpec,
  deps: GenerateTsplDeps,
): Promise<string> {
  const x = mmToDots(element.xMm, spec.dpi);
  const y = mmToDots(element.yMm, spec.dpi);

  if (needsImageRendering(text)) {
    if (!deps.rasterizeText) {
      throw new DomainError(
        "RASTER_REQUIRED",
        `label text "${text}" contains characters outside printable ASCII and needs image rendering, but no rasterizeText dependency was provided`,
      );
    }
    const fontSizePx = ptToDots(element.fontSizePt, spec.dpi);
    const raster = await deps.rasterizeText(text, {
      fontFamily: "sans-serif",
      fontSizePx,
      bold: element.bold ?? false,
    });
    // Honor align/maxWidthMm — see zpl.ts's identical raster-branch offset
    // and `rasterAlignOffsetDots`'s doc comment for the full rationale.
    // Unlike native TSPL `TEXT` (whose alignment parameter has no
    // accompanying width, see this function's doc comment above), a
    // rasterized element DOES carry `maxWidthMm` through to this offset, so
    // a rasterized (e.g. Cyrillic) centered/right-aligned text still lines
    // up the same way the ZPL raster branch does.
    const maxWidthDots =
      element.maxWidthMm !== undefined ? mmToDots(element.maxWidthMm, spec.dpi) : undefined;
    const offsetXDots = rasterAlignOffsetDots(element.align, maxWidthDots, raster.width);
    return buildBitmapCommand(x + offsetXDots, y, raster);
  }

  const alignment = alignToTsplAlignment(element.align);
  const alignmentParam = alignment !== undefined ? `${alignment},` : "";
  const size = element.fontSizePt;
  return `TEXT ${x},${y},"0",0,${size},${size},${alignmentParam}"${escapeTsplString(text)}"`;
}

function resolveBarcodeSource(
  source: LabelBarcodeElement["data"],
  data: Record<LabelField, string>,
): { value: string; field?: LabelField } {
  if (typeof source === "string") return { value: data[source] ?? "", field: source };
  return { value: source.literal };
}

/**
 * Renders a `barcode` element as one of TSPL's dedicated barcode/matrix
 * commands.
 *
 * `code128`/`ean13` use `BARCODE x,y,"<type>",<height>,1,0,2,2,"<data>"` —
 * human-readable text ON (`1`), no rotation, narrow/wide bar widths fixed
 * at 2 dots each (this task's brief pins this exact parameter shape; no
 * per-element control over bar widths exists in the domain model).
 *
 * `qr` uses `QRCODE x,y,<ECC>,<cell>,<mode>,<rotation>,"<data>"` — ECC
 * level fixed at `M` (~15% recovery, a reasonable general-purpose default;
 * the domain model has no per-element ECC control), mode `A` (automatic
 * character-set detection), no rotation, cell width clamped to TSPL's
 * documented 1-10 dot range (mirrors ZPL's `^BQ` magnification clamp).
 *
 * `datamatrix` uses the brief's pinned minimal form,
 * `DMATRIX x,y,<w>,<h>,"<data>"` — deliberately WITHOUT the extended,
 * letter-prefixed optional parameters (`x#`/`row`/`col`, etc.) that later
 * TSPL2 firmware adds for specifying an exact module size. This is a
 * SEMANTIC APPROXIMATION worth flagging: `w`/`h` here are TSPL's "expected
 * width/height of barcode area" (an outer bounding box the printer fits
 * the symbol into), NOT a per-module dot size the way this task's `sizeMm`
 * is documented in `model.ts` ("for matrix codes = module square side") —
 * unlike ZPL's `^BX`, which takes a literal module-size parameter matching
 * that semantic exactly. Reusing `mmToDots(sizeMm, dpi)` as BOTH `w` and
 * `h` keeps behavior close to the brief's pinned literal syntax and to
 * ZPL's numeric convention, but is an approximation: hardware verification
 * in Plan 05 should confirm the printed module size/legibility on a real
 * TSC printer and switch to the extended `x#`-parameter form if this proves
 * too coarse.
 *
 * GS1 / `km.code`: unlike ZPL (which has a documented `^FH`/FNC1 escape
 * convention for GS1 DataMatrix — see `zpl.ts`'s `renderGs1DataMatrixTail`),
 * this module found NO equivalently-documented, simple GS1/FNC1 escape for
 * TSPL's plain `DMATRIX` form during research for this task (TSC's manual
 * only documents a generic `cXXX` control-character escape, e.g. `c126` for
 * `~`, with no worked GS1 example). Per this task's brief, the `km.code`
 * value is therefore emitted RAW — verbatim, including any embedded GS
 * (0x1D) bytes, with NO FNC1 prefix and NO escaping beyond the ordinary
 * `"`-doubling every string goes through. THIS IS AN OPEN QUESTION, not a
 * confirmed correct encoding: Plan 05's hardware verification MUST confirm
 * whether a physical TSC printer decodes this as valid GS1 DataMatrix, or
 * whether it needs an explicit FNC1 prefix (e.g. a documented `c232`-style
 * control-character escape) or a newer firmware's dedicated GS1 mode
 * parameter. See this task's report for the ledger note.
 */
function renderBarcodeElement(
  element: LabelBarcodeElement,
  data: Record<LabelField, string>,
  dpi: LabelTemplateSpec["dpi"],
): string {
  const x = mmToDots(element.xMm, dpi);
  const y = mmToDots(element.yMm, dpi);
  const { value } = resolveBarcodeSource(element.data, data);

  switch (element.format) {
    case "code128": {
      const heightDots = mmToDots(element.sizeMm, dpi);
      return `BARCODE ${x},${y},"128",${heightDots},1,0,2,2,"${escapeTsplString(value)}"`;
    }
    case "ean13": {
      const heightDots = mmToDots(element.sizeMm, dpi);
      return `BARCODE ${x},${y},"EAN13",${heightDots},1,0,2,2,"${escapeTsplString(value)}"`;
    }
    case "datamatrix": {
      const sideDots = mmToDots(element.sizeMm, dpi);
      return `DMATRIX ${x},${y},${sideDots},${sideDots},"${escapeTsplString(value)}"`;
    }
    case "qr": {
      const cellDots = Math.max(1, Math.min(10, mmToDots(element.sizeMm, dpi)));
      return `QRCODE ${x},${y},M,${cellDots},A,0,"${escapeTsplString(value)}"`;
    }
  }
}

/**
 * Renders a `line` element as a TSPL `BAR` (solid filled rectangle) — TSPL
 * has no dedicated line-draw primitive either, exactly like ZPL's `^GB`
 * hack in `zpl.ts`'s `renderLineElement`, whose thin-axis-clamping and
 * diagonal-degrades-to-bounding-box behavior this mirrors verbatim (see
 * that function's doc comment for the full rationale).
 */
function renderLineElement(element: LabelLineElement, dpi: LabelTemplateSpec["dpi"]): string {
  const thicknessDots = mmToDots(element.thicknessMm, dpi);
  const spanXDots = mmToDots(Math.abs(element.x2Mm - element.xMm), dpi);
  const spanYDots = mmToDots(Math.abs(element.y2Mm - element.yMm), dpi);
  const widthDots = Math.max(spanXDots, thicknessDots);
  const heightDots = Math.max(spanYDots, thicknessDots);
  const originXDots = mmToDots(Math.min(element.xMm, element.x2Mm), dpi);
  const originYDots = mmToDots(Math.min(element.yMm, element.y2Mm), dpi);
  return `BAR ${originXDots},${originYDots},${widthDots},${heightDots}`;
}

/**
 * Renders a `box` element as a TSPL `BOX x_start,y_start,x_end,y_end,
 * thickness`. Unlike ZPL's `^GB` (which takes width/height), TSPL's `BOX`
 * takes the diagonally-opposite CORNER coordinates (verified against the
 * TSC TSPL2 manual: "x_start,y_start,x_end,y_end,line_thickness[,corner_
 * radius]" — upper-left to lower-right), so the end corner is derived by
 * adding the element's width/height (in dots) to its origin. The optional
 * trailing `corner_radius` parameter is omitted (square corners).
 */
function renderBoxElement(element: LabelBoxElement, dpi: LabelTemplateSpec["dpi"]): string {
  const x = mmToDots(element.xMm, dpi);
  const y = mmToDots(element.yMm, dpi);
  const xEnd = x + mmToDots(element.widthMm, dpi);
  const yEnd = y + mmToDots(element.heightMm, dpi);
  const thicknessDots = mmToDots(element.thicknessMm, dpi);
  return `BOX ${x},${y},${xEnd},${yEnd},${thicknessDots}`;
}

/**
 * Generates a complete TSPL document (`SIZE ... PRINT 1`) for `spec`,
 * filling in `text`/`field` elements' display text and `barcode` elements'
 * encoded data from `data`. Cyrillic/CJK/etc. text is rasterized through
 * `deps.rasterizeText` when provided; without it, such text throws
 * `DomainError("RASTER_REQUIRED", ...)` — same contract as `generateZpl`.
 *
 * Unlike ZPL's `^PW`/`^LL` (which take dots), TSPL's `SIZE`/`GAP` commands
 * take real-world units directly, so `widthMm`/`heightMm` are emitted
 * as-is (no `mmToDots`). `GAP 2 mm, 0 mm` (a 2mm physical gap between
 * labels on the roll, 0mm offset) and `DIRECTION 1` are FIXED constants —
 * neither is part of `LabelTemplateSpec` (gap/media-calibration is a
 * printer/media property, not a template property); this is a documented
 * MVP default, not a per-template setting.
 */
export async function generateTspl(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string>,
  deps: GenerateTsplDeps = {},
): Promise<string> {
  const lines: string[] = [
    `SIZE ${spec.widthMm} mm, ${spec.heightMm} mm`,
    "GAP 2 mm, 0 mm",
    "DIRECTION 1",
    "CLS",
  ];

  // Sequential (not Promise.all) — see generateZpl's identical rationale:
  // deterministic element order in the document and predictable mock
  // call order in tests, regardless of individual rasterizeText timing.
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

  lines.push("PRINT 1");
  return lines.join("\n") + "\n";
}

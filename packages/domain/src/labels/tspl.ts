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
  labelFieldDisplayValue,
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
import { estimatedTextWidthMm, LINE_HEIGHT_EM, ptToMm, wrapTextToWidth } from "./wrap.js";

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
 * The x-offset (in dots) that centres/right-aligns ONE already-wrapped native
 * line inside its element's `maxWidthMm` box — the native-text counterpart of
 * the raster branch's identical call, sharing the exact same
 * `rasterAlignOffsetDots` arithmetic so a template's `align` lands in the same
 * place whether the text was rasterized or not.
 *
 * WHY TSPL COMPUTES THIS ITSELF, rather than passing `align` to `TEXT`'s own
 * alignment parameter (1 = Left, 2 = Center, 3 = Right, firmware V6.73 EZ+),
 * which is what this module used to do: that parameter carries NO WIDTH. It
 * aligns the string about the `TEXT` command's own `x` — so `align: "center"`
 * on an element at `xMm: 2` centres the string ON 2 mm, i.e. half of it hangs
 * off the left edge of the label. Every other renderer in this repo means
 * something different by `align`: ZPL puts it in an `^FB<width>,…,C,…` field
 * block (centred INSIDE the `maxWidthMm` box that starts at `x`), the admin
 * preview (`apps/admin/src/pages/labels/renderer.ts`) draws at
 * `x + boxWidth/2`, and both emitters' raster branches shift the bitmap by
 * `rasterAlignOffsetDots`. A `LabelTemplateSpec` is language-neutral — the
 * same template is emitted as ZPL or TSPL depending on which printer the
 * station has (`hardware-config.ts`'s `printerLanguage`) — so a per-language
 * reading of `align` is a defect by construction, exactly like the HRI
 * parameter this module already documents. TSPL now agrees with everyone
 * else, and the alignment parameter is no longer emitted at all.
 *
 * WITHOUT `maxWidthMm` the offset is 0 and `align` is a documented no-op, for
 * the same reason it is one in ZPL's native branch and in the preview: there
 * is no box to align within. That is also what `rasterAlignOffsetDots`
 * already returns for `maxWidthDots === undefined`.
 *
 * The line's width is the DOM-free `estimatedTextWidthMm` estimate (0.55em
 * per glyph), not a measurement — this package cannot measure the printer's
 * internal font, and it is the same estimate `wrapNativeText` below and
 * `bounds.ts` use, so the wrap, the bounds and the offset can never disagree
 * with each other. Font `"0"` is Triumvirate Bold CONDENSED, narrower than
 * 0.55em, so the estimate errs slightly wide and a centred line lands a
 * fraction of a millimetre left of true centre — a far smaller error than the
 * half-a-string displacement the alignment parameter produced.
 */
function nativeAlignOffsetDots(
  element: LabelTextElement | LabelFieldElement,
  line: string,
  maxWidthDots: number | undefined,
  dpi: LabelTemplateSpec["dpi"],
): number {
  return rasterAlignOffsetDots(
    element.align,
    maxWidthDots,
    mmToDots(estimatedTextWidthMm(line, element.fontSizePt), dpi),
  );
}

/**
 * Breaks a NATIVE-text element's string against its `maxWidthMm`.
 *
 * TSPL's `TEXT` has no field-block equivalent of ZPL's `^FB` — its alignment
 * parameter carries no width — so there is nothing to hand the printer and
 * nothing that can measure the printer's own internal font from here. The
 * width is therefore ESTIMATED (`wrap.ts`'s `estimatedTextWidthMm`,
 * 0.55em per character) and the string is split into at most `maxLines`
 * lines that the caller emits as separate positioned `TEXT` commands.
 *
 * This is an approximation, and deliberately a conservative one: font `"0"`
 * is Triumvirate Bold CONDENSED, narrower than the 0.55em average this
 * estimate assumes, so it errs toward breaking a line early rather than
 * letting it run past `maxWidthMm`. It is not a guarantee the way the
 * raster branch's real `measureText` is — but the alternative, which is what
 * this module did before, is `maxWidthMm` being ignored outright and long
 * text running off the label with nothing bounding it at all.
 *
 * Returns `null` — "emit the string as-is, on one line" — whenever the
 * element declares no `maxWidthMm` or the estimate says the text already
 * fits untouched, so previously-authored templates emit byte-identical
 * output.
 */
function wrapNativeText(
  element: LabelTextElement | LabelFieldElement,
  text: string,
): string[] | null {
  if (element.maxWidthMm === undefined) return null;
  const lines = wrapTextToWidth(
    text,
    (s) => estimatedTextWidthMm(s, element.fontSizePt),
    element.maxWidthMm,
    element.maxLines ?? 1,
  );
  if (lines.length === 1 && lines[0] === text) return null;
  return lines;
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
 * `zpl.ts`.
 *
 * `align`/`maxWidthMm` have NO usable native TSPL equivalent: unlike ZPL's
 * `^FB` (a field-block command taking an explicit width to wrap and justify
 * text within), TSPL's `TEXT` alignment parameter carries no width and
 * aligns about the command's own `x`. BOTH branches therefore do the work
 * themselves and in exactly the same way — the native one wraps against the
 * width estimate (`wrapNativeText`) and shifts each line by
 * `nativeAlignOffsetDots`, the raster one bounds the bitmap through
 * `maxWidthPx`/`maxLines` and shifts it by `rasterAlignOffsetDots`. Both
 * offsets are the same `rasterAlignOffsetDots` arithmetic, so a centred
 * Cyrillic line and a centred ASCII line land in the same place, and both
 * land where ZPL's `^FB` and the admin preview put them.
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
    const maxWidthDots =
      element.maxWidthMm !== undefined ? mmToDots(element.maxWidthMm, spec.dpi) : undefined;
    // `maxWidthPx`/`maxLines` bound the bitmap itself — identical to zpl.ts's
    // raster branch; see `RasterizeTextOptions`'s doc comment.
    const raster = await deps.rasterizeText(text, {
      fontFamily: "sans-serif",
      fontSizePx,
      bold: element.bold ?? false,
      maxWidthPx: maxWidthDots,
      maxLines: element.maxLines ?? 1,
    });
    // Honor align/maxWidthMm — see zpl.ts's identical raster-branch offset
    // and `rasterAlignOffsetDots`'s doc comment for the full rationale.
    // Unlike native TSPL `TEXT` (whose alignment parameter has no
    // accompanying width, see this function's doc comment above), a
    // rasterized element DOES carry `maxWidthMm` through to this offset, so
    // a rasterized (e.g. Cyrillic) centered/right-aligned text still lines
    // up the same way the ZPL raster branch does.
    const offsetXDots = rasterAlignOffsetDots(element.align, maxWidthDots, raster.width);
    return buildBitmapCommand(x + offsetXDots, y, raster);
  }

  const size = element.fontSizePt;
  const maxWidthDots =
    element.maxWidthMm !== undefined ? mmToDots(element.maxWidthMm, spec.dpi) : undefined;
  // `null` means "emit the string untouched, on one line" — the alignment
  // offset below is computed per LINE either way, so a single unwrapped line
  // is just the one-element case and produces the identical command.
  const lines = wrapNativeText(element, text) ?? [text];
  // One `TEXT` per wrapped line, stepped by the same 1.5em line box the
  // rasterizers use, so a wrapped native line and a wrapped rasterized one
  // occupy the same vertical footprint.
  const lineStepDots = mmToDots(ptToMm(element.fontSizePt) * LINE_HEIGHT_EM, spec.dpi);
  return lines
    .map((line, i) => {
      // Per-line, matching ZPL's `^FB` (which centres each line of a field
      // block individually) rather than aligning the block as a whole.
      const offsetXDots = nativeAlignOffsetDots(element, line, maxWidthDots, spec.dpi);
      return `TEXT ${x + offsetXDots},${y + i * lineStepDots},"0",0,${size},${size},"${escapeTsplString(line)}"`;
    })
    .join("\n");
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
 * `code128`/`ean13` use `BARCODE x,y,"<type>",<height>,0,0,<n>,<n>,"<data>"` —
 * human-readable interpretation line OFF (`0`), no rotation, and narrow/wide
 * bar widths from the element's `moduleWidthMm` (falling back to the
 * historical fixed 2 dots when it declares none — see `barWidthParams`).
 *
 * HRI IS OFF ON PURPOSE, and this parameter used to be `1`. A
 * `LabelTemplateSpec` is language-neutral: the SAME template is emitted as
 * ZPL or as TSPL depending on which printer the station happens to have
 * (`hardware-config.ts`'s `printerLanguage`), so any per-language difference
 * is a defect by construction. ZPL's `^BCN,<h>,N,N,N` prints no
 * interpretation line, so a TSPL `1` here meant the identical template
 * printed readable SSCC digits on a TSC printer and none at all on a Zebra —
 * and the extra TSPL-only line, which the template author never laid out,
 * printed on top of whatever sat beneath the barcode (on the stock 58×40 box
 * label it fell off the bottom edge entirely). Both languages now agree on
 * "bars only"; a template that wants readable digits places an explicit
 * `text`/`field` element under the barcode, which is WYSIWYG in the admin
 * preview and renders identically in both languages — see
 * `defaults.ts`'s `val-sscc`.
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
/**
 * `BARCODE`'s narrow/wide bar-width pair, in dots — the TSPL counterpart of
 * ZPL's `^BY` (see `zpl.ts`'s `barWidthCommand`).
 *
 * `TSPL_DEFAULT_NARROW_DOTS` is the historical hard-coded value this module
 * emitted for every barcode, and it is still what an element WITHOUT an
 * explicit `moduleWidthMm` gets, so previously-authored templates emit
 * byte-identical output. It is also why this parameter cannot simply be left
 * alone: 2 dots is 0.25 mm at 203 dpi (exactly GS1's minimum X-dimension) but
 * only 0.17 mm at 300 dpi, BELOW that minimum — so the same template that
 * scanned fine on a 203 dpi TSC printed an out-of-spec symbol on a 300 dpi
 * one. An element that states its X-dimension gets it converted to dots here.
 *
 * Both parameters are set to the same value: Code 128 is not a two-width
 * symbology (its four element widths are all multiples of the X-dimension),
 * so TSPL's "wide" parameter carries no ratio meaning for it, and EAN-13 is
 * likewise module-based.
 */
const TSPL_DEFAULT_NARROW_DOTS = 2;

function barWidthParams(element: LabelBarcodeElement, dpi: LabelTemplateSpec["dpi"]): string {
  const narrow =
    element.moduleWidthMm === undefined
      ? TSPL_DEFAULT_NARROW_DOTS
      : Math.max(1, mmToDots(element.moduleWidthMm, dpi));
  return `${narrow},${narrow}`;
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
      // A code128 bound to `sscc` is a GS1-128, not a plain Code 128: TSPL's
      // `"128"` barcode type takes FNC1 as the two literal characters `!1`
      // inside the data (per TSC's TSPL2 manual, code-page permitting) —
      // the TSPL equivalent of `zpl.ts`'s `>;>8` (subset-C-select + FNC1)
      // in its own `code128` case; see that comment for the full
      // rationale. The AI (`00`) is added HERE and nowhere else — storage
      // and transport carry the bare 18 digits.
      const payload = field === "sscc" ? `!100${value}` : value;
      const bars = barWidthParams(element, dpi);
      return `BARCODE ${x},${y},"128",${heightDots},0,0,${bars},"${escapeTsplString(payload)}"`;
    }
    case "ean13": {
      const heightDots = mmToDots(element.sizeMm, dpi);
      const bars = barWidthParams(element, dpi);
      return `BARCODE ${x},${y},"EAN13",${heightDots},0,0,${bars},"${escapeTsplString(value)}"`;
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
        lines.push(
          await renderTextLikeElement(
            element,
            labelFieldDisplayValue(element.field, data),
            spec,
            deps,
          ),
        );
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

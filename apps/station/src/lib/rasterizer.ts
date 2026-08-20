// Station-side rasterizer. Deliberately identical in behaviour to
// apps/admin/src/labels/rasterizer.ts — the admin editor's preview and the
// station's print must produce the same bitmap, or «предпросмотр = печать»
// breaks the moment a station prints a template the admin previewed. The
// font-family mapping in particular must not drift between the two.
/**
 * Browser `<canvas>` implementation of `@markiro/domain`'s injectable
 * `RasterizeTextFn` (see `packages/domain/src/labels/raster-types.ts`'s doc
 * comment: "The real implementation ... lives in `apps/admin` (Task 5)").
 * This module ONLY draws text and reads pixels back -- the actual pixel
 * math (grayscale, threshold, hex packing) is composed in from the domain
 * package's DOM-free primitives (`convertToMonochrome`, `bitmapToZplHex`),
 * per the plan's Global Constraint that `packages/domain` stays
 * zero-dependency and DOM-free.
 *
 * Idento parity note (`panel/src/features/badge/zpl/canvasRasterizer.ts`):
 * jsdom's `HTMLCanvasElement.prototype.getContext("2d")` returns `null`
 * unless the optional native `canvas` npm package is installed (it
 * deliberately is NOT a dependency of this app), so under the admin test
 * suite's jsdom environment this always throws the typed
 * `RasterUnavailableError` below rather than silently producing garbage
 * pixel data -- exactly Idento's pattern, pinned by
 * `test/labels-raster.test.ts`.
 */
import {
  bitmapToZplHex,
  convertToMonochrome,
  wrapTextToWidth,
  type RasterizeTextFn,
  type RasterizeTextOptions,
} from "@markiro/domain";

/**
 * Thrown when a browser 2D canvas context could not be obtained -- either
 * because the current environment has no real canvas implementation
 * (jsdom without the optional `canvas` package) or, in principle, because a
 * real browser refused to grant one (e.g. exhausted canvas budget). Typed
 * (rather than a bare `Error`) so callers -- and this task's pinned test --
 * can distinguish "rasterization is unavailable here" from any other
 * failure inside `rasterizeText`.
 */
export class RasterUnavailableError extends Error {
  constructor(message = "2D canvas rendering context is unavailable in this environment") {
    super(message);
    this.name = "RasterUnavailableError";
  }
}

function getCanvas2dContext(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new RasterUnavailableError();
  }
  return ctx;
}

/**
 * Maps a GENERIC CSS font-family keyword -- the only kind `@markiro/domain`'s
 * `generateZpl`/`generateTspl` ever pass (they stay font-agnostic per the
 * plan's Global Constraints, see `zpl.ts`'s `renderTextLikeElement`) -- to
 * this app's actual BUNDLED font family (`fontCoverage.ts`'s
 * `LabelFontFamily` union: "IBM Plex Sans" / "IBM Plex Mono"), WITH the
 * generic keyword kept as the trailing CSS fallback. Without this mapping,
 * `ctx.font = "400 34px sans-serif"` would measure/draw against whatever
 * generic system sans-serif the browser substitutes -- NOT the bundled
 * IBM Plex family this app's font-coverage check (and its `@font-face`
 * declarations elsewhere in the app) are actually built around -- breaking
 * the "предпросмотр = печать" WYSIWYG promise between this rasterizer's
 * output and `PreviewPane.tsx`'s own bundled-font-based coverage check.
 * Falls back to `family` UNCHANGED for anything not in this map (defensive
 * only: every caller in this codebase passes exactly one of the two generic
 * keywords below, or -- from `PreviewPane.tsx` -- an already-bundled family
 * name like `"IBM Plex Sans"` itself, which simply round-trips unchanged).
 */
export function mapFontFamily(family: string): string {
  if (family === "sans-serif") return "IBM Plex Sans, sans-serif";
  if (family === "monospace") return "IBM Plex Mono, monospace";
  return family;
}

/** Builds the `ctx.font` shorthand this module uses everywhere: `"<weight> <sizePx>px <mapped family>"`. */
function buildFontShorthand(fontFamily: string, fontSizePx: number, bold: boolean): string {
  return `${bold ? 700 : 400} ${fontSizePx}px ${mapFontFamily(fontFamily)}`;
}

/**
 * Synchronous core of `rasterizeText` (below): measures and draws `text`
 * via a browser `<canvas>`, then hands the pixel data to the domain
 * package's DOM-free packing primitives. Mirrors Idento's
 * `canvasRasterizer.ts` measure-then-draw sequence:
 *
 * 1. `ctx.font = "<weight> <sizePx>px <mapped family>"` (bold -> 700, else
 *    400; family run through `mapFontFamily` above so a generic
 *    "sans-serif"/"monospace" keyword resolves to this app's actual bundled
 *    IBM Plex family, not a browser system-font substitute).
 * 2. Measure `text`'s rendered width via `measureText` on a throwaway 1x1
 *    context (a canvas must already have SOME context to measure text, and
 *    resizing a canvas after the fact resets its 2D state including
 *    `font`, so measurement happens on its own context before the
 *    real, correctly-sized one is created).
 * 3. Break the text against `maxWidthPx`/`maxLines` using that same live
 *    `measureText` as `wrapTextToWidth`'s measure function. THIS IS WHAT
 *    KEEPS THE BITMAP ON THE LABEL: the emitters position the returned
 *    bitmap at the element's `^FO`/`BITMAP` origin and never clip it, so a
 *    bitmap sized from the raw text's own width -- what this function used
 *    to return -- printed a long Cyrillic product name straight off the
 *    right edge of a 58 mm label. `RasterizeTextOptions`'s doc comment
 *    states the contract; overflow that still does not fit is ellipsized by
 *    `wrapTextToWidth` so the operator can see the name was cut.
 * 4. Line box height is `ceil(sizePx * 1.5)` per line -- a simple,
 *    deterministic heuristic (not real font-metrics ascent/descent),
 *    matching the plan brief rather than reading font-specific metrics that
 *    vary per family/weight. A single unwrapped line therefore produces
 *    exactly the same bitmap this function always did.
 * 5. Fill the sized canvas white, draw each line in black with
 *    `textBaseline = "middle"` at its line box's vertical center, then
 *    `getImageData` the whole canvas and convert/pack it through
 *    `@markiro/domain`.
 *
 * Kept separate from the exported `rasterizeText` below (rather than folding
 * everything into that function's body) purely so `RasterUnavailableError`
 * -- thrown synchronously here, the instant `getCanvas2dContext` fails --
 * stays a plain synchronous throw that the wrapper explicitly narrows and
 * re-throws, rather than this function itself juggling the font-loading
 * `await` too.
 */
function rasterizeTextSync(
  text: string,
  { fontFamily, fontSizePx, bold, maxWidthPx, maxLines }: RasterizeTextOptions,
) {
  const font = buildFontShorthand(fontFamily, fontSizePx, bold);

  const measureCtx = getCanvas2dContext(1, 1);
  measureCtx.font = font;
  const measure = (s: string) => measureCtx.measureText(s).width;

  const bounded = maxWidthPx !== undefined && maxWidthPx > 0;
  const lines = bounded ? wrapTextToWidth(text, measure, maxWidthPx, maxLines ?? 1) : [text];
  const lineHeight = Math.ceil(fontSizePx * 1.5);
  const naturalWidth = Math.ceil(Math.max(...lines.map(measure)));
  // Clamped as well as wrapped: `measure` is fractional and `wrapTextToWidth`
  // only guarantees each line is <= maxWidthPx BEFORE the ceil, so a line
  // that exactly fills the box could otherwise round one dot past it.
  const width = Math.max(1, bounded ? Math.min(maxWidthPx, naturalWidth) : naturalWidth);
  const height = lineHeight * lines.length;

  const ctx = getCanvas2dContext(width, height);
  ctx.font = font;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#000000";
  ctx.textBaseline = "middle";
  lines.forEach((line, i) => {
    ctx.fillText(line, 0, i * lineHeight + lineHeight / 2);
  });

  const { data } = ctx.getImageData(0, 0, width, height);
  const monochrome = convertToMonochrome(data, width, height);
  const packed = bitmapToZplHex(monochrome, width, height);
  return { ...packed, width, height };
}

/**
 * Browser `<canvas>`-backed `RasterizeTextFn` -- see `rasterizeTextSync`
 * above for the measure/draw mechanics. Before measuring, this best-effort
 * `await document.fonts.load(font)`s the exact (already family-mapped) font
 * shorthand `rasterizeTextSync` is about to set as `ctx.font`: a webfont
 * that hasn't finished loading yet would otherwise make `measureText`
 * measure (and `fillText` draw) against a fallback font instead, silently
 * producing a bitmap sized/shaped for the WRONG font. `document.fonts` is
 * guarded with `?.` rather than assumed present: jsdom (this app's own test
 * environment, see `getCanvas2dContext`'s doc comment) has no `FontFaceSet`
 * at all, and `.load()` itself can reject in a real browser too (e.g. a
 * font-shorthand edge case) -- either way this step is NON-FATAL, since a
 * failed/skipped preload just falls back to whatever font state the canvas
 * already had, not a hard rasterization failure.
 */
export const rasterizeText: RasterizeTextFn = async (text, opts) => {
  const font = buildFontShorthand(opts.fontFamily, opts.fontSizePx, opts.bold);
  try {
    await document.fonts?.load(font);
  } catch {
    // Best-effort only -- see this function's doc comment above.
  }

  try {
    return rasterizeTextSync(text, opts);
  } catch (err) {
    // `err` from a `catch` binding is `unknown`, not provably `Error` --
    // narrow it (it always IS one here, since the only thing thrown inside
    // `rasterizeTextSync` is `RasterUnavailableError`) so the rejection
    // value is a real `Error` rather than an unknown value, same as
    // `@typescript-eslint/prefer-promise-reject-errors` requires elsewhere.
    throw err instanceof Error ? err : new Error(String(err));
  }
};

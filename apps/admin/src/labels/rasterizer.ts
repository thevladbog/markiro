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
import { bitmapToZplHex, convertToMonochrome, type RasterizeTextFn } from "@markiro/domain";

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
 * Synchronous core of `rasterizeText` (below): measures and draws `text`
 * via a browser `<canvas>`, then hands the pixel data to the domain
 * package's DOM-free packing primitives. Mirrors Idento's
 * `canvasRasterizer.ts` measure-then-draw sequence:
 *
 * 1. `ctx.font = "<weight> <sizePx>px <family>"` (bold -> 700, else 400).
 * 2. Measure `text`'s rendered width via `measureText` on a throwaway 1x1
 *    context (a canvas must already have SOME context to measure text, and
 *    resizing a canvas after the fact resets its 2D state including
 *    `font`, so measurement happens on its own context before the
 *    real, correctly-sized one is created).
 * 3. Height is fixed at `ceil(sizePx * 1.5)` -- a simple, deterministic
 *    line-box heuristic (not real font-metrics ascent/descent), matching
 *    the plan brief exactly rather than trying to read font-specific
 *    metrics that vary per family/weight.
 * 4. Fill the sized canvas white, draw `text` in black with
 *    `textBaseline = "middle"` at vertical center, then `getImageData` the
 *    whole canvas and convert/pack it through `@markiro/domain`.
 *
 * Kept separate from the exported `rasterizeText` below (rather than making
 * that function itself `async`) purely so `RasterUnavailableError` -- thrown
 * synchronously here, the instant `getCanvas2dContext` fails -- can be
 * turned into a REJECTED promise via an explicit `try`/`catch` instead of
 * relying on an `async` function body to do that implicitly; an `async`
 * wrapper with no `await` inside it is flagged by
 * `@typescript-eslint/require-await` (correctly: it would just be a stylistic
 * `async` with no asynchronous work), while a non-`async` function that
 * merely returned this call directly would let the throw escape
 * SYNCHRONOUSLY instead of rejecting the `Promise<RasterResult>` the
 * `RasterizeTextFn` contract promises callers.
 */
function rasterizeTextSync(
  text: string,
  { fontFamily, fontSizePx, bold }: { fontFamily: string; fontSizePx: number; bold: boolean },
) {
  const font = `${bold ? 700 : 400} ${fontSizePx}px ${fontFamily}`;

  const measureCtx = getCanvas2dContext(1, 1);
  measureCtx.font = font;
  const width = Math.max(1, Math.ceil(measureCtx.measureText(text).width));
  const height = Math.ceil(fontSizePx * 1.5);

  const ctx = getCanvas2dContext(width, height);
  ctx.font = font;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#000000";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, height / 2);

  const { data } = ctx.getImageData(0, 0, width, height);
  const monochrome = convertToMonochrome(data, width, height);
  const packed = bitmapToZplHex(monochrome, width, height);
  return { ...packed, width, height };
}

/** Browser `<canvas>`-backed `RasterizeTextFn` -- see `rasterizeTextSync` above for the mechanics. */
export const rasterizeText: RasterizeTextFn = (text, opts) => {
  try {
    return Promise.resolve(rasterizeTextSync(text, opts));
  } catch (err) {
    // `err` from a `catch` binding is `unknown`, not provably `Error` --
    // narrow it (it always IS one here, since the only thing thrown inside
    // `rasterizeTextSync` is `RasterUnavailableError`) so the rejection
    // value is a real `Error` rather than an unknown value, same as
    // `@typescript-eslint/prefer-promise-reject-errors` requires elsewhere.
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
};

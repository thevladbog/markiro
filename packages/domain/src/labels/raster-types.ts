/**
 * Result of rasterizing a piece of text to a 1-bit monochrome bitmap, ready
 * to pack into a printer's raw graphics command. Produced by an injected
 * `RasterizeTextFn` and consumed by `buildGfaCommand` below.
 *
 * PACKAGE-BOUNDARY NOTE (Plan 04 controller decision, pinned here for both
 * this task and Task 4 to read): Task 4 ("raster primitives") lives in
 * `./raster.ts`. It owns the PIXEL-LEVEL conversion functions that PRODUCE a
 * `RasterResult` — `convertToMonochrome`, `bitmapToZplHex`,
 * `bitmapToTsplBytes` — and imports the two types below from this module
 * rather than redeclaring them. `buildGfaCommand` and `buildBitmapCommand`
 * are defined HERE (Tasks 2/3, the ZPL/TSPL emitters), not in Task 4's
 * raster module, because they are pure printer-language command-string
 * assembly (`^GFA` field syntax / TSPL `BITMAP` syntax), not raster math —
 * these modules' golden tests needed working implementations before Task 4
 * existed, and Task 4's own tests import them back from here, so there is
 * exactly one implementation of each, never two that could silently drift
 * apart. `invertHexToTsplBytes` (below) is exported for exactly one reason:
 * so that Task 4's `bitmapToTsplBytes` can reuse this exact inversion
 * instead of re-deriving it — `raster-types.ts` remains the single source
 * of truth for ZPL<->TSPL bit-polarity; `raster.ts` only packs pixels and
 * delegates the polarity flip back here.
 */
export interface RasterResult {
  hex: string;
  totalBytes: number;
  bytesPerRow: number;
  /**
   * The rasterized bitmap's own pixel size, in dots — carried alongside the
   * hex payload for callers that need it (e.g. a future align/valign
   * offset), NOT derivable from `bytesPerRow * 8` (which is byte-padded).
   * Ignored by `buildGfaCommand` itself; it never appears in the emitted
   * `^GFA` command.
   */
  width: number;
  height: number;
}

/**
 * Options an emitter hands to an injected rasterizer.
 *
 * `maxWidthPx`/`maxLines` are a CONTRACT, not a hint: an implementation MUST
 * NOT return a bitmap wider than `maxWidthPx` when one is given. Before this
 * existed, the rasterizers sized their bitmap from the text's own measured
 * width and the emitters used `maxWidthMm` only to compute an alignment
 * offset — so a long Cyrillic product name produced a bitmap far wider than
 * the label and `^FO`/`BITMAP` printed it straight off the right edge.
 * Implementations satisfy this by wrapping (up to `maxLines` lines) and
 * ellipsizing the remainder — `wrap.ts`'s `wrapTextToWidth` is the shared
 * algorithm; see `apps/admin/src/labels/rasterizer.ts` for the reference
 * implementation.
 */
export interface RasterizeTextOptions {
  fontFamily: string;
  fontSizePx: number;
  bold: boolean;
  /** Hard upper bound on the returned bitmap's width, in printer dots.
   * `undefined` when the element carries no `maxWidthMm` (unbounded single
   * line) — spelled explicitly rather than as a bare optional so an emitter
   * can pass it through unconditionally under `exactOptionalPropertyTypes`. */
  maxWidthPx?: number | undefined;
  /** Maximum number of wrapped lines; defaults to 1 (single line, clipped). */
  maxLines?: number;
}

/**
 * Injectable text-to-bitmap rasterizer. The real implementations (browser
 * `<canvas>` plus bundled fonts) live in `apps/admin` and `apps/station`;
 * `generateZpl`/`generateTspl` are pure and DOM-free per the plan's Global
 * Constraints and only ever see this signature.
 */
export type RasterizeTextFn = (text: string, opts: RasterizeTextOptions) => Promise<RasterResult>;

/**
 * Assembles a ZPL `^GFA` (Graphic Field, ASCII-hex, uncompressed) command
 * from an already-rasterized bitmap: `^GFa,b,c,d,data` where `a` = `A`
 * (ASCII-hex, no compression — folded into the literal `"^GFA,"` prefix
 * here), `b`/`c` = binary byte count / total graphic byte count (equal for
 * the uncompressed-only path this package uses), and `d` = bytes per row.
 *
 * The caller is responsible for the preceding `^FO<x>,<y>` (position) and
 * trailing `^FS` (field separator); this function only emits the `^GFA`
 * command itself so it composes cleanly with either the plain native-text
 * field syntax or (for `km.code` DataMatrix) the `^FH`/FNC1-prefixed one.
 */
export function buildGfaCommand(r: RasterResult): string {
  return `^GFA,${r.totalBytes},${r.totalBytes},${r.bytesPerRow},${r.hex}`;
}

/**
 * Inverts every bit of a ZPL-polarity hex payload (as produced by
 * `bitmapToZplHex`: bit 1 = black, MSB-first, byte-padded rows) and returns
 * the result as a Latin-1 string — one character per byte, via
 * `String.fromCharCode` — ready to embed inline as TSPL `BITMAP`'s raw
 * binary data parameter.
 *
 * POLARITY: ZPL's `^GFA` and TSPL's `BITMAP` (mode 0 / OVERWRITE) do NOT
 * agree on bit polarity. ZPL follows the "obvious" convention (bit 1 =
 * printed/black, matching `bitmapToZplHex`'s own documented semantics).
 * TSPL is the opposite: bit 0 = printed/black, bit 1 = blank/white. This
 * was confirmed against a real, working TSPL image-printing implementation
 * (rowbotik/thermal-printer-server's `image_to_tspl`: it inverts the
 * grayscale source (`255 - p`) and thresholds it BEFORE packing, then sets
 * a bit only when the (already-inverted) sample is `< 128` — net effect,
 * an originally-black source pixel ends up as bit 0 in the byte stream
 * handed to `BITMAP ...,0,<data>`), and is also what the plan's Global
 * Constraints note anticipated. TSC's own official TSPL/TSPL2 Programming
 * Manual's worked `BITMAP` example (the "BITMAP 200,200,2,16,0,..." sample)
 * does not state the polarity in words, so this comment — not the manual
 * text — is the citable source; Plan 05's hardware verification pass
 * should still print a small asymmetric test bitmap on a physical TSC
 * printer to double-check before this ships to production.
 *
 * Inverting EVERY bit (not just the columns inside the logical image width)
 * is intentional and correct: it also flips this package's ZPL white/0 row
 * padding (see `bitmapToZplHex`) into TSPL's white/1 padding convention, so
 * padding columns stay blank under either polarity.
 *
 * Exported (rather than module-private) specifically so `raster.ts`'s
 * `bitmapToTsplBytes` can reuse this exact inversion instead of
 * re-implementing it — see the PACKAGE-BOUNDARY NOTE at the top of this
 * file.
 */
export function invertHexToTsplBytes(hex: string): string {
  let bytes = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    bytes += String.fromCharCode(byte ^ 0xff);
  }
  return bytes;
}

/**
 * Assembles a TSPL `BITMAP` command from an already-rasterized bitmap:
 * `BITMAP x,y,widthBytes,height,0,<data>` where `data` is the RAW BINARY
 * bytes (not ASCII-hex like ZPL's `^GFA`) with TSPL polarity applied (see
 * `invertHexToTsplBytes`). Mode is pinned to `0` (OVERWRITE) — the only
 * mode this package ever needs, since callers always paint onto a blank
 * label region.
 *
 * `x`/`y` are passed in by the caller (already converted to dots) rather
 * than read off `r`, mirroring `buildGfaCommand`'s division of
 * responsibility: this function only knows about the RASTER, not layout.
 *
 * Returns a plain string with the binary bytes embedded as Latin-1
 * characters (code points 0x00-0xFF, one per byte) — see `tspl.ts`'s module
 * doc comment for why a string (rather than a `Buffer`/`Uint8Array`) is
 * this package's chosen representation for a binary-bearing document.
 */
export function buildBitmapCommand(x: number, y: number, r: RasterResult): string {
  return `BITMAP ${x},${y},${r.bytesPerRow},${r.height},0,${invertHexToTsplBytes(r.hex)}`;
}

/**
 * Computes the extra x-offset (in dots) a piece of text must be shifted by to
 * honor its element's `align` within its `maxWidthMm` box.
 *
 * It is named for the raster branch it was written for — without it, a
 * bitmap would always be anchored flush to the element's bare `x`, silently
 * dropping `align` for any text that happens to need rasterization
 * (Cyrillic/CJK/etc.) — but it is now the SINGLE definition of what `align`
 * means, in dots, for every path that has to place the text itself: both
 * emitters' raster branches AND `tspl.ts`'s native branch (see
 * `nativeAlignOffsetDots`, which feeds it a character-count width estimate
 * instead of a measured bitmap width). Only ZPL's native branch computes
 * nothing, because it hands the job to the printer via `^FB`'s justification
 * parameter — and `^FB` justifies inside the same `maxWidthMm` box, so the
 * two agree.
 *
 * `align: "left"` (or unset) needs no offset: the native path's default
 * already anchors flush-left at `x`, exactly where the raster bitmap is
 * drawn regardless. `"center"` splits the leftover space
 * (`maxWidthDots - rasterWidthDots`) evenly on both sides, rounding to the
 * nearest whole dot (a fractional dot can't be rendered) via `Math.round`.
 * `"right"` shifts the bitmap flush to the box's trailing edge, i.e. by the
 * FULL leftover space.
 *
 * Both branches are clamped to a minimum of 0: if the rasterized bitmap
 * turns out WIDER than `maxWidthDots` (a long/dense piece of text at a
 * fixed font size — the model does not shrink text to fit), there is no
 * leftover space to distribute and the bitmap stays anchored at `x`, the
 * same graceful degradation the native `^FB`/alignment paths exhibit rather
 * than emitting a negative, off-label offset.
 *
 * With no `maxWidthMm` on the element (`maxWidthDots === undefined`) there
 * is no box to align within, so the offset is always 0 regardless of
 * `align` — the same documented no-op ZPL's native branch has (no
 * `maxWidthMm`, no `^FB`, hence no justification) and the admin preview has
 * (`renderer.ts` draws flush-left when `maxWidthMm` is absent).
 *
 * A single pure function (not duplicated per emitter) so `zpl.ts`,
 * `tspl.ts`, and (via a re-export chain, ultimately from `@markiro/domain`)
 * `apps/admin`'s `PreviewPane.tsx` compositor all apply the EXACT same
 * arithmetic — the preview and the two print-document emitters can never
 * silently drift apart on this offset.
 */
export function rasterAlignOffsetDots(
  align: "left" | "center" | "right" | undefined,
  maxWidthDots: number | undefined,
  rasterWidthDots: number,
): number {
  if (maxWidthDots === undefined) return 0;
  const leftover = maxWidthDots - rasterWidthDots;
  if (align === "center") return Math.max(0, Math.round(leftover / 2));
  if (align === "right") return Math.max(0, leftover);
  return 0;
}

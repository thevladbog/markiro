/**
 * Result of rasterizing a piece of text to a 1-bit monochrome bitmap, ready
 * to pack into a printer's raw graphics command. Produced by an injected
 * `RasterizeTextFn` and consumed by `buildGfaCommand` below.
 *
 * PACKAGE-BOUNDARY NOTE (Plan 04 controller decision, pinned here for both
 * this task and Task 4 to read): Task 4 ("raster primitives") is not built
 * yet. It will own the PIXEL-LEVEL conversion functions that PRODUCE a
 * `RasterResult` — `convertToMonochrome`, `bitmapToZplHex`,
 * `bitmapToTsplBytes` — and will import the two types below from this
 * module rather than redeclaring them. `buildGfaCommand` is defined HERE
 * (Task 2, the ZPL emitter), not in Task 4's raster module, because it is
 * pure ZPL command-string assembly (`^GFA` field syntax), not raster math —
 * this module's golden tests need a working `buildGfaCommand` before Task 4
 * exists, and Task 4's own tests can import it back from here once it
 * lands, so there is exactly one implementation, never two that could
 * silently drift apart.
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
 * Injectable text-to-bitmap rasterizer. The real implementation (browser
 * `<canvas>` plus admin-bundled fonts) lives in `apps/admin` (Task 5);
 * `generateZpl`/`generateTspl` are pure and DOM-free per the plan's Global
 * Constraints and only ever see this signature.
 */
export type RasterizeTextFn = (
  text: string,
  opts: { fontFamily: string; fontSizePx: number; bold: boolean },
) => Promise<RasterResult>;

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

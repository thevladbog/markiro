/**
 * True when `text` contains any character outside printable ASCII (0x20-
 * 0x7E) — Cyrillic, CJK, emoji, accented Latin-1 Supplement characters
 * (e.g. "é", 0xE9), etc. — so the text must be rasterized to an image
 * instead of emitted through either printer language's built-in scalable
 * font (ZPL's `^A0`, TSPL's font `"0"`). Iterates by code POINT (not
 * UTF-16 code unit) so astral characters (surrogate pairs) are never
 * mistaken for two in-range code units.
 *
 * ASCII-ONLY, deliberately: native `^FD`/`TEXT` emission of Latin-1
 * Supplement characters (0xA0-0xFF) depends on the printer's active code
 * page, which this package has no way to verify or control, and would
 * silently diverge from what the admin preview rasterizes (the preview
 * always rasterizes anything outside ASCII — see `apps/admin`'s
 * `raster-preview.ts`). Routing those characters to the raster path too
 * keeps native output free of any code-page assumption and keeps
 * preview/print output pixel-identical for exactly the same set of inputs.
 *
 * Shared by both `zpl.ts` and `tspl.ts` (each re-exports it) so the
 * ASCII-vs-rasterize decision has exactly one implementation regardless of
 * target printer language.
 */
export function needsImageRendering(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isPrintableAscii = code >= 0x20 && code <= 0x7e;
    if (!isPrintableAscii) return true;
  }
  return false;
}

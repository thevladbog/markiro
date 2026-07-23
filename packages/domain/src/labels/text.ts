/**
 * True when `text` contains any character outside the printable Latin-1
 * range (ASCII 0x20-0x7E, Latin-1 Supplement 0xA0-0xFF) — Cyrillic, CJK,
 * emoji, etc. — that neither printer language's built-in scalable font
 * (ZPL's `^A0`, TSPL's font `"0"`) can render, so the text must be
 * rasterized to an image instead. Iterates by code POINT (not UTF-16 code
 * unit) so astral characters (surrogate pairs) are never mistaken for two
 * in-range Latin-1 code units.
 *
 * Shared by both `zpl.ts` and `tspl.ts` (each re-exports it) so the
 * Latin-1-vs-rasterize decision has exactly one implementation regardless
 * of target printer language.
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

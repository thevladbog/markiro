/**
 * The part of `opentype.js` 2.0.0 this app uses, declared by hand: the
 * package ships no declarations, and `@types/opentype.js` describes the old
 * 1.x API (a port of `apps/admin/src/labels/opentype.d.ts`). `parse` reads
 * TTF, OTF and WOFF bytes; it cannot read WOFF2 (no Brotli decoder in 2.0.0),
 * which is why the coverage check reads the `.woff` files. `Font`, `Glyph`
 * and `toArrayBuffer` let a test build a real font in memory.
 */
declare module "opentype.js" {
  export interface GlyphOptions {
    name?: string | null;
    /** 0 is reserved for `.notdef`; omit it for every other glyph. */
    unicode?: number;
    unicodes?: number[];
    advanceWidth?: number;
    index?: number;
  }

  export class Glyph {
    constructor(options: GlyphOptions);
    readonly unicode: number | undefined;
    readonly unicodes: number[];
  }

  export interface FontOptions {
    familyName: string;
    styleName: string;
    unitsPerEm: number;
    ascender: number;
    descender: number;
    glyphs: Glyph[];
  }

  export class Font {
    constructor(options: FontOptions);
    /**
     * The glyph of the character's first code point: `0` (a parsed font's
     * `.notdef`) or `null` (an in-memory font without a cmap) when there is
     * none, so anything `<= 0` means «not covered».
     */
    charToGlyphIndex(char: string): number | null;
    /** An in-memory font as real sfnt bytes. */
    toArrayBuffer(): ArrayBuffer;
  }

  /** Parses TTF, OTF or WOFF bytes; WOFF2 throws. */
  export function parse(buffer: ArrayBuffer): Font;
}

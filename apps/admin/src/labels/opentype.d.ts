/**
 * Minimal ambient module declaration for `opentype.js@2.0.0`.
 *
 * The package ships NO TypeScript declarations at all (verified: no `.d.ts`
 * anywhere under its published tree, and no `types`/`typings` field in its
 * `package.json`), and the community `@types/opentype.js` package on npm is
 * stuck at the old 1.x API surface (last published for 1.3.10), which does
 * not match this repo's pinned 2.0.0 -- installing it would both add an
 * extra dependency (the plan's Global Constraints allow exactly one new dep,
 * `opentype.js@2.0.0` itself) AND type-check against the wrong major
 * version. A small hand-written shim covering only the handful of members
 * this package actually calls is the standard fix for an untyped runtime
 * dependency and keeps the dependency count at one.
 *
 * Verified against the installed `dist/opentype.mjs` build (see
 * `fontCoverage.ts`'s module doc comment for the parse/serialize round-trip
 * this was checked with): `parse` is the named export for what the
 * library's own source calls `parseBuffer` internally; `Font`/`Glyph`
 * constructors and the handful of members below are exactly what
 * `fontCoverage.ts` and its test use to build a synthetic font, serialize it
 * back to real sfnt bytes, and parse those bytes again.
 */
declare module "opentype.js" {
  export interface GlyphOptions {
    name?: string | null;
    /** Reserved 0 for `.notdef`; omit for every other glyph. */
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
     * Resolves `char`'s first code point to a glyph index via the font's
     * cmap table (real parsed fonts) or its in-memory glyph list (fonts
     * constructed directly via `new Font(...)`, which use opentype.js's
     * `DefaultEncoding`). `0` (real parsed fonts, `.notdef`) or `null`
     * (in-memory fonts with no cmap) both mean "no glyph for this
     * character" -- callers must treat any value `<= 0` as "not covered",
     * not just strict equality with one sentinel.
     */
    charToGlyphIndex(char: string): number | null;
    /** Serializes an in-memory `Font` (built via `new Font(...)`) to real sfnt bytes. */
    toArrayBuffer(): ArrayBuffer;
  }

  /** Parses sfnt (ttf/otf) font bytes. Does NOT support WOFF2 (Brotli) -- see `fontCoverage.ts`. */
  export function parse(buffer: ArrayBuffer): Font;
}

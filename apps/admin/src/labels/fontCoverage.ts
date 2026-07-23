/**
 * Cyrillic glyph-coverage check for the editor's bundled fonts, via
 * `opentype.js@2.0.0` (see `./opentype.d.ts` for why this repo hand-writes
 * its own ambient types instead of installing `@types/opentype.js`).
 * Idento parity: `panel/src/features/badge/zpl/fontCoverage.ts`'s sample
 * set, `"АЯЁЖЩыёя"` -- eight Cyrillic characters chosen to span the
 * alphabet (including the frequently-dropped Ё and lowercase forms) rather
 * than an exhaustive scan of the whole Unicode Cyrillic block.
 *
 * WOFF2 REALITY CHECK (verified against the installed
 * `node_modules/opentype.js/dist/opentype.mjs`, not assumed): calling
 * `opentype.parse()` on a WOFF2 (Brotli-compressed) font throws
 * `"WOFF2 require an external decompressor library, see examples at: ..."`
 * -- this build has NO Brotli decoder wired in. `@fontsource` ships every
 * subset as both `.woff2` AND plain `.woff` (DEFLATE-compressed, which
 * opentype.js DOES decode natively), so this module deliberately imports
 * the `.woff` variant everywhere, never `.woff2`. If a future opentype.js
 * upgrade adds WOFF2 support this constraint can be revisited, but as
 * pinned at 2.0.0 it is a hard requirement, not a style preference.
 *
 * SUBSET-UNION POLICY (MVP design decision, see the plan's Task 5 brief):
 * `@fontsource` ships each font family as several disjoint per-script
 * subset files (`latin`, `latin-ext`, `cyrillic`, `cyrillic-ext`, `greek`,
 * `vietnamese`, ...) -- @font-face's `unicode-range` picks whichever subset
 * a given piece of text actually needs at render time, so no single
 * fetched file is "the font". For the two bundled families (IBM Plex Sans
 * / IBM Plex Mono), `checkFamilyCoverage` fetches the `latin` AND
 * `cyrillic` subsets (400/normal weight -- coverage doesn't vary by weight
 * within a family) and passes if EITHER one alone covers the full sample.
 * In practice this always resolves via the `cyrillic` file (the `latin`
 * subset can never contain Cyrillic code points by construction) -- the
 * real reason this check exists at all, and runs on every family rather
 * than being hard-coded to "these two families always pass", is to be
 * ready for a future custom-font upload feature (out of MVP scope; see the
 * plan's self-review notes), where a SINGLE uploaded file must cover the
 * sample on its own and this exact `checkCyrillicCoverage` function is what
 * would gate it.
 */
import { parse } from "opentype.js";
import type { Font } from "opentype.js";

import ibmPlexMonoCyrillicUrl from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-cyrillic-400-normal.woff?url";
import ibmPlexMonoLatinUrl from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff?url";
import ibmPlexSansCyrillicUrl from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-400-normal.woff?url";
import ibmPlexSansLatinUrl from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff?url";

/** Idento's sample set: spans the alphabet, including Ё and lowercase forms. */
export const CYRILLIC_SAMPLE = "АЯЁЖЩыёя";

/** The two families the MVP editor offers (both bundled via `@fontsource`; see design brief 03 §4). */
export type LabelFontFamily = "IBM Plex Sans" | "IBM Plex Mono";

/**
 * The `latin`/`cyrillic` subset URLs to check, per family -- Vite-resolved
 * asset URLs (`?url`), fetched at coverage-check time rather than bundled
 * as inline data so the (unused, until a text actually needs Cyrillic
 * rendering) font bytes don't bloat the app's JS bundle.
 */
const FAMILY_SUBSET_URLS: Record<LabelFontFamily, readonly [string, string]> = {
  "IBM Plex Sans": [ibmPlexSansLatinUrl, ibmPlexSansCyrillicUrl],
  "IBM Plex Mono": [ibmPlexMonoLatinUrl, ibmPlexMonoCyrillicUrl],
};

/**
 * Pure cmap-walk decision logic: `true` iff `font` resolves every character
 * of `sample` to a real glyph (index `> 0`). Exported on its own (not just
 * folded into `checkCyrillicCoverage`) so it can be unit-tested directly
 * against a synthetic `opentype.Font` built via `new Font(...)`/
 * `new Glyph(...)` -- no font binary parsing required for that test.
 *
 * `charToGlyphIndex` returns `0` for a real parsed font's `.notdef` (its
 * `CmapEncoding`) or `null` for an in-memory font with no cmap yet (its
 * `DefaultEncoding`) when a character has no glyph; both are treated as
 * "not covered" via `<= 0` (which is `true` for `null` too, since `null`
 * coerces to `0` in a numeric comparison) rather than checking only one of
 * the two sentinels.
 */
export function sampleCoveredByFont(font: Font, sample: string = CYRILLIC_SAMPLE): boolean {
  for (const ch of sample) {
    const glyphIndex = font.charToGlyphIndex(ch);
    if (glyphIndex === null || glyphIndex <= 0) {
      return false;
    }
  }
  return true;
}

/**
 * Parses `fontBytes` (a `.woff`/`.ttf`/`.otf` -- NOT `.woff2`, see this
 * module's doc comment) and checks it against `sampleCoveredByFont`. This
 * is the function a single future custom-font upload would be validated
 * against.
 */
export function checkCyrillicCoverage(
  fontBytes: ArrayBuffer,
  sample: string = CYRILLIC_SAMPLE,
): boolean {
  const font = parse(fontBytes);
  return sampleCoveredByFont(font, sample);
}

/**
 * Fetches BOTH the `latin` and `cyrillic` subset files bundled for `family`
 * and reports whether EITHER one alone covers `CYRILLIC_SAMPLE` -- see this
 * module's "SUBSET-UNION POLICY" doc comment above for the full rationale.
 *
 * CARRY-OVER FIX (Plan 04 Task 10 brief): the original Task 5 implementation
 * fetched each subset URL and immediately called `.arrayBuffer()` without
 * ever checking `response.ok` -- a 404/500 for a font asset (a genuinely
 * possible failure: a bad build, a CDN hiccup, a future custom-font-upload
 * URL that 404s) would silently hand an HTML error page's bytes to
 * `checkCyrillicCoverage`/`opentype.parse`, which would then throw a
 * confusing parse error instead of a clear "the font fetch itself failed"
 * one. `response.ok` is checked HERE (not left to the caller) so every
 * caller -- today just `PreviewPane.tsx` -- gets one unambiguous failure
 * mode (a rejected promise) for every kind of fetch-time problem; that
 * caller is still responsible for turning the rejection into the honest
 * "could not verify" UI warning (never an unhandled rejection) per this
 * task's brief, since fetch/parse errors are a fact of life this function
 * cannot fully prevent, only surface clearly.
 */
export async function checkFamilyCoverage(family: LabelFontFamily): Promise<boolean> {
  const urls = FAMILY_SUBSET_URLS[family];
  const buffers = await Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`failed to fetch font subset ${url}: HTTP ${response.status}`);
      }
      return response.arrayBuffer();
    }),
  );
  return buffers.some((buffer) => checkCyrillicCoverage(buffer));
}

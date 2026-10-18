import { parse, type Font } from "opentype.js";

import plexMonoCyrillic from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-cyrillic-400-normal.woff?url";
import plexMonoLatin from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff?url";
import plexSansCyrillic from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-400-normal.woff?url";
import plexSansLatin from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff?url";

/** Eight letters across the alphabet, Ё and lowercase forms included (as the cloud checks). */
export const CYRILLIC_SAMPLE = "АЯЁЖЩыёя";

/** The faces a label's text is drawn in: the app's own IBM Plex. */
export type LabelFontFamily = "IBM Plex Sans" | "IBM Plex Mono";

/**
 * The files the check reads, per family: the Latin and the Cyrillic subset,
 * weight 400 (coverage does not change with the weight). They are the app's
 * own assets, the same files `@markiro/ui`'s `@font-face` rules load, so the
 * check needs no network; the `.woff` variant, since opentype.js 2.0.0 cannot
 * read WOFF2.
 */
export const FONT_SUBSET_URLS: Record<LabelFontFamily, readonly [latin: string, cyrillic: string]> =
  {
    "IBM Plex Sans": [plexSansLatin, plexSansCyrillic],
    "IBM Plex Mono": [plexMonoLatin, plexMonoCyrillic],
  };

/** Whether the font has a glyph for every character of `sample`. */
export function sampleCoveredByFont(font: Font, sample: string = CYRILLIC_SAMPLE): boolean {
  for (const char of sample) {
    const glyph = font.charToGlyphIndex(char);
    if (glyph === null || glyph <= 0) return false;
  }
  return true;
}

/** Parses font bytes (TTF, OTF, WOFF; not WOFF2) and checks them against `sample`. */
export function checkCyrillicCoverage(
  bytes: ArrayBuffer,
  sample: string = CYRILLIC_SAMPLE,
): boolean {
  return sampleCoveredByFont(parse(bytes), sample);
}

/**
 * Whether a family draws Cyrillic, after the cloud's `checkFamilyCoverage`:
 * both subset files are read, and either one alone must cover the sample (in
 * practice the Cyrillic one). A file that does not load rejects, and the
 * caller says the check failed, rather than parsing an error page.
 */
export async function checkFamilyCoverage(family: LabelFontFamily): Promise<boolean> {
  const buffers = await Promise.all(
    FONT_SUBSET_URLS[family].map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`failed to fetch font subset ${url}: HTTP ${response.status}`);
      }
      return response.arrayBuffer();
    }),
  );
  return buffers.some((buffer) => checkCyrillicCoverage(buffer));
}

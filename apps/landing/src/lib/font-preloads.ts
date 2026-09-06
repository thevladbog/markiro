import monoCyrillic600 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-cyrillic-600-normal.woff2?url";
import monoLatin600 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2?url";
import sansCyrillic400 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-400-normal.woff2?url";
import sansCyrillic500 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-500-normal.woff2?url";
import sansLatin400 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2?url";
import sansLatin500 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2?url";

import type { Locale } from "../content/pages";

/**
 * Fonts that paint above the fold on every template: the hero heading (Sans
 * 500), body copy (Sans 400) and the kicker (Mono 600). Preloading them lets
 * the browser have the web font before first paint, which removes the layout
 * shift that `font-display: swap` otherwise causes when the font arrives late.
 * Russian pages need the Cyrillic and Latin subsets; English pages only Latin.
 */
export function fontPreloads(locale: Locale): readonly string[] {
  return locale === "ru"
    ? [sansCyrillic500, sansLatin500, sansCyrillic400, sansLatin400, monoCyrillic600, monoLatin600]
    : [sansLatin500, sansLatin400, monoLatin600];
}

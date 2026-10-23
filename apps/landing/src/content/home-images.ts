import type { ImageMetadata } from "astro";

import type { Locale } from "./pages";

export type HomeCoverCode = "mkr-ins-01" | "mkr-ins-02" | "mkr-ins-09";

const COVERS = import.meta.glob<{ default: ImageMetadata }>("../assets/home/docs/*.png", {
  eager: true,
});

/** The first page of the newest published release (the file name carries the release). */
export function homeCover(locale: Locale, code: HomeCoverCode): ImageMetadata {
  const entry = Object.entries(COVERS).find(
    ([file]) => file.includes(`/${code}_`) && file.endsWith(`_${locale}.png`),
  );
  if (entry === undefined) throw new Error(`missing home cover ${code} (${locale})`);
  return entry[1].default;
}

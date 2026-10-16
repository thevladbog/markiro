/**
 * The monogram that stands in for a product's photo (forked from the cloud
 * station's `productMonogram`, apps/station/src/ui/work/ShiftBand.tsx). The
 * per-product hue (`hueFromGtin`) and the photo's dominant colour are gone:
 * nothing paints from them since the design kit (station audit, 2026-10).
 */

/** The first letter or digit of the product's name, upper-cased; `?` without one. */
export function productMonogram(name: string): string {
  const first = [...name.normalize("NFC")].find((character) => /[\p{L}\p{N}]/u.test(character));
  return first ? ([...first.toUpperCase()][0] ?? "?") : "?";
}

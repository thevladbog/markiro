/**
 * The product's accent on the shift card, forked from the cloud station
 * (apps/station/src/lib/product-accent.ts, `hueFromGtin`, and
 * apps/station/src/ui/work/ShiftBand.tsx, `productMonogram`): the colour is
 * derived from the product, never assigned by hand. The standalone keeps no
 * product photos, so the hue always comes from the GTIN.
 */

/**
 * Deterministic hue for a product: FNV-1a over the GTIN, folded to degrees.
 * The same product looks the same on every station, cloud or standalone.
 */
export function hueFromGtin(gtin: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < gtin.length; index += 1) {
    hash ^= gtin.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

/** The first letter or digit of the product's name, upper-cased; `?` without one. */
export function productMonogram(name: string): string {
  const first = [...name.normalize("NFC")].find((character) => /[\p{L}\p{N}]/u.test(character));
  return first ? ([...first.toUpperCase()][0] ?? "?") : "?";
}

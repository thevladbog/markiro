import { createHash } from "node:crypto";
import { isValidGtin, normalizeToGtin14 } from "@markiro/domain";
import type { NationalCatalogProductImage } from "./national-catalog.types";
/** Callers normalize valid barcodes with domain rules and exclude malformed ones. */
export function chooseDefaultPhoto(
  gtin14: string,
  photos: Array<{ candidateId: string; barcode: string | null; primary: boolean }>,
): string | null {
  const matching = photos.filter((photo) => photo.barcode === gtin14);
  const candidates =
    matching.length > 0 ? matching : photos.filter((photo) => photo.barcode === null);
  const primary = candidates.filter((photo) => photo.primary);
  if (primary.length === 1) return primary[0]?.candidateId ?? null;
  return candidates.length === 1 ? (candidates[0]?.candidateId ?? null) : null;
}

export function photoSelector(image: NationalCatalogProductImage) {
  return {
    sourceId: image.sourceId,
    barcode:
      image.barcode === null
        ? null
        : isValidGtin(image.barcode)
          ? normalizeToGtin14(image.barcode)
          : image.barcode,
    primary: image.primary,
    urlHash: createHash("sha256").update(image.url).digest("hex"),
  };
}
/** Snapshot-local sourceId is never a cross-snapshot identity. URL hash selects, bytes compare. */
export function selectObservedPhoto(
  selector: ReturnType<typeof photoSelector>,
  images: NationalCatalogProductImage[],
): NationalCatalogProductImage | null {
  const candidates = images.filter(
    (image) =>
      (image.barcode === null || isValidGtin(image.barcode)) &&
      photoSelector(image).barcode === selector.barcode,
  );
  const exact = candidates.filter((image) => photoSelector(image).urlHash === selector.urlHash);
  if (exact.length === 1) return exact[0] ?? null;
  if (exact.length > 1) {
    const byRole = exact.filter((image) => image.primary === selector.primary);
    return byRole.length === 1 ? (byRole[0] ?? null) : null;
  }
  const byRole = candidates.filter((image) => image.primary === selector.primary);
  return byRole.length === 1 ? (byRole[0] ?? null) : null;
}

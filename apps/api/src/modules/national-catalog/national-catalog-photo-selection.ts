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

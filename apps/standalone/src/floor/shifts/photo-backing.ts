import { useEffect, useState } from "react";

import type { PhotoMediaType } from "../../host/protocol.js";
import type { StoredPhoto } from "../../local/product-photos.js";

/**
 * What stands behind a product's photo in its square: the kit's brand gradient (the work band's)
 * for a photo that has transparency or whose kind is not known yet, nothing visible for a photo
 * with its own background (a frame round it would read as a box nobody meant). Owner feedback
 * 2026-10-16: a transparent PNG showed on a flat grey face instead of the brand gradient.
 */
export type PhotoBacking = "gradient" | "none";

/** What the picture's own pixels say: transparency at its edge, none, or unknown. */
export type PhotoAlpha = "transparent" | "opaque" | null;

/**
 * The backing for a photo of `mediaType` read as `alpha`. No photo (the monogram stands) and an
 * unknown kind take the gradient; a JPEG cannot carry transparency, so it is opaque whatever the
 * pixels; a PNG or WebP is as its pixels say.
 */
export function photoBacking(mediaType: PhotoMediaType | null, alpha: PhotoAlpha): PhotoBacking {
  if (mediaType === null) return "gradient";
  if (mediaType === "image/jpeg") return "none";
  return alpha === "opaque" ? "none" : "gradient";
}

/** The side of the ring sampled, in px: the photo is collapsed to this square before sampling. */
const SAMPLE_SIZE = 16;
/**
 * How much of the sampled border ring must be fully opaque for the photo to count as carrying its
 * own background (the cloud station's threshold: a cut-out's ring is transparent nearly all round,
 * a studio shot's opaque all round, so antialiasing cannot flip the answer).
 */
export const OPAQUE_BORDER_SHARE = 0.75;

/** The alpha channel of the sampled pixels' border ring decides: see `OPAQUE_BORDER_SHARE`. */
export function alphaOfSample(data: ArrayLike<number>, side: number = SAMPLE_SIZE): PhotoAlpha {
  let ring = 0;
  let opaque = 0;
  for (let pixel = 0; pixel < side * side; pixel += 1) {
    const column = pixel % side;
    const row = (pixel - column) / side;
    if (column !== 0 && row !== 0 && column !== side - 1 && row !== side - 1) continue;
    ring += 1;
    if ((data[pixel * 4 + 3] ?? 0) > 250) opaque += 1;
  }
  if (ring === 0) return null;
  return opaque / ring >= OPAQUE_BORDER_SHARE ? "opaque" : "transparent";
}

const alphaByChecksum = new Map<string, PhotoAlpha>();

/** Reads the picture's edge; `null` where there is no canvas (a test's DOM) or it will not decode. */
function readAlpha(src: string): Promise<PhotoAlpha> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") return resolve(null);
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (context === null) return resolve(null);
        context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        resolve(alphaOfSample(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data));
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * The backing of a stored photo (or of the monogram without one). The edge of a PNG or WebP is
 * read once per checksum, ever; until it is read, and where it cannot be, the gradient stands.
 */
export function usePhotoBacking(photo: StoredPhoto | null): PhotoBacking {
  const checksum = photo?.checksum ?? null;
  const mediaType = photo?.mediaType ?? null;
  const needsRead = photo !== null && mediaType !== "image/jpeg";
  const [alpha, setAlpha] = useState<PhotoAlpha>(
    checksum === null ? null : (alphaByChecksum.get(checksum) ?? null),
  );
  useEffect(() => {
    if (!needsRead || photo === null) {
      setAlpha(null);
      return undefined;
    }
    const known = alphaByChecksum.get(photo.checksum);
    if (known !== undefined) {
      setAlpha(known);
      return undefined;
    }
    setAlpha(null);
    let cancelled = false;
    void readAlpha(photo.src).then((read) => {
      if (read !== null) alphaByChecksum.set(photo.checksum, read);
      if (!cancelled) setAlpha(read);
    });
    return () => {
      cancelled = true;
    };
  }, [needsRead, photo]);
  return photoBacking(mediaType, alpha);
}

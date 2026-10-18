import type { PhotoMediaType } from "../../host/protocol.js";

/** The longest side of a product photo, the host's `MAX_PHOTO_SIDE` (plan ТОВ). */
export const PHOTO_MAX_SIDE = 640;

/** The most bytes of a product photo's JPEG, the host's `MAX_PHOTO_BYTES`. */
export const PHOTO_MAX_BYTES = 300_000;

/** The picture formats a photo may come from (the picked file's MIME type). */
export const PHOTO_FILE_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

/**
 * The largest picture file the office reads as a photo; a larger one is
 * refused unread. A phone's photo is a few megabytes; the cap bounds the
 * FILE, the declared pixels are `PHOTO_MAX_SOURCE_PIXELS`'s.
 */
export const PHOTO_MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The most pixels a picture may declare, read once it has loaded and before
 * it is decoded or drawn (the logo's bound, `MAX_LOGO_SOURCE_PIXELS`): a
 * small file declaring a huge picture does not take the office window down.
 */
export const PHOTO_MAX_SOURCE_PIXELS = 8192 * 4096;

/** The JPEG qualities tried in turn until the photo fits `PHOTO_MAX_BYTES`. */
const QUALITIES = [0.85, 0.7, 0.5] as const;

/** The WebP qualities tried for a picture with transparency. */
const WEBP_QUALITIES = [0.9, 0.75, 0.5] as const;

/**
 * How much smaller each further attempt draws a picture that does not fit
 * `PHOTO_MAX_BYTES` at the lowest quality, and the shortest side at which the
 * attempts stop.
 */
const SHRINK_STEP = 0.75;
const MIN_SIDE = 96;

/** A photo as the office holds it: the host's `ProductPhotoPut` and the type of its bytes. */
export interface EncodedPhoto {
  width: number;
  height: number;
  dataBase64: string;
  mediaType: PhotoMediaType;
}

/** Turns a picked file into the picture the host keeps. */
export type PhotoEncoder = (file: Blob) => Promise<EncodedPhoto>;

/** A picture that stays larger than `PHOTO_MAX_BYTES` at the lowest quality and size. */
export class PhotoTooLargeError extends Error {
  constructor() {
    super("the photo is too large even compressed");
    this.name = "PhotoTooLargeError";
  }
}

/** A file that is no picture the webview reads (a wrong type, a damaged file, too many pixels). */
export class PhotoUnreadableError extends Error {
  constructor() {
    super("the picture cannot be read");
    this.name = "PhotoUnreadableError";
  }
}

/** The size within `PHOTO_MAX_SIDE` with the aspect kept; a smaller picture stays as it is. */
export function fitPhotoSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PHOTO_MAX_SIDE / width, PHOTO_MAX_SIDE / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

/** Loads `src`, refusing a picture that declares more than `PHOTO_MAX_SOURCE_PIXELS`. */
async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => {
        resolve();
      };
      image.onerror = () => {
        reject(new Error("the picture did not load"));
      };
      image.src = src;
    });
  } catch {
    throw new PhotoUnreadableError();
  }
  const pixels = image.naturalWidth * image.naturalHeight;
  if (pixels < 1 || pixels > PHOTO_MAX_SOURCE_PIXELS) throw new PhotoUnreadableError();
  try {
    await image.decode();
  } catch {
    throw new PhotoUnreadableError();
  }
  return image;
}

function toBlob(
  canvas: HTMLCanvasElement,
  type: PhotoMediaType,
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

/** Whether any pixel of the canvas is not fully opaque. */
function hasTransparency(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  const { data } = context.getImageData(0, 0, width, height);
  for (let at = 3; at < data.length; at += 4) {
    if ((data[at] ?? 255) < 255) return true;
  }
  return false;
}

/**
 * The smallest of `candidates` that fits `PHOTO_MAX_BYTES`, or `null`. A blob
 * of another type than asked for (a webview without a WebP encoder answers
 * PNG) counts as what it is.
 */
export async function smallestWithinCap(
  candidates: readonly (() => Promise<Blob | null>)[],
): Promise<{ blob: Blob; mediaType: PhotoMediaType } | null> {
  let best: { blob: Blob; mediaType: PhotoMediaType } | null = null;
  for (const make of candidates) {
    const blob = await make();
    if (blob === null) continue;
    if (blob.type !== "image/jpeg" && blob.type !== "image/png" && blob.type !== "image/webp") {
      continue;
    }
    if (blob.size > PHOTO_MAX_BYTES) continue;
    if (best === null || blob.size < best.blob.size) best = { blob, mediaType: blob.type };
  }
  return best;
}

/**
 * A picture as the photo the host keeps. The file is untrusted: its type and
 * size are checked before the webview reads a byte, and its declared pixels
 * before it is decoded. The picture is drawn with the longer side at most 640
 * and read back: with transparency (a PNG or WebP cut out of its background)
 * it stays a PNG, or a WebP with alpha when that is smaller, so the product
 * card's colour shows through; without any it is a JPEG on white, as before.
 * Whatever does not fit 300 000 bytes at the lowest quality is drawn smaller,
 * by a quarter each time. Only the canvas's bytes go to the host, so nothing
 * of the original file (its metadata included) leaves the office. The canvas
 * work is not exercised in jsdom beyond a stub (owner check of plan ТОВ).
 */
export const encodePhoto: PhotoEncoder = async (file) => {
  if (!PHOTO_FILE_TYPES.includes(file.type) || file.size > PHOTO_MAX_FILE_BYTES) {
    throw new PhotoUnreadableError();
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    let size = fitPhotoSize(image.naturalWidth, image.naturalHeight);
    let transparent: boolean | null = null;
    for (;;) {
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) throw new PhotoUnreadableError();
      context.drawImage(image, 0, 0, size.width, size.height);
      // Only a PNG or WebP can carry alpha; the answer holds for every smaller size.
      transparent ??=
        file.type !== "image/jpeg" && hasTransparency(context, size.width, size.height);
      let chosen: { blob: Blob; mediaType: PhotoMediaType } | null;
      if (transparent) {
        chosen = await smallestWithinCap([
          () => toBlob(canvas, "image/png"),
          ...WEBP_QUALITIES.map((quality) => () => toBlob(canvas, "image/webp", quality)),
        ]);
      } else {
        // An opaque picture is a JPEG on white (a stray translucent edge prints on paper).
        context.globalCompositeOperation = "destination-over";
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, size.width, size.height);
        chosen = null;
        for (const quality of QUALITIES) {
          chosen = await smallestWithinCap([() => toBlob(canvas, "image/jpeg", quality)]);
          if (chosen !== null) break;
        }
      }
      if (chosen !== null) {
        const bytes = new Uint8Array(await chosen.blob.arrayBuffer());
        return { ...size, dataBase64: toBase64(bytes), mediaType: chosen.mediaType };
      }
      const next = {
        width: Math.round(size.width * SHRINK_STEP),
        height: Math.round(size.height * SHRINK_STEP),
      };
      if (Math.min(next.width, next.height) < Math.min(MIN_SIDE, size.width, size.height)) {
        throw new PhotoTooLargeError();
      }
      size = next;
    }
  } finally {
    URL.revokeObjectURL(url);
  }
};

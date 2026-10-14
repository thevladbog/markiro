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

/** A photo as the host keeps it (`ProductPhotoPut`). */
export interface EncodedPhoto {
  width: number;
  height: number;
  dataBase64: string;
}

/** Turns a picked file into the JPEG the host keeps. */
export type PhotoEncoder = (file: Blob) => Promise<EncodedPhoto>;

/** A picture that stays larger than `PHOTO_MAX_BYTES` at the lowest quality. */
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

function jpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
}

/**
 * A picture as the JPEG the host keeps: drawn on white (a transparent PNG
 * prints on paper) with the longer side at most 640, at quality 0.85, then
 * 0.7 and 0.5 until it fits 300 000 bytes. The file is untrusted: its type
 * and size are checked before the webview reads a byte, and its declared
 * pixels before it is decoded. Only the canvas's JPEG goes to the host, so
 * nothing of the original file (its metadata included) leaves the office.
 * The canvas work is not exercised in jsdom (owner check 5 of plan ТОВ).
 */
export const encodePhoto: PhotoEncoder = async (file) => {
  if (!PHOTO_FILE_TYPES.includes(file.type) || file.size > PHOTO_MAX_FILE_BYTES) {
    throw new PhotoUnreadableError();
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const size = fitPhotoSize(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new PhotoUnreadableError();
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    for (const quality of QUALITIES) {
      const blob = await jpeg(canvas, quality);
      if (blob === null) throw new PhotoUnreadableError();
      if (blob.size <= PHOTO_MAX_BYTES) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return { ...size, dataBase64: toBase64(bytes) };
      }
    }
    throw new PhotoTooLargeError();
  } finally {
    URL.revokeObjectURL(url);
  }
};

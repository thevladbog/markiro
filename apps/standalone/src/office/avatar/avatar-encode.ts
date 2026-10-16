import { AVATAR_MAX_BYTES, type PhotoMediaType } from "../../host/protocol.js";
import { outputSide, type CropRect } from "./avatar-crop.js";

/** The slice of a canvas the encoder uses; tests pass a stub. */
export interface AvatarCanvas {
  width: number;
  height: number;
  getContext: (kind: "2d") => {
    fillStyle: string | CanvasGradient | CanvasPattern;
    fillRect: (x: number, y: number, w: number, h: number) => void;
    drawImage: (
      image: CanvasImageSource,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) => void;
  } | null;
  toBlob: (done: (blob: Blob | null) => void, type?: string, quality?: number) => void;
}

/** The picture could not be drawn or encoded. */
export class AvatarEncodeError extends Error {
  constructor(reason: string) {
    super(`the photo could not be encoded: ${reason}`);
    this.name = "AvatarEncodeError";
  }
}

/** The photo as it goes to the host. */
export interface EncodedAvatar {
  dataBase64: string;
  mediaType: PhotoMediaType;
  side: number;
}

/** WebP is tried first (smaller); JPEG where the webview answers another type. */
const WEBP_QUALITIES = [0.85, 0.7, 0.5] as const;
const JPEG_QUALITIES = [0.9, 0.75, 0.6] as const;

function toBlob(canvas: AvatarCanvas, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function defaultCanvas(): AvatarCanvas {
  return document.createElement("canvas");
}

/**
 * The cropped square as the photo the host keeps: drawn from the picture's `rect` onto a canvas of
 * 128..256 px on a white ground and read back as WebP (JPEG where the webview has no WebP encoder).
 * Only the canvas's bytes leave the office, so the original file's metadata (EXIF, GPS) never does.
 * The host's 2 MiB ceiling is met by lowering the quality; a 256 px square fits it many times over.
 */
export async function encodeAvatar(
  image: CanvasImageSource,
  rect: CropRect,
  createCanvas: () => AvatarCanvas = defaultCanvas,
): Promise<EncodedAvatar> {
  const side = outputSide(rect.side);
  const canvas = createCanvas();
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext("2d");
  if (context === null) throw new AvatarEncodeError("no 2d context");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, side, side);
  context.drawImage(image, rect.sx, rect.sy, rect.side, rect.side, 0, 0, side, side);

  const attempts: [string, number][] = [
    ...WEBP_QUALITIES.map((q): [string, number] => ["image/webp", q]),
  ];
  let jpegTried = false;
  for (let at = 0; at < attempts.length; at += 1) {
    const [type, quality] = attempts[at] ?? ["image/webp", 0.5];
    const blob = await toBlob(canvas, type, quality);
    if (blob?.type === "image/webp" || blob?.type === "image/jpeg") {
      if (blob.size <= AVATAR_MAX_BYTES) {
        return {
          dataBase64: toBase64(new Uint8Array(await blob.arrayBuffer())),
          mediaType: blob.type,
          side,
        };
      }
    } else if (!jpegTried) {
      // No WebP encoder (the canvas answers PNG, or nothing): the rest is JPEG.
      jpegTried = true;
      attempts.splice(
        at + 1,
        attempts.length,
        ...JPEG_QUALITIES.map((q): [string, number] => ["image/jpeg", q]),
      );
    }
  }
  throw new AvatarEncodeError("no encoding fits the host's size limit");
}

import { checkAvatarDimensions, checkAvatarFile, type AvatarProblem } from "./avatar-rules.js";

/** A picked file the profile cannot use; `problem` says why. */
export class AvatarPictureError extends Error {
  readonly problem: AvatarProblem;
  constructor(problem: AvatarProblem) {
    super(`the picture is not usable: ${problem}`);
    this.name = "AvatarPictureError";
    this.problem = problem;
  }
}

/** A decoded picture and the object URL it was read from (released when the dialog is done with it). */
export interface AvatarPicture {
  image: HTMLImageElement;
  width: number;
  height: number;
  src: string;
  release: () => void;
}

/**
 * Reads a picked file as a picture. The file is untrusted: its type and size are judged before a byte
 * is read, its declared sides (128..4096, so at most 16.7 million pixels) before it is decoded.
 */
export async function loadAvatarPicture(
  file: { type: string; size: number } & Blob,
): Promise<AvatarPicture> {
  const wrong = checkAvatarFile(file);
  if (wrong !== null) throw new AvatarPictureError(wrong);
  const src = URL.createObjectURL(file);
  const release = () => URL.revokeObjectURL(src);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("the picture did not load"));
      image.src = src;
    });
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const sides = checkAvatarDimensions(width, height);
    if (sides !== null) throw new AvatarPictureError(sides);
    await image.decode();
    return { image, width, height, src, release };
  } catch (error) {
    release();
    throw error instanceof AvatarPictureError ? error : new AvatarPictureError("unreadable");
  }
}

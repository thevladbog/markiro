import {
  logoFromRgba,
  sheetLogoFingerprint,
  validateMonoBitmap,
  type MonoBitmap,
  type SheetLogo,
} from "@markiro/domain";

// Vite gives this small SVG as a data URL (or a bundled file in a larger
// build): an <img> decodes either, since the webview's CSP allows `data:` and
// `'self'` images (`img-src 'self' data: blob:`); a `fetch` of a data URL would
// not pass `connect-src`, so the logo is never fetched.
import markiroLogoUrl from "../assets/markiro-print-logo.svg";

/**
 * A monochrome logo on the wire (`OrgLogo`, `ShiftSnapshotLogo` of
 * `markiro_proto`): its size in dots and its rows, MSB first, 1 = ink, each
 * row padded to whole bytes with zero bits, in standard base64.
 */
export interface WireLogo {
  width: number;
  height: number;
  pixelsBase64: string;
}

/** The host's bounds (`validate::mono_logo`): 1024 × 512 dots, 90 000 base64 characters. */
export const MAX_LOGO_WIDTH = 1024;
export const MAX_LOGO_HEIGHT = 512;
export const MAX_LOGO_BASE64 = 90_000;

/**
 * The largest picture file the office decodes as a logo: the file is untrusted
 * and the webview's decoder allocates for its full size before the logo is
 * shrunk to 1024 × 512, so a larger file is refused unread.
 */
export const MAX_LOGO_FILE_BYTES = 4 * 1024 * 1024;

/** The picture formats a logo may come in (the picked file's MIME type). */
export const LOGO_FILE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
];

export type LogoDecodeFailure =
  "too_large" | "unsupported_type" | "decode_failed" | "empty" | "canvas_unavailable";

/**
 * A picture that cannot become a logo, with the reason as a code the office
 * words for the user (a precise error, never a silent blank logo).
 */
export class LogoDecodeError extends Error {
  readonly code: LogoDecodeFailure;

  constructor(code: LogoDecodeFailure) {
    super(`logo image refused: ${code}`);
    this.name = "LogoDecodeError";
    this.code = code;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // Only the canonical spelling: the host compares the text it stores.
  return toBase64(bytes) === text ? bytes : null;
}

/** A bitmap as the host takes it. */
export function logoToWire(bitmap: MonoBitmap): WireLogo {
  validateMonoBitmap(bitmap);
  return { width: bitmap.width, height: bitmap.height, pixelsBase64: toBase64(bitmap.pixels) };
}

/** The bitmap of a wire logo, or `null` for one this build cannot print. */
export function logoFromWire(logo: WireLogo): MonoBitmap | null {
  const { width, height, pixelsBase64 } = logo;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_LOGO_WIDTH ||
    height > MAX_LOGO_HEIGHT ||
    pixelsBase64.length > MAX_LOGO_BASE64
  ) {
    return null;
  }
  const pixels = fromBase64(pixelsBase64);
  if (pixels === null) return null;
  const bitmap: MonoBitmap = { width, height, stride: Math.ceil(width / 8), pixels };
  try {
    validateMonoBitmap(bitmap);
  } catch {
    return null;
  }
  return bitmap;
}

/** A logo's size within 1024 × 512 with its aspect kept; a smaller one stays as it is. */
export function fitLogoSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_LOGO_WIDTH / width, MAX_LOGO_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Decodes an image the webview can show into the domain's 1-bit logo, after
 * the cloud station's `decodeBrowserLogo`: drawn on white (a transparent
 * logo prints on paper), at `scale` times its natural size and never more
 * than 1024 × 512, then thresholded by `logoFromRgba`. A picture the webview
 * cannot decode, or one with no size, is a `LogoDecodeError`.
 */
export async function decodeLogoImage(src: string, scale = 1): Promise<MonoBitmap> {
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    throw new LogoDecodeError("decode_failed");
  }
  if (image.naturalWidth < 1 || image.naturalHeight < 1) throw new LogoDecodeError("empty");
  const size = fitLogoSize(image.naturalWidth * scale, image.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (context === null) throw new LogoDecodeError("canvas_unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(image, 0, 0, size.width, size.height);
  return logoFromRgba(
    size.width,
    size.height,
    context.getImageData(0, 0, size.width, size.height).data,
  );
}

/**
 * A file the office picked (PNG, JPEG, WebP, SVG) as a logo. The file is
 * untrusted: its type must be one of `LOGO_FILE_TYPES` and its size at most
 * `MAX_LOGO_FILE_BYTES`, both checked before the webview reads a byte.
 */
export async function decodeLogoFile(file: Blob): Promise<MonoBitmap> {
  if (!LOGO_FILE_TYPES.includes(file.type)) throw new LogoDecodeError("unsupported_type");
  if (file.size > MAX_LOGO_FILE_BYTES) throw new LogoDecodeError("too_large");
  const url = URL.createObjectURL(file);
  try {
    return await decodeLogoImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

let bundled: Promise<MonoBitmap> | null = null;

/**
 * The Markiro print logo shipped with the app (#703, `loadBundledMarkiroLogo`
 * of the cloud station, at the same 3.5× scale), decoded once per session; a
 * failure is not kept, so the next label tries again.
 */
export function loadBundledMarkiroLogo(): Promise<MonoBitmap> {
  bundled ??= decodeLogoImage(markiroLogoUrl, 3.5).catch((error: unknown) => {
    bundled = null;
    throw error instanceof Error ? error : new Error(String(error));
  });
  return bundled;
}

/**
 * The logo a thermal label prints in its `organization_logo` box: the
 * organization's own, else the bundled Markiro logo (`fallback: "markiro"`),
 * else none — the box stays empty, as the domain's generators leave it
 * without a logo, and the label still prints.
 */
export async function labelLogo(
  own: MonoBitmap | null,
  fallback: () => Promise<MonoBitmap> = loadBundledMarkiroLogo,
): Promise<MonoBitmap | null> {
  if (own !== null) return own;
  try {
    return await fallback();
  } catch {
    return null;
  }
}

/** A bitmap as `renderPalletSheet` takes its logo. */
export function sheetLogoOf(bitmap: MonoBitmap, source: "organization" | "markiro"): SheetLogo {
  return { ...bitmap, digest: sheetLogoFingerprint(bitmap), source };
}

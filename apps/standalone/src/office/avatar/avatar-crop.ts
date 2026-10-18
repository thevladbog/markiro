/**
 * The geometry of the profile's square crop (plan АВА, DESIGN §10). Pure: the dialog draws a view of
 * `VIEW` px over the picture and the photo that goes to the host is the square this module names.
 */

/** The zoom's range: 1 shows the largest square, `MAX_ZOOM` a fourth of its side. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** The photo's written side: the host's floor (128) up to what the design stores (256). */
export const AVATAR_MIN_OUTPUT = 128;
export const AVATAR_MAX_OUTPUT = 256;

/** The crop: the zoom and the centre of the square in the picture's own pixels. */
export interface CropState {
  zoom: number;
  cx: number;
  cy: number;
}

/** The square in the picture's pixels. */
export interface CropRect {
  sx: number;
  sy: number;
  side: number;
}

function sideOf(width: number, height: number, zoom: number): number {
  return Math.min(width, height) / zoom;
}

/** The crop inside the picture: the zoom in range, the square never past an edge. */
export function clampCrop(width: number, height: number, crop: CropState): CropState {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, crop.zoom));
  const half = sideOf(width, height, zoom) / 2;
  return {
    zoom,
    cx: Math.min(width - half, Math.max(half, crop.cx)),
    cy: Math.min(height - half, Math.max(half, crop.cy)),
  };
}

/** The first crop: the largest centred square. */
export function initialCrop(width: number, height: number): CropState {
  return { zoom: MIN_ZOOM, cx: width / 2, cy: height / 2 };
}

/** The same centre at another zoom. */
export function zoomCrop(width: number, height: number, crop: CropState, zoom: number): CropState {
  return clampCrop(width, height, { ...crop, zoom });
}

/**
 * The picture dragged by (`dx`, `dy`) px of a view of `viewSize` px: the square moves the other
 * way, `side / viewSize` picture pixels per view pixel.
 */
export function panCrop(
  width: number,
  height: number,
  crop: CropState,
  dx: number,
  dy: number,
  viewSize: number,
): CropState {
  const perPixel = sideOf(width, height, crop.zoom) / viewSize;
  return clampCrop(width, height, {
    zoom: crop.zoom,
    cx: crop.cx - dx * perPixel,
    cy: crop.cy - dy * perPixel,
  });
}

/** The square the crop names, in whole picture pixels. */
export function cropRect(width: number, height: number, crop: CropState): CropRect {
  const clamped = clampCrop(width, height, crop);
  const side = sideOf(width, height, clamped.zoom);
  return {
    sx: Math.round(clamped.cx - side / 2),
    sy: Math.round(clamped.cy - side / 2),
    side: Math.round(side),
  };
}

/** The side of the written photo for a square of `side` picture pixels. */
export function outputSide(side: number): number {
  return Math.min(AVATAR_MAX_OUTPUT, Math.max(AVATAR_MIN_OUTPUT, Math.round(side)));
}

/**
 * How the whole picture is placed in a preview of `size` px so that `rect` fills it: the `<img>`'s
 * width, height and offset inside a clipped box (the circles of 96, 48 and 32 px).
 */
export function previewLayout(
  width: number,
  height: number,
  rect: CropRect,
  size: number,
): { width: number; height: number; left: number; top: number } {
  const scale = size / rect.side;
  return {
    width: width * scale,
    height: height * scale,
    left: 0 - rect.sx * scale,
    top: 0 - rect.sy * scale,
  };
}

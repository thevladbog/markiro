/**
 * The colour a product's photo gives its panel (beta 3.2, owner feedback «фон
 * генерируется в зависимости от картинки товара»). The photo is sampled
 * client-side on a small canvas; the dominant vivid hue becomes the panel's
 * `--product-hue` and its saturation `--product-sat`. A photo with no vivid
 * colour (a grey or white-on-white picture), one that does not decode, and a
 * product without a photo keep the GTIN-derived hue (`hueFromGtin`), as before.
 * Computed once per photo checksum and kept for the session.
 */

export interface PhotoAccent {
  /** Degrees, 0 to 359. */
  hue: number;
  /** The panel's saturation, percent, within the range the dark panel stays legible at. */
  saturation: number;
}

/** The sampled edge, pixels: 32 x 32 is 1 024 samples, ample for a dominant hue. */
export const SAMPLE_SIZE = 32;
const BINS = 12;
/** Fewer vivid pixels than this share of the sample: the picture has no colour to take. */
const MIN_VIVID_SHARE = 0.03;
const MIN_SATURATION = 0.25;
const MIN_VALUE = 0.15;
const MIN_ALPHA = 128;

/**
 * The dominant vivid hue of an RGBA sample, or `null` without one. Pixels that
 * are transparent, near black or grey (a studio background, the label's white)
 * do not vote; the others vote by saturation times brightness into twelve
 * 30-degree bins, and the winning bin's circular mean is the hue.
 */
export function dominantAccent(rgba: ArrayLike<number>): PhotoAccent | null {
  const pixels = Math.floor(rgba.length / 4);
  if (pixels === 0) return null;
  const weight = new Array<number>(BINS).fill(0);
  const cos = new Array<number>(BINS).fill(0);
  const sin = new Array<number>(BINS).fill(0);
  const saturationSum = new Array<number>(BINS).fill(0);
  const count = new Array<number>(BINS).fill(0);
  let vivid = 0;
  for (let index = 0; index < pixels; index += 1) {
    const r = (rgba[index * 4] ?? 0) / 255;
    const g = (rgba[index * 4 + 1] ?? 0) / 255;
    const b = (rgba[index * 4 + 2] ?? 0) / 255;
    if ((rgba[index * 4 + 3] ?? 0) < MIN_ALPHA) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (max < MIN_VALUE || max === 0) continue;
    const saturation = delta / max;
    if (saturation < MIN_SATURATION) continue;
    let hue: number;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
    const bin = Math.min(BINS - 1, Math.floor(hue / (360 / BINS)));
    const vote = saturation * max;
    weight[bin] = (weight[bin] ?? 0) + vote;
    cos[bin] = (cos[bin] ?? 0) + Math.cos((hue * Math.PI) / 180) * vote;
    sin[bin] = (sin[bin] ?? 0) + Math.sin((hue * Math.PI) / 180) * vote;
    saturationSum[bin] = (saturationSum[bin] ?? 0) + saturation;
    count[bin] = (count[bin] ?? 0) + 1;
    vivid += 1;
  }
  if (vivid / pixels < MIN_VIVID_SHARE) return null;
  let best = 0;
  for (let bin = 1; bin < BINS; bin += 1) if ((weight[bin] ?? 0) > (weight[best] ?? 0)) best = bin;
  const hue = ((Math.atan2(sin[best] ?? 0, cos[best] ?? 0) * 180) / Math.PI + 360) % 360;
  const meanSaturation = (saturationSum[best] ?? 0) / Math.max(1, count[best] ?? 1);
  return {
    hue: Math.round(hue) % 360,
    saturation: Math.round(Math.min(55, Math.max(25, 20 + meanSaturation * 35))),
  };
}

const cache = new Map<string, PhotoAccent | null>();

/**
 * The accent of the picture at `src`, kept under its checksum. `null` when it
 * has no vivid colour or the webview cannot sample it (no canvas, no decode):
 * the caller keeps the GTIN hue.
 */
export async function accentOfPhoto(src: string, checksum: string): Promise<PhotoAccent | null> {
  if (cache.has(checksum)) return cache.get(checksum) ?? null;
  let accent: PhotoAccent | null;
  try {
    const image = new Image();
    image.src = src;
    if (typeof image.decode !== "function") return null;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) return null;
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    accent = dominantAccent(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
  } catch {
    return null;
  }
  cache.set(checksum, accent);
  return accent;
}

/** Forgets every kept accent (tests). */
export function forgetAccents(): void {
  cache.clear();
}

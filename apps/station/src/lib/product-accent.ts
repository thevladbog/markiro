import { useEffect, useState } from "react";
import type { SqlExecutor, StationProductImageDescriptor } from "./mirror.js";
import { readCachedStationProductImage, readStationProductImage } from "./product-image-cache.js";

/**
 * The product accent hue drives the identity hero's gradient on the work
 * screen. The PRINCIPLE, agreed in the design review (docs/design-briefs/
 * station-work-card.pen, «Принцип цвета»): the colour is always DERIVED from
 * the product, never assigned by hand — the photo's dominant hue when a photo
 * exists, a deterministic hash of the GTIN when it does not. Only the hue
 * varies; lightness and saturation are clamped by the CSS gradient so white
 * text and the green verdict chip keep their contrast on every product.
 */

/** How many pixels per side the photo is collapsed to before sampling. */
const SAMPLE_SIZE = 16;

/**
 * Deterministic fallback hue for a product with no usable photo: FNV-1a over
 * the GTIN, folded to degrees. Stable across stations and releases by design —
 * the same product must look the same on every device.
 */
export function hueFromGtin(gtin: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < gtin.length; index += 1) {
    hash ^= gtin.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

/**
 * What one product photo tells the surfaces that frame it.
 *
 * `hue` — the photo's dominant hue, or null when none can be established.
 * `opaque` — the photo carries its own background (a studio shot on white)
 * instead of being a cut-out on transparency. The two need different framing:
 * a cut-out stands directly on the product gradient, while a photo with a
 * baked background has to be presented AS a photo — a rounded plate with a
 * shadow — or its background reads as a white box nobody meant to be there.
 */
export interface ProductPhotoAccent {
  hue: number | null;
  opaque: boolean;
}

/**
 * How much of the sampled border ring must be fully opaque before the photo
 * counts as carrying its own background. A cut-out's ring is transparent
 * almost everywhere, a studio shot's is opaque everywhere, so the threshold
 * sits far from both: neither antialiasing nor a bottle touching one edge can
 * flip the answer.
 */
const OPAQUE_BORDER_SHARE = 0.75;

/**
 * Dominant hue and background kind of a product photo.
 *
 * Near-white pixels are skipped for the hue because catalogue photos are
 * studio shots on white; near-black and near-grey pixels carry no hue worth
 * voting with. The remaining pixels vote into twelve 30° hue bins weighted by
 * saturation, and the winning bin answers with its weighted mean hue.
 * Opacity is read from the border ring alone — the middle of a cut-out is its
 * subject and is opaque there too. Any environment without canvas/ImageBitmap
 * support (jsdom, a headless webview) degrades to null: the caller falls back
 * to the GTIN hue and to the cut-out framing.
 */
export async function extractPhotoAccent(blob: Blob): Promise<ProductPhotoAccent | null> {
  try {
    if (typeof createImageBitmap !== "function") return null;
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = SAMPLE_SIZE;
      canvas.height = SAMPLE_SIZE;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      const weights = new Array<number>(12).fill(0);
      const hueSums = new Array<number>(12).fill(0);
      let borderPixels = 0;
      let opaqueBorderPixels = 0;
      for (let offset = 0; offset < data.length; offset += 4) {
        const r = data[offset]!;
        const g = data[offset + 1]!;
        const b = data[offset + 2]!;
        const alpha = data[offset + 3]!;
        const pixel = offset / 4;
        const column = pixel % SAMPLE_SIZE;
        const row = (pixel - column) / SAMPLE_SIZE;
        if (column === 0 || row === 0 || column === SAMPLE_SIZE - 1 || row === SAMPLE_SIZE - 1) {
          borderPixels += 1;
          if (alpha > 250) opaqueBorderPixels += 1;
        }
        if (alpha < 128) continue;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const chroma = max - min;
        if (max > 235 && min > 210) continue; // studio-white background
        if (max < 30) continue; // near-black
        if (chroma < 24) continue; // grey carries no hue
        let hue: number;
        if (max === r) hue = ((g - b) / chroma) * 60;
        else if (max === g) hue = ((b - r) / chroma) * 60 + 120;
        else hue = ((r - g) / chroma) * 60 + 240;
        hue = (hue + 360) % 360;
        const saturation = chroma / 255;
        const bin = Math.floor(hue / 30) % 12;
        weights[bin] = weights[bin]! + saturation;
        hueSums[bin] = hueSums[bin]! + hue * saturation;
      }
      const opaque = borderPixels > 0 && opaqueBorderPixels / borderPixels >= OPAQUE_BORDER_SHARE;
      let best = -1;
      for (let bin = 0; bin < 12; bin += 1) {
        if (best === -1 || weights[bin]! > weights[best]!) best = bin;
      }
      // Fewer than ~4 saturated pixels' worth of votes means the photo is
      // effectively monochrome; a hue extracted from noise would flicker
      // between builds of the same image.
      if (best === -1 || weights[best]! < 0.5) return { hue: null, opaque };
      return { hue: Math.round(hueSums[best]! / weights[best]!), opaque };
    } finally {
      bitmap.close?.();
    }
  } catch {
    return null;
  }
}

/**
 * One extraction per image, ever: the descriptor's checksum names the exact
 * bytes, so the answer can never go stale and is shared across remounts and
 * across every screen that shows the product.
 */
const accentByChecksum = new Map<string, ProductPhotoAccent>();

/** What a product with no usable photo answers: no hue of its own, no plate. */
const NO_PHOTO: ProductPhotoAccent = { hue: null, opaque: false };

/**
 * Pre-seeds the checksum cache. Production never needs this — the hook fills
 * the cache itself — but tests exercising the hook's transition guarantees
 * have no canvas to extract with, so this is their only way in.
 */
export function primePhotoAccent(checksum: string, accent: ProductPhotoAccent): void {
  accentByChecksum.set(checksum, accent);
}

/** Seeds a hue for a cut-out photo; see {@link primePhotoAccent}. */
export function primeAccentHue(checksum: string, hue: number | null): void {
  primePhotoAccent(checksum, { hue, opaque: false });
}

/**
 * An extraction answer is only valid for the exact bytes it was sampled from,
 * so the state carries the checksum and the render-time guard below refuses
 * to apply it to any other image. Without the tag, switching products would
 * paint the NEW product's hero with the OLD product's hue until the new
 * read settled — a lie precisely when the colour matters most.
 */
interface ExtractedAccent {
  checksum: string;
  accent: ProductPhotoAccent;
}

export interface ProductAccentSource {
  exec?: SqlExecutor | undefined;
  productId?: string | undefined;
  image?: StationProductImageDescriptor | null | undefined;
  gtin?: string | null | undefined;
  refreshKey?: number | undefined;
}

/**
 * Everything a surface needs to frame one product photo. Answers the GTIN
 * fallback hue immediately (no flash of the neutral gradient) and upgrades to
 * the photo's own hue and background kind once the cached bytes have been read
 * and sampled. `opaque` stays false until then: a cut-out framed for one frame
 * as a cut-out is invisible, while a plate that appears and then disappears is
 * not.
 */
export function useProductPhotoAccent({
  exec,
  productId,
  image,
  gtin,
  refreshKey,
}: ProductAccentSource): ProductPhotoAccent {
  const fallbackHue = gtin ? hueFromGtin(gtin) : null;
  const [extracted, setExtracted] = useState<ExtractedAccent | null>(() => {
    if (!image) return null;
    const known = accentByChecksum.get(image.checksum);
    return known === undefined ? null : { checksum: image.checksum, accent: known };
  });

  useEffect(() => {
    let cancelled = false;
    if (!exec || !productId || !image) {
      setExtracted(null);
      return;
    }
    const checksum = image.checksum;
    const known = accentByChecksum.get(checksum);
    if (known !== undefined) {
      setExtracted({ checksum, accent: known });
      return;
    }
    void (async () => {
      let blob: Blob | null = await readStationProductImage(exec, productId, image);
      if (!blob) blob = await readCachedStationProductImage(productId, image, exec);
      const accent = blob ? ((await extractPhotoAccent(blob)) ?? NO_PHOTO) : NO_PHOTO;
      // A missing blob is not cached: media sync may still be landing the
      // bytes, and the next refreshKey bump should get to try again.
      if (blob) accentByChecksum.set(checksum, accent);
      if (!cancelled) setExtracted({ checksum, accent });
    })().catch(() => {
      if (!cancelled) setExtracted(null);
    });
    return () => {
      cancelled = true;
    };
  }, [exec, productId, image, refreshKey]);

  // The guard, not the effect, is what makes stale answers impossible: the
  // effect only runs after the new image has already painted once.
  const current =
    extracted !== null && image && extracted.checksum === image.checksum ? extracted.accent : null;
  return { hue: current?.hue ?? fallbackHue, opaque: current?.opaque ?? false };
}

/** The hue alone, for surfaces that only tint a gradient. */
export function useProductAccentHue(source: ProductAccentSource): number | null {
  return useProductPhotoAccent(source).hue;
}

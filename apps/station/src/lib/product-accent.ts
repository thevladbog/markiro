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
 * Dominant hue of a product photo, or null when none can be established.
 *
 * Near-white pixels are skipped because catalogue photos are studio shots on
 * white; near-black and near-grey pixels carry no hue worth voting with. The
 * remaining pixels vote into twelve 30° hue bins weighted by saturation, and
 * the winning bin answers with its weighted mean hue. Any environment without
 * canvas/ImageBitmap support (jsdom, a headless webview) degrades to null —
 * the caller falls back to the GTIN hue.
 */
export async function extractAccentHue(blob: Blob): Promise<number | null> {
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
      for (let offset = 0; offset < data.length; offset += 4) {
        const r = data[offset]!;
        const g = data[offset + 1]!;
        const b = data[offset + 2]!;
        const alpha = data[offset + 3]!;
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
      let best = -1;
      for (let bin = 0; bin < 12; bin += 1) {
        if (best === -1 || weights[bin]! > weights[best]!) best = bin;
      }
      // Fewer than ~4 saturated pixels' worth of votes means the photo is
      // effectively monochrome; a hue extracted from noise would flicker
      // between builds of the same image.
      if (best === -1 || weights[best]! < 0.5) return null;
      return Math.round(hueSums[best]! / weights[best]!);
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
const accentByChecksum = new Map<string, number | null>();

/**
 * Pre-seeds the checksum cache. Production never needs this — the hook fills
 * the cache itself — but tests exercising the hook's transition guarantees
 * have no canvas to extract with, so this is their only way in.
 */
export function primeAccentHue(checksum: string, hue: number | null): void {
  accentByChecksum.set(checksum, hue);
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
  hue: number | null;
}

export interface ProductAccentSource {
  exec?: SqlExecutor | undefined;
  productId?: string | undefined;
  image?: StationProductImageDescriptor | null | undefined;
  gtin?: string | null | undefined;
  refreshKey?: number | undefined;
}

/**
 * The hue for the identity hero. Answers the GTIN fallback immediately (no
 * flash of the neutral gradient) and upgrades to the photo's dominant hue once
 * the cached bytes have been read and sampled.
 */
export function useProductAccentHue({
  exec,
  productId,
  image,
  gtin,
  refreshKey,
}: ProductAccentSource): number | null {
  const fallback = gtin ? hueFromGtin(gtin) : null;
  const [extracted, setExtracted] = useState<ExtractedAccent | null>(() => {
    if (!image) return null;
    const known = accentByChecksum.get(image.checksum);
    return known === undefined ? null : { checksum: image.checksum, hue: known };
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
      setExtracted({ checksum, hue: known });
      return;
    }
    void (async () => {
      let blob: Blob | null = await readStationProductImage(exec, productId, image);
      if (!blob) blob = await readCachedStationProductImage(productId, image, exec);
      const hue = blob ? await extractAccentHue(blob) : null;
      // A missing blob is not cached: media sync may still be landing the
      // bytes, and the next refreshKey bump should get to try again.
      if (blob) accentByChecksum.set(checksum, hue);
      if (!cancelled) setExtracted({ checksum, hue });
    })().catch(() => {
      if (!cancelled) setExtracted(null);
    });
    return () => {
      cancelled = true;
    };
  }, [exec, productId, image, refreshKey]);

  // The guard, not the effect, is what makes stale hues impossible: the
  // effect only runs after the new image has already painted once.
  const extractedHue =
    extracted !== null && image && extracted.checksum === image.checksum ? extracted.hue : null;
  return extractedHue ?? fallback;
}

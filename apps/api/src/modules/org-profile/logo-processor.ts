import { createHash } from "node:crypto";
import { processRasterImage } from "../profile/raster-image-processor";

export interface ProcessedLogo {
  buffer: Buffer;
  contentType: "image/webp";
  byteSize: number;
  checksum: string;
  width: number;
  height: number;
}

export async function processLogo(input: Buffer): Promise<ProcessedLogo> {
  const image = await processRasterImage(input, {
    maxSourceBytes: 5 * 1024 * 1024,
    maxDimension: 8192,
    maxPixels: 25_000_000,
    maxFrames: 1,
    width: 1024,
    height: 512,
    fit: "inside",
    withoutEnlargement: true,
    quality: 85,
    label: "Logo",
    pluralLabel: "logos",
  });
  return {
    buffer: image.buffer,
    contentType: "image/webp",
    byteSize: image.buffer.byteLength,
    checksum: createHash("sha256").update(image.buffer).digest("hex"),
    width: image.width,
    height: image.height,
  };
}

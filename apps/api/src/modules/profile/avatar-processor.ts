import { createHash } from "node:crypto";
import { processRasterImage } from "./raster-image-processor";

export interface ProcessedAvatar {
  buffer: Buffer;
  contentType: "image/webp";
  byteSize: number;
  checksum: string;
  width: 512;
  height: 512;
}

export async function processAvatar(input: Buffer): Promise<ProcessedAvatar> {
  const image = await processRasterImage(input, {
    maxSourceBytes: 5 * 1024 * 1024,
    maxDimension: 8192,
    maxPixels: 25_000_000,
    maxFrames: 1,
    width: 512,
    height: 512,
    fit: "cover",
    position: "attention",
    withoutEnlargement: false,
    quality: 85,
    label: "Avatar",
    pluralLabel: "avatars",
  });
  return {
    buffer: image.buffer,
    contentType: "image/webp",
    byteSize: image.buffer.byteLength,
    checksum: createHash("sha256").update(image.buffer).digest("hex"),
    width: 512,
    height: 512,
  };
}

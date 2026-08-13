import { createHash } from "node:crypto";
import { normalizeBoundedImage } from "./bounded-image-processor";

export interface ProcessedProductImage {
  buffer: Buffer;
  contentType: "image/webp";
  byteSize: number;
  checksum: string;
  width: number;
  height: number;
}

export async function processProductImage(input: Buffer): Promise<ProcessedProductImage> {
  const normalized = await normalizeBoundedImage(input, {
    subject: "Product image",
    kind: "product",
  });
  return {
    buffer: normalized.buffer,
    contentType: "image/webp",
    byteSize: normalized.buffer.byteLength,
    checksum: createHash("sha256").update(normalized.buffer).digest("hex"),
    width: normalized.width,
    height: normalized.height,
  };
}

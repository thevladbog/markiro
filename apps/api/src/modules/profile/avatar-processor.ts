import { createHash } from "node:crypto";
import { normalizeBoundedImage } from "../media/bounded-image-processor";

export interface ProcessedAvatar {
  buffer: Buffer;
  contentType: "image/webp";
  byteSize: number;
  checksum: string;
  width: 512;
  height: 512;
}

export async function processAvatar(input: Buffer): Promise<ProcessedAvatar> {
  const { buffer } = await normalizeBoundedImage(input, { subject: "Avatar", kind: "avatar" });
  return {
    buffer,
    contentType: "image/webp",
    byteSize: buffer.byteLength,
    checksum: createHash("sha256").update(buffer).digest("hex"),
    width: 512,
    height: 512,
  };
}

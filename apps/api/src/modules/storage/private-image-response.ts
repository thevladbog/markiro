import { NotFoundException } from "@nestjs/common";
import type { Response } from "express";
import type { ObjectStorageService } from "./object-storage.service";

const PRIVATE_IMAGE_CACHE_CONTROL = "private, max-age=300, immutable";

/**
 * Streams a tenant-authorized, content-addressed WebP through the API origin.
 * Production CSP deliberately allows images and device fetches only from
 * `self`, so redirecting to a presigned object-storage URL makes otherwise
 * valid images unreadable in admin, kiosk, and station clients.
 */
export async function sendPrivateImage(
  storage: ObjectStorageService,
  objectKey: string,
  checksum: string,
  response: Response,
): Promise<void> {
  const object = await storage.get(objectKey);
  if (object.contentType !== "image/webp") throw new NotFoundException();

  response.set({
    "Cache-Control": PRIVATE_IMAGE_CACHE_CONTROL,
    "Content-Length": String(object.body.byteLength),
    "Content-Type": "image/webp",
    ETag: `"${checksum}"`,
  });
  response.status(200).send(object.body);
}

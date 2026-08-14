import type { KioskClient } from "../api/client.js";
import type { KioskBootstrapDto, ProductImageDescriptor } from "../api/types.js";
import {
  clearPublishedProductImage,
  deleteProductImageBlob,
  hasProductImageBlob,
  pruneProductImages,
  publishProductImage,
  readProductImageBlob,
  readPublishedProductImagePointer,
} from "../store/product-images.js";

const MAX_CONCURRENCY = 3;

export interface ProductImageSyncResult {
  downloaded: number;
  reused: number;
  removed: number;
  failed: number;
}

function checksumHex(bytes: ArrayBuffer): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", bytes)
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

async function validate(blob: Blob, descriptor: ProductImageDescriptor): Promise<void> {
  if (blob.type !== descriptor.contentType) throw new Error("product image content type mismatch");
  if (blob.size !== descriptor.byteSize) throw new Error("product image byte size mismatch");
  if ((await checksumHex(await blob.arrayBuffer())) !== descriptor.checksum) {
    throw new Error("product image checksum mismatch");
  }
}

export async function syncProductImages(
  client: Pick<KioskClient, "downloadProductImage">,
  products: KioskBootstrapDto["products"],
): Promise<ProductImageSyncResult> {
  const result: ProductImageSyncResult = { downloaded: 0, reused: 0, removed: 0, failed: 0 };
  const allowed = new Set(products.map((product) => product.id));
  try {
    await pruneProductImages(allowed);
  } catch (error) {
    console.warn("kiosk: product image orphan cleanup failed", error);
  }

  let next = 0;
  async function worker(): Promise<void> {
    while (next < products.length) {
      const product = products[next++];
      if (!product) continue;
      const descriptor = product.image;
      try {
        if (descriptor === undefined) continue;
        if (descriptor === null) {
          const previous = await readPublishedProductImagePointer(product.id);
          if (previous) {
            await clearPublishedProductImage(product.id);
            result.removed += 1;
          }
          continue;
        }
        const previous = await readPublishedProductImagePointer(product.id);
        if (
          previous?.checksum === descriptor.checksum &&
          (await hasProductImageBlob(descriptor.checksum))
        ) {
          const cached = await readProductImageBlob(descriptor.checksum);
          if (cached) {
            try {
              await validate(cached, descriptor);
              result.reused += 1;
              continue;
            } catch (error) {
              console.warn("kiosk: cached product image failed validation", product.id, error);
              await clearPublishedProductImage(product.id);
              await deleteProductImageBlob(descriptor.checksum);
            }
          }
        }
        if (await hasProductImageBlob(descriptor.checksum)) {
          const blob = await readProductImageBlob(descriptor.checksum);
          if (!blob) throw new Error("product image blob disappeared");
          try {
            await validate(blob, descriptor);
          } catch (error) {
            await clearPublishedProductImage(product.id);
            await deleteProductImageBlob(descriptor.checksum);
            throw error;
          }
          await publishProductImage(product.id, descriptor.checksum, blob);
          result.reused += 1;
          continue;
        }
        const blob = await client.downloadProductImage(product.id, descriptor.checksum);
        await validate(blob, descriptor);
        await publishProductImage(product.id, descriptor.checksum, blob);
        result.downloaded += 1;
      } catch (error) {
        result.failed += 1;
        console.warn("kiosk: product image sync failed", product.id, error);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, products.length) }, worker));
  return result;
}

import type { StationClient } from "./api-client.js";
import type { SqlExecutor, StationProductImageDescriptor } from "./mirror.js";

export const STATION_PRODUCT_IMAGE_CACHE = "markiro-station-product-images-v1";
const CACHE_ORIGIN = "https://station.invalid/product-images/";

type CacheLike = Cache & { delete(request: RequestInfo): Promise<boolean> };

function cacheKey(productId: string, checksum: string): string {
  return `${CACHE_ORIGIN}${encodeURIComponent(productId)}/${encodeURIComponent(checksum)}`;
}

async function openImageCache(): Promise<CacheLike> {
  if (typeof caches === "undefined") throw new Error("Cache Storage unavailable");
  return (await caches.open(STATION_PRODUCT_IMAGE_CACHE)) as CacheLike;
}

async function digest(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

async function validateBlob(blob: Blob, descriptor: StationProductImageDescriptor): Promise<void> {
  if (blob.type !== descriptor.contentType || blob.size !== descriptor.byteSize) {
    throw new Error("station product image metadata mismatch");
  }
  if ((await digest(await blob.arrayBuffer())) !== descriptor.checksum) {
    throw new Error("station product image checksum mismatch");
  }
}

export async function syncStationProductImage(
  exec: SqlExecutor,
  client: Pick<StationClient, "download">,
  product: { id: string; image?: StationProductImageDescriptor | null },
): Promise<void> {
  try {
    if (product.image === undefined) return;
    if (product.image === null) {
      await exec.run("UPDATE product_mirror SET image_pointer_checksum = NULL WHERE id = ?", [product.id]);
      const cache = await openImageCache();
      for (const request of await cache.keys()) {
        if (request.url.startsWith(`${CACHE_ORIGIN}${encodeURIComponent(product.id)}/`)) {
          await cache.delete(request);
        }
      }
      return;
    }
    const cache = await openImageCache();
    const key = cacheKey(product.id, product.image.checksum);
    const existing = await cache.match(key);
    if (!existing) {
      const blob = await client.download(
        `/station/products/${encodeURIComponent(product.id)}/image/${encodeURIComponent(product.image.checksum)}`,
      );
      await validateBlob(blob, product.image);
      await cache.put(key, new Response(blob, { headers: { "Content-Type": product.image.contentType } }));
    } else {
      await validateBlob(await existing.blob(), product.image);
    }
    await exec.run("UPDATE product_mirror SET image_pointer_checksum = ? WHERE id = ? AND image_checksum = ?", [
      product.image.checksum,
      product.id,
      product.image.checksum,
    ]);
  } catch (error) {
    console.error("station: product image sync failed", error);
  }
}

export async function readStationProductImage(exec: SqlExecutor, productId: string): Promise<Blob | null> {
  const rows = await exec.all<{ image_pointer_checksum: string | null }>(
    "SELECT image_pointer_checksum FROM product_mirror WHERE id = ?",
    [productId],
  );
  const checksum = rows[0]?.image_pointer_checksum;
  if (!checksum) return null;
  try {
    const cache = await openImageCache();
    const response = await cache.match(cacheKey(productId, checksum));
    return response ? await response.blob() : null;
  } catch {
    return null;
  }
}

export async function clearStationProductImages(exec: SqlExecutor): Promise<void> {
  await exec.run("UPDATE product_mirror SET image_pointer_checksum = NULL");
  try {
    if (typeof caches !== "undefined") await caches.delete(STATION_PRODUCT_IMAGE_CACHE);
  } catch (error) {
    console.error("station: product image cache clear failed", error);
  }
}

export { cacheKey as stationProductImageCacheKey };

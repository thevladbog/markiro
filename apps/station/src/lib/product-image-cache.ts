import type { StationClient } from "./api-client.js";
import type { SqlExecutor, StationProductImageDescriptor } from "./mirror.js";

export interface StationProductImageCacheRow {
  content_type: string;
  byte_size: number;
  bytes_base64: string;
}

export interface StationProductImagePointerRow {
  image_pointer_checksum: string | null;
  image_checksum: string | null;
  image_content_type: string | null;
  image_byte_size: number | null;
  image_width: number | null;
  image_height: number | null;
}

export const STATION_PRODUCT_IMAGE_CACHE = "markiro-station-product-images-v1";
const CACHE_ORIGIN = "https://station.invalid/product-images/";

type CacheLike = Cache & { delete(request: RequestInfo): Promise<boolean> };
const activeImageMirrors = new Set<Promise<void>>();

function cacheKey(productId: string, checksum: string): string {
  return `${CACHE_ORIGIN}${encodeURIComponent(productId)}/${encodeURIComponent(checksum)}`;
}

async function openImageCache(): Promise<CacheLike> {
  if (typeof caches === "undefined") throw new Error("Cache Storage unavailable");
  return caches.open(STATION_PRODUCT_IMAGE_CACHE);
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

async function writeSqliteImage(
  exec: SqlExecutor,
  descriptor: StationProductImageDescriptor,
  blob: Blob,
): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await exec.run(
    `INSERT INTO station_product_images (checksum, content_type, byte_size, bytes_base64)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(checksum) DO UPDATE SET
       content_type=excluded.content_type,
       byte_size=excluded.byte_size,
       bytes_base64=excluded.bytes_base64`,
    [descriptor.checksum, descriptor.contentType, descriptor.byteSize, bytesToBase64(bytes)],
  );
}

async function readSqliteImage(
  exec: SqlExecutor,
  checksum: string,
  descriptor?: StationProductImageDescriptor,
): Promise<Blob | null> {
  const rows = await exec.all<StationProductImageCacheRow>(
    `SELECT content_type, byte_size, bytes_base64
       FROM station_product_images WHERE checksum = ?`,
    [checksum],
  );
  const row = rows[0];
  if (!row) return null;
  try {
    if (row.content_type !== "image/webp") throw new Error("invalid cached image content type");
    const blob = new Blob([base64ToBuffer(row.bytes_base64)], { type: row.content_type });
    await validateBlob(
      blob,
      descriptor ?? {
        checksum,
        contentType: "image/webp",
        byteSize: row.byte_size,
        width: 0,
        height: 0,
      },
    );
    return blob;
  } catch {
    await exec.run("DELETE FROM station_product_images WHERE checksum = ?", [checksum]);
    return null;
  }
}

async function readBrowserImage(
  productId: string,
  descriptor: StationProductImageDescriptor,
): Promise<Blob | null> {
  try {
    const cache = await openImageCache();
    const key = cacheKey(productId, descriptor.checksum);
    const response = await cache.match(key);
    if (!response) return null;
    const blob = await response.blob();
    try {
      await validateBlob(blob, descriptor);
      return blob;
    } catch {
      await cache.delete(key);
      return null;
    }
  } catch {
    return null;
  }
}

async function writeBrowserImage(
  productId: string,
  descriptor: StationProductImageDescriptor,
  blob: Blob,
): Promise<void> {
  try {
    const cache = await openImageCache();
    await cache.put(
      cacheKey(productId, descriptor.checksum),
      new Response(blob, { headers: { "Content-Type": descriptor.contentType } }),
    );
  } catch {
    // SQLite is the station's durable boundary. Browser cache is opportunistic.
  }
}

export async function prefetchStationProductImage(
  client: Pick<StationClient, "download">,
  product: { id: string; image?: StationProductImageDescriptor | null },
  isSealed?: () => boolean,
  exec?: SqlExecutor,
): Promise<void> {
  if (!product.image) return;
  try {
    if (isSealed?.()) return;
    const sqliteImage = exec
      ? await readSqliteImage(exec, product.image.checksum, product.image)
      : null;
    if (sqliteImage) return;
    const browserImage = await readBrowserImage(product.id, product.image);
    if (browserImage) {
      if (exec) {
        if (isSealed?.()) return;
        await writeSqliteImage(exec, product.image, browserImage);
      }
      return;
    }
    const blob = await client.download(
      `/station/products/${encodeURIComponent(product.id)}/image/${encodeURIComponent(product.image.checksum)}`,
    );
    if (isSealed?.()) return;
    await validateBlob(blob, product.image);
    if (exec) {
      if (isSealed?.()) return;
      await writeSqliteImage(exec, product.image, blob);
    }
    if (isSealed?.()) return;
    await writeBrowserImage(product.id, product.image, blob);
  } catch (error) {
    console.error("station: product image prefetch failed", error);
  }
}

export async function syncStationProductImage(
  exec: SqlExecutor,
  client: Pick<StationClient, "download">,
  product: { id: string; image?: StationProductImageDescriptor | null },
  isSealed?: () => boolean,
): Promise<void> {
  try {
    if (isSealed?.()) return;
    if (product.image === undefined) return;
    if (product.image === null) {
      await exec.run("UPDATE product_mirror SET image_pointer_checksum = NULL WHERE id = ?", [
        product.id,
      ]);
      try {
        const cache = await openImageCache();
        for (const request of await cache.keys()) {
          if (request.url.startsWith(`${CACHE_ORIGIN}${encodeURIComponent(product.id)}/`)) {
            await cache.delete(request);
          }
        }
      } catch {
        // An explicit tombstone is already durable in SQLite.
      }
      return;
    }
    let blob = await readSqliteImage(exec, product.image.checksum, product.image);
    if (!blob) {
      blob = await readBrowserImage(product.id, product.image);
      if (blob) {
        if (isSealed?.()) return;
        await writeSqliteImage(exec, product.image, blob);
      }
    }
    if (!blob) {
      const blob = await client.download(
        `/station/products/${encodeURIComponent(product.id)}/image/${encodeURIComponent(product.image.checksum)}`,
      );
      if (isSealed?.()) return;
      await validateBlob(blob, product.image);
      if (isSealed?.()) return;
      await writeSqliteImage(exec, product.image, blob);
      if (isSealed?.()) return;
      await writeBrowserImage(product.id, product.image, blob);
    }
    if (isSealed?.()) return;
    await exec.run(
      "UPDATE product_mirror SET image_pointer_checksum = ? WHERE id = ? AND image_checksum = ?",
      [product.image.checksum, product.id, product.image.checksum],
    );
  } catch (error) {
    console.error("station: product image sync failed", error);
  }
}

export function trackStationProductImageSync(operation: Promise<void>): void {
  activeImageMirrors.add(operation);
  void operation.finally(() => activeImageMirrors.delete(operation));
}

export async function waitForStationProductImageMirrors(): Promise<void> {
  await Promise.all([...activeImageMirrors]);
}

export async function readStationProductImage(
  exec: SqlExecutor,
  productId: string,
  descriptor?: StationProductImageDescriptor,
): Promise<Blob | null> {
  const rows = await exec.all<StationProductImagePointerRow>(
    `SELECT image_pointer_checksum, image_checksum, image_content_type,
            image_byte_size, image_width, image_height
       FROM product_mirror WHERE id = ?`,
    [productId],
  );
  const row = rows[0];
  const checksum = row?.image_pointer_checksum;
  if (!checksum) return null;
  const sqliteImage = await readSqliteImage(exec, checksum, descriptor);
  if (sqliteImage) return sqliteImage;
  const retainedDescriptor =
    row.image_checksum === checksum &&
    row.image_content_type === "image/webp" &&
    row.image_byte_size !== null &&
    row.image_width !== null &&
    row.image_height !== null
      ? {
          checksum,
          contentType: "image/webp" as const,
          byteSize: row.image_byte_size,
          width: row.image_width,
          height: row.image_height,
        }
      : null;
  const validationDescriptor = descriptor ?? retainedDescriptor;
  if (!validationDescriptor) return null;
  return readBrowserImage(productId, validationDescriptor);
}

export async function readCachedStationProductImage(
  productId: string,
  descriptor: StationProductImageDescriptor,
  exec?: SqlExecutor,
): Promise<Blob | null> {
  if (exec) {
    const sqliteImage = await readSqliteImage(exec, descriptor.checksum, descriptor);
    if (sqliteImage) return sqliteImage;
  }
  try {
    const cache = await openImageCache();
    const response = await cache.match(cacheKey(productId, descriptor.checksum));
    if (!response) return null;
    const blob = await response.blob();
    await validateBlob(blob, descriptor);
    return blob;
  } catch {
    return null;
  }
}

export async function clearStationProductImages(exec: SqlExecutor): Promise<void> {
  await exec.run("UPDATE product_mirror SET image_pointer_checksum = NULL");
  await exec.run("DELETE FROM station_product_images");
  try {
    if (typeof caches !== "undefined") await caches.delete(STATION_PRODUCT_IMAGE_CACHE);
  } catch (error) {
    console.error("station: product image cache clear failed", error);
  }
}

export { cacheKey as stationProductImageCacheKey };

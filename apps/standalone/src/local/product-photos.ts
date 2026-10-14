import { z } from "zod";

import type { ProductPhotoState } from "../host/protocol.js";
import type { LocalExecutor } from "./executor.js";

/**
 * The products' photos on the station (beta 3, owner feedback «нет фото
 * продукции»). The feed's product record names the photo by its checksum
 * (`ref_products.photo_checksum`); the bytes come one product at a time from
 * `GET /v1/device/products/{id}/photo` into `ref_product_photos` (migration
 * `0017`), as base64 text of at most 400 000 characters (a JPEG of at most
 * 300 000 bytes). A pass runs after every successful reference sync and when
 * the link comes back: it fetches the photos whose stored checksum differs
 * from the product's, and drops the ones whose product has none any more. A
 * failed fetch ends the pass and rejects: the floor works on with the photos
 * it has, and the next sync tries again.
 */

/** How many photos a pass fetches at most: the rest wait for the next pass. */
export const PHOTOS_PER_PASS = 25;

/** The products whose photo is missing or differs from the checksum their record names. */
export const WANTED_SQL =
  "SELECT p.id, p.photo_checksum FROM ref_products AS p " +
  "LEFT JOIN ref_product_photos AS ph ON ph.product_id = p.id " +
  "WHERE p.photo_checksum IS NOT NULL AND (ph.checksum IS NULL OR ph.checksum <> p.photo_checksum) " +
  "ORDER BY p.id LIMIT ?";

/** Photos of products that have none any more (or are gone): deleted. */
export const DROP_STALE_SQL =
  "DELETE FROM ref_product_photos WHERE product_id NOT IN " +
  "(SELECT id FROM ref_products WHERE photo_checksum IS NOT NULL)";

const SAVE_SQL =
  "INSERT INTO ref_product_photos (product_id, checksum, width, height, data_base64) " +
  "VALUES (?, ?, ?, ?, ?) ON CONFLICT (product_id) DO UPDATE SET checksum = excluded.checksum, " +
  "width = excluded.width, height = excluded.height, data_base64 = excluded.data_base64";

const wantedRow = z.object({ id: z.string(), photo_checksum: z.string() });

export interface PhotoSyncOptions {
  local: LocalExecutor;
  /** `HostApi.getDeviceProductPhoto`. */
  fetchPhoto: (productId: string) => Promise<ProductPhotoState>;
}

/** What a pass did: the photos stored and the ones it dropped. */
export interface PhotoSyncResult {
  stored: number;
  dropped: number;
}

const listeners = new Set<() => void>();

/** Calls `listener` whenever a pass changed what the station holds. */
export function onProductPhotosChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Announces a change of the stored photos (the sync pass does; tests may too). */
export function announceProductPhotosChanged(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * One pass. Photos arrive newest-checksum-wins: what is stored carries the
 * checksum the host answered with, which may be newer than the record's (the
 * next feed record then matches it, and nothing is fetched twice).
 */
export async function syncProductPhotos({
  local,
  fetchPhoto,
}: PhotoSyncOptions): Promise<PhotoSyncResult> {
  const [dropped] = await local.transaction([{ sql: DROP_STALE_SQL }]);
  const wanted = await local.query(WANTED_SQL, [PHOTOS_PER_PASS], wantedRow);
  let stored = 0;
  try {
    for (const product of wanted) {
      const { photo } = await fetchPhoto(product.id);
      // Cleared since the record: the feed's next record says so.
      if (photo === null) continue;
      await local.transaction([
        {
          sql: SAVE_SQL,
          values: [product.id, photo.checksum, photo.width, photo.height, photo.dataBase64],
          expectedChanges: 1,
        },
      ]);
      stored += 1;
    }
  } finally {
    if (stored > 0 || (dropped ?? 0) > 0) announceProductPhotosChanged();
  }
  return { stored, dropped: dropped ?? 0 };
}

export interface StoredPhoto {
  /** A `data:` URL the page can show; the stored bytes are only ever JPEG. */
  src: string;
  checksum: string;
}

const photoRow = z.object({ checksum: z.string(), data_base64: z.string() });

/** The stored photo of `productId` as a `data:` URL, or `null` when the station holds none. */
export async function readProductPhoto(
  local: LocalExecutor,
  productId: string,
): Promise<StoredPhoto | null> {
  const [row] = await local.query(
    "SELECT checksum, data_base64 FROM ref_product_photos WHERE product_id = ?",
    [productId],
    photoRow,
  );
  if (row === undefined) return null;
  return { src: `data:image/jpeg;base64,${row.data_base64}`, checksum: row.checksum };
}

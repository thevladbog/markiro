import {
  STORE_PRODUCT_IMAGE_BLOBS,
  STORE_PRODUCT_IMAGE_POINTERS,
  withStore,
} from "./db.js";

interface ProductImagePointer {
  productId: string;
  checksum: string;
}

async function readPointer(productId: string): Promise<ProductImagePointer | null> {
  const pointer = await withStore<ProductImagePointer>(
    STORE_PRODUCT_IMAGE_POINTERS,
    "readonly",
    (store) => store.get(productId),
  );
  return pointer ?? null;
}

async function readBlob(checksum: string): Promise<Blob | null> {
  const blob = await withStore<Blob>(STORE_PRODUCT_IMAGE_BLOBS, "readonly", (store) =>
    store.get(checksum),
  );
  return blob ?? null;
}

export async function readProductImageBlob(checksum: string): Promise<Blob | null> {
  return readBlob(checksum);
}

export async function readPublishedProductImage(productId: string): Promise<Blob | null> {
  const pointer = await readPointer(productId);
  return pointer ? readBlob(pointer.checksum) : null;
}

export async function readPublishedProductImagePointer(
  productId: string,
): Promise<ProductImagePointer | null> {
  return readPointer(productId);
}

export async function hasProductImageBlob(checksum: string): Promise<boolean> {
  return (await readBlob(checksum)) !== null;
}

export async function deleteProductImageBlob(checksum: string): Promise<void> {
  await withStore(STORE_PRODUCT_IMAGE_BLOBS, "readwrite", (store) => store.delete(checksum));
}

/** Blob-first, pointer-second publication. A failed pointer write never loses the old pointer. */
export async function publishProductImage(productId: string, checksum: string, blob: Blob): Promise<void> {
  await withStore(STORE_PRODUCT_IMAGE_BLOBS, "readwrite", (store) => store.put(blob, checksum));
  await withStore(STORE_PRODUCT_IMAGE_POINTERS, "readwrite", (store) =>
    store.put({ productId, checksum } satisfies ProductImagePointer, productId),
  );
}

export async function clearPublishedProductImage(productId: string): Promise<void> {
  await withStore(STORE_PRODUCT_IMAGE_POINTERS, "readwrite", (store) => store.delete(productId));
}

export async function clearProductImages(): Promise<void> {
  await withStore(STORE_PRODUCT_IMAGE_POINTERS, "readwrite", (store) => store.clear());
  await withStore(STORE_PRODUCT_IMAGE_BLOBS, "readwrite", (store) => store.clear());
}

/** Remove pointers outside the current allowlist, then delete blobs no pointer references. */
export async function pruneProductImages(allowedProductIds: ReadonlySet<string>): Promise<void> {
  const pointers = await withStore<ProductImagePointer[]>(
    STORE_PRODUCT_IMAGE_POINTERS,
    "readonly",
    (store) => store.getAll(),
  );
  const retained = new Set<string>();
  for (const pointer of pointers ?? []) {
    if (allowedProductIds.has(pointer.productId)) retained.add(pointer.checksum);
    else await clearPublishedProductImage(pointer.productId);
  }
  const checksums = await withStore<IDBValidKey[]>(
    STORE_PRODUCT_IMAGE_BLOBS,
    "readonly",
    (store) => store.getAllKeys(),
  );
  for (const checksum of checksums ?? []) {
    if (typeof checksum === "string" && !retained.has(checksum)) {
      await withStore(STORE_PRODUCT_IMAGE_BLOBS, "readwrite", (store) => store.delete(checksum));
    }
  }
}

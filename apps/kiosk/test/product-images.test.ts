import { describe, expect, it, vi } from "vitest";
import type { ProductImageDescriptor } from "../src/api/types.js";
import { syncProductImages } from "../src/sync/product-images.js";
import {
  clearProductImages,
  publishProductImage,
  readPublishedProductImage,
  readPublishedProductImagePointer,
} from "../src/store/product-images.js";

const descriptor = (bytes: Uint8Array): ProductImageDescriptor => ({
  checksum: "a".repeat(64),
  contentType: "image/webp",
  byteSize: bytes.byteLength,
  width: 10,
  height: 10,
});

const product = (image?: ProductImageDescriptor | null) => ({
  id: "p1",
  gtin14: "00000000000001",
  name: "Товар",
  unitPrice: null,
  egaisCode: null,
  ...(image === undefined ? {} : { image }),
});

describe("product image sync", () => {
  it("validates bytes and publishes blob before pointer", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const image = {
      ...descriptor(bytes),
      checksum: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    };
    const download = vi.fn(async () => new Blob([bytes], { type: "image/webp" }));
    await expect(
      syncProductImages({ downloadProductImage: download }, [product(image)]),
    ).resolves.toMatchObject({ downloaded: 1 });
    expect(await readPublishedProductImagePointer("p1")).toMatchObject({
      checksum: image.checksum,
    });
    expect((await readPublishedProductImage("p1"))?.size).toBe(3);
  });

  it("retains the old pointer when a replacement fails validation", async () => {
    const bytes = new Uint8Array([1]);
    const old = { ...descriptor(bytes), checksum: "b".repeat(64) };
    const good = new Blob([bytes], { type: "image/webp" });
    // Seed a valid old record through the first sync.
    const oldHash = await crypto.subtle.digest("SHA-256", bytes);
    const oldDescriptor = {
      ...old,
      checksum: [...new Uint8Array(oldHash)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    };
    await syncProductImages({ downloadProductImage: async () => good }, [product(oldDescriptor)]);
    const bad = { ...oldDescriptor, checksum: "c".repeat(64) };
    await syncProductImages(
      { downloadProductImage: async () => new Blob([bytes], { type: "image/webp" }) },
      [product(bad)],
    );
    expect(await readPublishedProductImagePointer("p1")).toMatchObject({
      checksum: oldDescriptor.checksum,
    });
  });

  it("treats undefined as legacy retention and null as deletion", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const oldImage = {
      ...descriptor(bytes),
      checksum: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    };
    await syncProductImages(
      { downloadProductImage: async () => new Blob([bytes], { type: "image/webp" }) },
      [product(oldImage)],
    );
    const before = await readPublishedProductImagePointer("p1");

    // A pre-image server response omits the field entirely. It must not erase
    // the pointer already published by a newer response, or an old kiosk
    // would lose its offline picture when it refreshes the catalog.
    await syncProductImages(
      { downloadProductImage: async () => new Blob(["unused"], { type: "image/webp" }) },
      [product()],
    );
    expect(await readPublishedProductImagePointer("p1")).toEqual(before);

    await syncProductImages(
      { downloadProductImage: async () => new Blob(["x"], { type: "image/webp" }) },
      [product(null)],
    );
    expect(await readPublishedProductImagePointer("p1")).toBeNull();
    await clearProductImages();
  });

  it("does not trust a cached blob whose checksum no longer matches", async () => {
    const replacement = new Uint8Array([4, 5, 6]);
    const hash = await crypto.subtle.digest("SHA-256", replacement);
    const replacementImage = {
      ...descriptor(replacement),
      checksum: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    };
    await publishProductImage(
      "p1",
      replacementImage.checksum,
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }),
    );
    const download = vi.fn(async () => new Blob([replacement], { type: "image/webp" }));
    await syncProductImages({ downloadProductImage: download }, [product(replacementImage)]);
    expect(download).toHaveBeenCalledOnce();
  });
});

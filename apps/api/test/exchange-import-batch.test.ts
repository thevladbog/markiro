import { describe, expect, it } from "vitest";
import {
  IMPORT_BATCH_SIZE,
  IMPORT_IMAGE_BATCH_SIZE,
  importBatchEnd,
  type ImportWorkItem,
} from "../src/modules/exchange/exchange.controller";

/**
 * `importBatchEnd` is pure -- no DB, no session -- so these synthetic
 * worklists exercise its two caps directly: the overall `IMPORT_BATCH_SIZE`
 * ceiling (review Important 2) and the tighter `IMPORT_IMAGE_BATCH_SIZE`
 * sub-ceiling on how many `kind: "image"` rows one round may process (each
 * one is a download/sharp/S3 round trip, not a cheap `UPDATE`).
 */
function priceItem(id: string): ImportWorkItem {
  return { kind: "price", productId: id, unitPrice: "1.00" };
}

function imageItem(id: string): ImportWorkItem {
  return { kind: "image", productId: id, source: `import_files/${id}.png` };
}

describe("importBatchEnd", () => {
  it("caps an all-cheap worklist at IMPORT_BATCH_SIZE", () => {
    const worklist = Array.from({ length: 600 }, (_, i) => priceItem(`p${i}`));
    expect(importBatchEnd(worklist, 0)).toBe(IMPORT_BATCH_SIZE);
    expect(IMPORT_BATCH_SIZE).toBe(500);
  });

  it("stops at the image sub-cap well before IMPORT_BATCH_SIZE when images sit at the tail", () => {
    const cheap = Array.from({ length: 100 }, (_, i) => priceItem(`p${i}`));
    const images = Array.from({ length: 50 }, (_, i) => imageItem(`img${i}`));
    const worklist = [...cheap, ...images];
    // 100 cheap rows are free; only the first IMPORT_IMAGE_BATCH_SIZE images
    // after them fit in this round, even though the total (150) is nowhere
    // near IMPORT_BATCH_SIZE (500).
    expect(importBatchEnd(worklist, 0)).toBe(100 + IMPORT_IMAGE_BATCH_SIZE);
    expect(IMPORT_IMAGE_BATCH_SIZE).toBe(25);
  });

  it("resumes correctly when offset itself lands mid-image-section", () => {
    const worklist = Array.from({ length: 40 }, (_, i) => imageItem(`img${i}`));
    // A prior round already applied images[0..9] and wrote a cursor at
    // offset 10. This round must count ITS OWN 25-image budget starting
    // fresh from that offset, not from the worklist's start.
    const end = importBatchEnd(worklist, 10);
    expect(end).toBe(10 + IMPORT_IMAGE_BATCH_SIZE);
    expect(end).toBeLessThan(worklist.length);
  });

  it("never returns an end past the worklist's own length", () => {
    const worklist = [priceItem("only-one")];
    expect(importBatchEnd(worklist, 0)).toBe(1);
    expect(importBatchEnd(worklist, 1)).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_BOX_CLOSURES_PER_SYNC_BATCH,
  MAX_PALLET_CLOSURES_PER_SYNC_BATCH,
} from "../src/index.js";

/**
 * These numbers are a CONTRACT between the API's request schema and both
 * devices' drain loops. If the two sides disagree, the oversized payload is
 * rejected with a 400 and retried forever, wedging pallets, boxes and items
 * together on that device — so they live in one place and are pinned here.
 */
describe("sync batch limits", () => {
  it("caps pallet closures below box closures", () => {
    expect(MAX_PALLET_CLOSURES_PER_SYNC_BATCH).toBe(20);
    // A pallet closes once per palletBoxCapacity boxes, so a batch that
    // carries 50 box closures cannot physically carry more than a handful.
    expect(MAX_PALLET_CLOSURES_PER_SYNC_BATCH).toBeLessThan(MAX_BOX_CLOSURES_PER_SYNC_BATCH);
  });

  it("keeps both limits positive integers", () => {
    for (const limit of [MAX_BOX_CLOSURES_PER_SYNC_BATCH, MAX_PALLET_CLOSURES_PER_SYNC_BATCH]) {
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }
  });
});

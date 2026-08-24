import { describe, expect, it } from "vitest";

import {
  canDisposeChzCode,
  INVENTORY_CHZ_STATUSES,
  type InventoryChzStatus,
} from "../src/index.js";

describe("inventory Chestny ZNAK status disposition", () => {
  it("keeps the six imported statuses in the public disposition contract", () => {
    expect(INVENTORY_CHZ_STATUSES).toEqual([
      "EMITTED",
      "INTRODUCED",
      "APPLIED",
      "RETIRED",
      "WRITTEN_OFF",
      "DISAGGREGATION",
    ]);
  });

  it.each([
    ["EMITTED", false],
    ["INTRODUCED", true],
    ["APPLIED", false],
    ["RETIRED", false],
    ["WRITTEN_OFF", false],
    ["DISAGGREGATION", false],
  ] as const satisfies readonly (readonly [InventoryChzStatus, boolean])[])(
    "makes %s disposable only when it is introduced",
    (status, expected) => {
      expect(canDisposeChzCode({ status, state: null })).toBe(expected);
    },
  );

  it("protects a moving code before status eligibility", () => {
    expect(canDisposeChzCode({ status: "INTRODUCED", state: "MOVING_BY_UD" })).toBe(false);
    expect(canDisposeChzCode({ status: "APPLIED", state: "MOVING_BY_UD" })).toBe(false);
  });
});

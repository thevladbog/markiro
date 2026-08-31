import { describe, expect, it } from "vitest";

import {
  canDisposeChzCode,
  chzFilteredCisReportPolicy,
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

  it.each([25, 42, 44])(
    "rejects product group %s because FILTERED_CIS_REPORT is unavailable",
    (productGroupCode) => {
      expect(chzFilteredCisReportPolicy(productGroupCode)).toEqual({
        supported: false,
        reason: "report_unavailable",
      });
    },
  );

  it.each([3, 12, 16])(
    "rejects tobacco product group %s until its distinct status profile is supported end-to-end",
    (productGroupCode) => {
      expect(chzFilteredCisReportPolicy(productGroupCode)).toEqual({
        supported: false,
        reason: "status_profile_unsupported",
      });
    },
  );

  it("keeps the standard report contract available for other product groups", () => {
    expect(chzFilteredCisReportPolicy(1)).toEqual({
      supported: true,
      statuses: INVENTORY_CHZ_STATUSES,
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  classifyInventorySnapshotRow,
  type InventoryChzStatus,
} from "../src/index.js";

const period = {
  productionDateFrom: "2025-09-01",
  productionDateTo: "2025-09-30",
} as const;

function sourceRow(
  status: InventoryChzStatus,
  sourceProductionDate: string | null,
  options: { state?: "MOVING_BY_UD" | null } = {},
) {
  return {
    gtin14: "04680089900383",
    status,
    state: options.state ?? null,
    sourceProductionDate,
  };
}

describe("inventory snapshot classification", () => {
  it("includes introduced source dates at both inclusive range boundaries", () => {
    expect(classifyInventorySnapshotRow(sourceRow("INTRODUCED", "2025-09-01"), period)).toEqual({
      kind: "expected",
      expected: true,
      protected: false,
    });
    expect(classifyInventorySnapshotRow(sourceRow("INTRODUCED", "2025-09-30"), period)).toEqual({
      kind: "expected",
      expected: true,
      protected: false,
    });
  });

  it("classifies an introduced source date outside the range as known ineligible", () => {
    expect(classifyInventorySnapshotRow(sourceRow("INTRODUCED", "2025-10-01"), period)).toEqual({
      kind: "known_ineligible",
      expected: false,
      protected: false,
    });
  });

  it("requires a production date to classify an unprotected introduced row", () => {
    expect(classifyInventorySnapshotRow(sourceRow("INTRODUCED", null), period)).toEqual({
      kind: "invalid_missing_production_date",
      expected: false,
      protected: false,
    });
  });

  it("protects a moving row before considering date-range eligibility", () => {
    expect(
      classifyInventorySnapshotRow(
        sourceRow("INTRODUCED", null, { state: "MOVING_BY_UD" }),
        period,
      ),
    ).toEqual({
      kind: "protected",
      expected: false,
      protected: true,
    });
  });

  it.each([
    "EMITTED",
    "APPLIED",
    "RETIRED",
    "WRITTEN_OFF",
    "DISAGGREGATION",
  ] as const satisfies readonly InventoryChzStatus[])(
    "keeps %s rows visible but outside expected stock",
    (status) => {
      expect(classifyInventorySnapshotRow(sourceRow(status, null), period)).toEqual({
        kind: "known_ineligible",
        expected: false,
        protected: false,
      });
    },
  );
});

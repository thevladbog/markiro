import { describe, expect, it } from "vitest";

import * as domain from "../src/index.js";

describe("traceability calendar retention", () => {
  it.each([
    ["2023-03-01", 2, "2025-03-01"],
    ["2024-02-29", 2, "2026-03-01"],
    ["2024-02-29", 4, "2028-02-29"],
    ["2024-01-31", 2, "2026-01-31"],
    ["2096-02-29", 4, "2100-03-01"],
    ["0001-01-01", 2, "0003-01-01"],
    ["9997-12-31", 2, "9999-12-31"],
  ])("retains %s for %i calendar years through %s", (date, years, expected) => {
    expect(
      domain.traceabilityRetention({
        recordClass: "record",
        createdOrObtainedOn: date,
        retentionYears: years,
      }),
    ).toEqual({ retainThrough: expected, indefiniteReason: null });
  });

  it("preserves the five-year default rather than substituting the regulatory floor", () => {
    expect(
      domain.traceabilityRetention({ recordClass: "record", createdOrObtainedOn: "2024-02-29" }),
    ).toEqual({ retainThrough: "2029-03-01", indefiniteReason: null });
  });

  it("anchors a superseded plan to its replacement, not its original creation", () => {
    expect(
      domain.traceabilityRetention({
        recordClass: "plan",
        createdOrObtainedOn: "2020-01-01",
        supersededOn: "2026-09-05",
        retentionYears: 2,
      }),
    ).toEqual({ retainThrough: "2028-09-05", indefiniteReason: null });
  });

  it("keeps an effective plan indefinitely", () => {
    expect(
      domain.traceabilityRetention({ recordClass: "plan", createdOrObtainedOn: "2020-01-01" }),
    ).toEqual({ retainThrough: null, indefiniteReason: "effective_plan" });
  });

  it.each([
    ["2035-01-01", "2030-01-01", "2035-01-01"],
    ["2026-01-01", "2036-01-01", "2036-01-01"],
    ["2026-01-01", "2027-01-01", "2029-01-01"],
  ])(
    "applies the latest hold, persisted boundary and policy (%s / %s)",
    (holdUntil, previousRetainThrough, expected) => {
      expect(
        domain.traceabilityRetention({
          recordClass: "record",
          createdOrObtainedOn: "2024-01-01",
          holdUntil,
          previousRetainThrough,
        }),
      ).toEqual({ retainThrough: expected, indefiniteReason: null });
    },
  );

  it("an indefinite hold cannot be shortened by a dated hold", () => {
    expect(
      domain.traceabilityRetention({
        recordClass: "record",
        createdOrObtainedOn: "2024-01-01",
        indefiniteHold: true,
        holdUntil: "2025-01-01",
      }),
    ).toEqual({ retainThrough: null, indefiniteReason: "hold" });
  });

  it.each([
    "2023-02-29",
    "2024-02-30",
    "2024-13-01",
    "2024-00-01",
    "2024-01-00",
    "0000-01-01",
    "2024-1-01",
    "2024-01-01T00:00:00Z",
    " 2024-01-01",
  ])("rejects invalid civil date %s", (date) => {
    expect(() =>
      domain.traceabilityRetention({ recordClass: "record", createdOrObtainedOn: date }),
    ).toThrowError(expect.objectContaining({ code: "invalid_retention_date" }));
  });

  it.each([1, 0, -2, 2.5, NaN, Infinity, 2147483648])(
    "rejects invalid retention years %s",
    (retentionYears) => {
      expect(() =>
        domain.traceabilityRetention({
          recordClass: "record",
          createdOrObtainedOn: "2024-01-01",
          retentionYears,
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_retention_years" }));
    },
  );

  it.each(["holdUntil", "previousRetainThrough"] as const)(
    "validates %s even while an indefinite hold is active",
    (field) => {
      expect(() =>
        domain.traceabilityRetention({
          recordClass: "record",
          createdOrObtainedOn: "2024-01-01",
          indefiniteHold: true,
          [field]: "bad",
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_retention_date" }));
    },
  );

  it("rejects a plan supersession earlier than its creation", () => {
    expect(() =>
      domain.traceabilityRetention({
        recordClass: "plan",
        createdOrObtainedOn: "2024-01-01",
        supersededOn: "2023-12-31",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_retention_anchor" }));
  });

  it.each([9999, 2147483647])(
    "retains indefinitely when %i years exceed the supported date range",
    (retentionYears) => {
      expect(
        domain.traceabilityRetention({
          recordClass: "record",
          createdOrObtainedOn: "2024-01-01",
          retentionYears,
        }),
      ).toEqual({ retainThrough: null, indefiniteReason: "date_range_exceeded" });
    },
  );

  it("retains indefinitely when even the two-year minimum crosses year 9999", () => {
    expect(
      domain.traceabilityRetention({
        recordClass: "record",
        createdOrObtainedOn: "9998-12-31",
        retentionYears: 2,
      }),
    ).toEqual({ retainThrough: null, indefiniteReason: "date_range_exceeded" });
  });
});

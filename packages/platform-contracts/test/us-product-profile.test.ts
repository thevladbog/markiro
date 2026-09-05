import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const input = {
  productName: "Apple Cups",
  brandName: null,
  commodity: "Apples",
  variety: null,
  packagingSizeValue: "6.000",
  packagingSizeUom: "oz",
  packagingStyle: "cup",
  defaultQuantityUom: "case",
  coverageStatus: "unknown",
  coverageRationale: null,
  ftlCategory: null,
  ftlSourceUrl: null,
  ftlSourceVersion: null,
};
const reviewedInput = {
  ...input,
  coverageStatus: "covered",
  coverageRationale: "Manual synthetic review",
  ftlCategory: "Fruits (fresh-cut)",
  ftlSourceUrl:
    "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
  ftlSourceVersion: "US-REG-2026-09-03",
};
const record = {
  ...reviewedInput,
  productId: "a0000000-0000-4000-8000-000000000001",
  revision: 1,
  reviewedBy: "synthetic-qa",
  reviewedAt: "2026-09-05T12:00:00.000Z",
  createdAt: "2026-09-05T12:00:00.000Z",
  updatedAt: "2026-09-05T12:00:00.000Z",
};
const snapshot = {
  snapshotVersion: 1,
  sourceProductId: record.productId,
  productName: "Apple Cups",
  brandName: null,
  commodity: "Apples",
  variety: null,
  packagingSize: { value: "6.000", uom: "oz" },
  packagingStyle: "cup",
  gtin: null,
};

describe("US product profile mutation boundary", () => {
  it("requires a non-coerced bounded expected revision only on the PUT transport", () => {
    expect(
      contracts.putProductTraceabilityProfileSchema.parse({ ...input, expectedRevision: 0 }),
    ).toEqual({ ...input, expectedRevision: 0 });
    for (const expectedRevision of [undefined, null, "0", -1, 1.5, 2147483647]) {
      expect(
        contracts.putProductTraceabilityProfileSchema.safeParse({ ...input, expectedRevision })
          .success,
      ).toBe(false);
    }
    expect(
      contracts.putProductTraceabilityProfileSchema.safeParse({
        ...input,
        expectedRevision: 1,
        reviewedBy: "forged",
      }).success,
    ).toBe(false);
    expect(
      contracts.upsertProductTraceabilityProfileSchema.safeParse({ ...input, expectedRevision: 0 })
        .success,
    ).toBe(false);
  });
  it("accepts a full unknown draft without inventing optional metadata", () => {
    expect(contracts.upsertProductTraceabilityProfileSchema.parse(input)).toEqual(input);
    expect(contracts.upsertProductTraceabilityProfileSchema.parse(reviewedInput)).toEqual(
      reviewedInput,
    );
  });
  it("trims editable descriptions but never coerces exact package decimals", () => {
    const parsed = contracts.upsertProductTraceabilityProfileSchema.parse({
      ...input,
      productName: " Apple Cups ",
    });
    expect(parsed.productName).toBe("Apple Cups");
    expect(parsed.packagingSizeValue).toBe("6.000");
  });
  it.each([
    "tenantId",
    "profileCode",
    "reviewedBy",
    "reviewedAt",
    "productId",
    "createdAt",
    "updatedAt",
    "chzProductGroupCode",
    "reviewDueAt",
    "evidenceUrl",
  ])("rejects injected server-owned or unsupported field %s", (field) => {
    expect(
      contracts.upsertProductTraceabilityProfileSchema.safeParse({ ...input, [field]: "injected" })
        .success,
    ).toBe(false);
  });
  it.each(Object.keys(input))(
    "requires full PUT field %s, including nullable components",
    (field) => {
      const partial = Object.fromEntries(Object.entries(input).filter(([key]) => key !== field));
      expect(contracts.upsertProductTraceabilityProfileSchema.safeParse(partial).success).toBe(
        false,
      );
    },
  );
  it.each([
    { coverageStatus: "compliant" },
    { coverageRationale: null },
    { ftlCategory: null },
    { ftlSourceUrl: "javascript:alert(1)" },
    { ftlSourceVersion: null },
    { packagingSizeValue: 6 },
    { packagingSizeValue: "0" },
    { packagingSizeValue: "6.0001" },
    { packagingSizeUom: null },
    { packagingSizeValue: null },
    { defaultQuantityUom: "pounds" },
    { brandName: " " },
    { productName: "a".repeat(201) },
    { coverageRationale: "a".repeat(2001) },
  ])("rejects invalid editable document %j", (patch) => {
    expect(
      contracts.upsertProductTraceabilityProfileSchema.safeParse({ ...reviewedInput, ...patch })
        .success,
    ).toBe(false);
  });
});

describe("US persisted profile and snapshot boundaries", () => {
  it("distinguishes unsaved defaults from a persisted reviewed profile", () => {
    expect(contracts.productTraceabilityProfileSchema.parse(record)).toEqual(record);
    const defaults = {
      ...input,
      productId: record.productId,
      revision: 0,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: null,
      updatedAt: null,
    };
    expect(contracts.productTraceabilityProfileSchema.parse(defaults)).toEqual(defaults);
  });
  it.each([
    { productId: "not-a-uuid" },
    { revision: 0 },
    { revision: -1 },
    { revision: 1.5 },
    { revision: 2147483648 },
    { revision: undefined },
    { reviewedBy: null },
    { reviewedBy: " " },
    { reviewedAt: null },
    { reviewedAt: "2026-02-30T12:00:00Z" },
    { createdAt: null },
    { createdAt: null, updatedAt: null },
    { updatedAt: null },
  ])("rejects corrupt persisted review provenance %j", (patch) => {
    expect(
      contracts.productTraceabilityProfileSchema.safeParse({ ...record, ...patch }).success,
    ).toBe(false);
  });
  it("rejects a positive revision on unsaved defaults", () => {
    expect(
      contracts.productTraceabilityProfileSchema.safeParse({
        ...record,
        ...input,
        revision: 1,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: null,
        updatedAt: null,
      }).success,
    ).toBe(false);
  });
  it("requires paired metadata even when a previous decision was reset to unknown", () => {
    expect(
      contracts.productTraceabilityProfileSchema.safeParse({
        ...record,
        ...input,
        reviewedAt: null,
      }).success,
    ).toBe(false);
  });
  it("accepts a GTIN-less pinned description and preserves its exact stored text/quantity", () => {
    const pinned = { ...snapshot, productName: " Apple Cups " };
    expect(contracts.productDescriptionSnapshotSchema.parse(pinned)).toEqual(pinned);
    expect(
      contracts.productDescriptionSnapshotSchema.parse({ ...snapshot, gtin: "04006381333931" })
        .gtin,
    ).toBe("04006381333931");
    expect(
      contracts.productDescriptionSnapshotSchema.parse({ ...snapshot, packagingSize: null })
        .packagingSize,
    ).toBeNull();
  });
  it.each([
    { snapshotVersion: 2 },
    { sourceProductId: "wrong" },
    { gtin: "4006381333931" },
    { gtin: "04006381333932" },
    { packagingSize: { value: 6, uom: "oz" } },
    { packagingSize: { value: "6", uom: "pounds" } },
    { packagingSize: { value: "0", uom: "oz" } },
    { packagingSize: { value: "6", uom: "oz", convertedValue: "0.375" } },
    { coverageStatus: "covered" },
    { productName: " " },
  ])("rejects invalid or inflated pinned snapshot %j", (patch) => {
    expect(
      contracts.productDescriptionSnapshotSchema.safeParse({ ...snapshot, ...patch }).success,
    ).toBe(false);
  });
});

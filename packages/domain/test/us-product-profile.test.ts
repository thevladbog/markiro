import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";
import type { CoverageReviewInput, ProductDescriptionInput } from "../src/index.js";

const processor = "US_FSMA204_PROCESSOR";
const generic = "US_GENERIC_LOT_TRACEABILITY";
const description: ProductDescriptionInput = {
  productName: "Fresh-Cut Apple Cups",
  brandName: null,
  commodity: "Apples",
  variety: null,
  packagingSizeValue: "6.000",
  packagingSizeUom: "oz",
  packagingStyle: "cup",
  defaultQuantityUom: "case",
};
const emptyReview: CoverageReviewInput = {
  coverageStatus: "unknown",
  coverageRationale: null,
  ftlCategory: null,
  ftlSourceUrl: null,
  ftlSourceVersion: null,
};
const review: CoverageReviewInput = {
  coverageStatus: "covered",
  coverageRationale: "Manual synthetic review",
  ftlCategory: "Fruits (fresh-cut)",
  ftlSourceUrl:
    "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
  ftlSourceVersion: "US-REG-2026-09-03",
};
const metadata = { reviewedBy: "synthetic-qa", reviewedAt: "2026-09-05T12:00:00.000Z" };

describe("product description and snapshot rules", () => {
  it("keeps a GTIN-less product snapshot independent from later catalog/profile edits", () => {
    const input = { ...description, productName: " Fresh-Cut Apple Cups " };
    const product = { id: "a0000000-0000-4000-8000-000000000001", gtin14: null };
    const result = domain.buildProductSnapshot(product, input);
    expect(result).toEqual({
      ok: true,
      snapshot: {
        snapshotVersion: 1,
        sourceProductId: product.id,
        productName: "Fresh-Cut Apple Cups",
        brandName: null,
        commodity: "Apples",
        variety: null,
        packagingSize: { value: "6.000", uom: "oz" },
        packagingStyle: "cup",
        gtin: null,
      },
    });
    input.productName = "Changed";
    input.packagingSizeValue = "12";
    product.id = "changed";
    if (!result.ok) throw new Error("Expected valid snapshot");
    expect(result.snapshot.productName).toBe("Fresh-Cut Apple Cups");
    expect(result.snapshot.sourceProductId).toBe("a0000000-0000-4000-8000-000000000001");
    expect(result.snapshot.packagingSize).toEqual({ value: "6.000", uom: "oz" });
    expect(result.snapshot).not.toHaveProperty("defaultQuantityUom");
    expect(result.snapshot).not.toHaveProperty("coverageStatus");
  });

  it.each(["0", "0.000", "-1", "1e3", "1,000", "1.0001", "1000000000", "01", "1."])(
    "rejects invalid or lossy package quantity %s",
    (packagingSizeValue) => {
      expect(
        domain.validateProductDescription({ ...description, packagingSizeValue }),
      ).toContainEqual({ field: "packagingSizeValue", code: "format" });
    },
  );
  it.each(["0.001", "999999999.999", "1", "50.000"])("preserves exact quantity %s", (value) => {
    const result = domain.buildProductSnapshot(
      { id: "product", gtin14: null },
      { ...description, packagingSizeValue: value },
    );
    expect(result.ok && result.snapshot.packagingSize?.value).toBe(value);
  });
  it.each(["lb", "oz", "kg", "g", "each", "case", "bag", "cup", "gal", "l"])(
    "accepts explicit supported unit %s without conversion",
    (unit) => {
      expect(
        domain.validateProductDescription({
          ...description,
          packagingSizeUom: unit,
          defaultQuantityUom: unit,
        }),
      ).toEqual([]);
    },
  );
  it.each([
    { packagingSizeValue: null, packagingSizeUom: "oz" },
    { packagingSizeValue: "6", packagingSizeUom: null },
    { packagingSizeValue: "6", packagingSizeUom: "pound" },
    { defaultQuantityUom: "CASE" },
    { brandName: " " },
    { productName: " " },
    { productName: "a".repeat(201) },
  ])("rejects incomplete or invalid description %j", (patch) => {
    const input = { ...description, ...patch };
    expect(domain.validateProductDescription(input).length).toBeGreaterThan(0);
    expect(domain.buildProductSnapshot({ id: "product", gtin14: null }, input).ok).toBe(false);
  });
  it("permits absent optional description components without invented defaults", () => {
    const result = domain.buildProductSnapshot(
      { id: "product", gtin14: "04006381333931" },
      {
        ...description,
        packagingSizeValue: null,
        packagingSizeUom: null,
        defaultQuantityUom: null,
      },
    );
    expect(result.ok && result.snapshot.packagingSize).toBeNull();
    expect(result.ok && result.snapshot.gtin).toBe("04006381333931");
  });
  it.each(["4006381333931", "04006381333932", "fake"])(
    "rejects noncanonical/corrupt stored GTIN %s",
    (gtin14) => {
      expect(domain.buildProductSnapshot({ id: "product", gtin14 }, description)).toEqual({
        ok: false,
        issues: [{ field: "gtin", code: "format" }],
      });
    },
  );
});

describe("manual coverage review policy", () => {
  it.each([
    ["covered", "reviewed"],
    ["contains_ftl_same_form", "reviewed"],
    ["not_covered", "reviewed"],
    ["unknown", "blocked"],
    ["exemption_review_required", "blocked"],
  ] as const)("assesses %s as %s, not as package readiness", (coverageStatus, state) => {
    const result = domain.assessCoverageReview(
      { ...review, ...metadata, coverageStatus },
      processor,
    );
    expect(result.state).toBe(state);
    expect(result).not.toHaveProperty("exportReady");
  });
  it("allows an unknown draft but keeps the coverage prerequisite blocked", () => {
    expect(domain.validateCoverageReview(emptyReview, processor)).toEqual([]);
    expect(
      domain.assessCoverageReview(
        { ...emptyReview, reviewedBy: null, reviewedAt: null },
        processor,
      ),
    ).toEqual({ state: "blocked", issues: [{ field: "coverageStatus", code: "unresolved" }] });
  });
  it.each(["coverageRationale", "ftlCategory", "ftlSourceUrl", "ftlSourceVersion"] as const)(
    "requires %s for a positive FTL review",
    (field) => {
      expect(domain.validateCoverageReview({ ...review, [field]: null }, processor)).toContainEqual(
        { field, code: "required" },
      );
      expect(
        domain.assessCoverageReview({ ...review, ...metadata, [field]: null }, processor).state,
      ).toBe("blocked");
    },
  );
  it.each(["not_covered", "exemption_review_required"] as const)(
    "requires rationale for %s",
    (coverageStatus) => {
      expect(
        domain.validateCoverageReview({ ...emptyReview, coverageStatus }, processor),
      ).toContainEqual({ field: "coverageRationale", code: "required" });
    },
  );
  it.each([
    "javascript:alert(1)",
    "file:///tmp/source",
    "https://user:pass@example.com",
    "https://exa\nmple.com",
    "not a URL",
    "https://xn--/source",
    "https://xn--a.example/source",
    "https://xn--.test/source",
    "https://\u200d.test/source",
    "https://a\u200cb.test/source",
  ])("rejects unsafe/invalid source %s without fetching it", (ftlSourceUrl) => {
    expect(domain.validateCoverageReview({ ...review, ftlSourceUrl }, processor)).toContainEqual({
      field: "ftlSourceUrl",
      code: "format",
    });
  });
  it.each([
    { reviewedBy: null },
    { reviewedAt: null },
    { reviewedBy: " " },
    { reviewedAt: "2026-02-30T12:00:00Z" },
    { reviewedAt: "2026-09-05" },
  ])("never treats missing/corrupt server review metadata as reviewed: %j", (patch) => {
    expect(domain.assessCoverageReview({ ...review, ...metadata, ...patch }, processor).state).toBe(
      "blocked",
    );
  });
  it("never infers applicability in the generic profile", () => {
    expect(domain.validateCoverageReview(emptyReview, generic)).toEqual([]);
    expect(
      domain.assessCoverageReview({ ...emptyReview, reviewedBy: null, reviewedAt: null }, generic),
    ).toEqual({ state: "not_assessed", issues: [] });
    expect(domain.validateCoverageReview(review, generic).length).toBeGreaterThan(0);
    expect(domain.assessCoverageReview({ ...review, ...metadata }, generic).state).toBe(
      "not_assessed",
    );
  });
  it.each(["RU_CHZ", "unknown", null, undefined])(
    "fails closed for profile context %s",
    (profile) => {
      expect(() => domain.validateCoverageReview(review, profile)).toThrow(domain.DomainError);
      expect(() => domain.assessCoverageReview({ ...review, ...metadata }, profile)).toThrow(
        domain.DomainError,
      );
    },
  );
});

import { describe, expect, it } from "vitest";
import { assessTransformationReadiness, type TransformationReadinessInput } from "../src/index.js";

const draft: TransformationReadinessInput["draft"] = {
  eventDate: "2026-09-26",
  processorLocationId: "processor",
  reason: "processing",
  reasonNote: null,
  notes: null,
  inputs: [
    { kind: "ftl_lot", lotId: "lot-1", quantity: "500", unitOfMeasure: "lb" },
    { kind: "ftl_lot", lotId: "lot-2", quantity: "500", unitOfMeasure: "lb" },
  ],
  outputs: [{ productId: "product", tlc: "OUT-1", quantity: "100", unitOfMeasure: "case" }],
  documentIds: ["doc"],
};
const facts: TransformationReadinessInput = {
  profileCode: "US_FSMA204_PROCESSOR",
  draft,
  products: [
    {
      id: "product",
      archived: false,
      descriptionReady: true,
      coverage: {
        coverageStatus: "covered",
        coverageRationale: "FDA list reviewed",
        ftlCategory: "food",
        ftlSourceUrl:
          "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
        ftlSourceVersion: "2026",
        reviewedBy: "qa-user",
        reviewedAt: "2026-09-25T12:00:00Z",
      },
    },
  ],
  locations: [{ id: "processor", roles: ["processor"], archived: false, descriptionReady: true }],
  lots: [
    { id: "lot-1", productId: "product", tlc: "IN-1", sourceResolved: true, currentOrigin: true },
    { id: "lot-2", productId: "product", tlc: "IN-2", sourceResolved: true, currentOrigin: true },
  ],
  documents: [{ id: "doc", archived: false, type: "production_record", number: "PR-1" }],
};

describe("Transformation readiness", () => {
  it("accepts differing input and output units without a balance calculation", () => {
    expect(assessTransformationReadiness(facts)).toEqual([]);
  });
  it("requires event fields, output and one reference document in stable order", () => {
    const issues = assessTransformationReadiness({
      ...facts,
      draft: {
        ...draft,
        eventDate: null,
        processorLocationId: null,
        reason: null,
        outputs: [],
        documentIds: [],
      },
    });
    expect(issues.map(({ group, line, field, code }) => [group, line, field, code])).toEqual([
      ["event", null, "eventDate", "required"],
      ["event", null, "processorLocationId", "required"],
      ["event", null, "reason", "required"],
      ["outputs", null, "outputs", "required"],
      ["documents", null, "documentIds", "required"],
    ]);
  });
  it("blocks unresolved coverage, source, origin and invalid quantities", () => {
    const issues = assessTransformationReadiness({
      ...facts,
      products: [
        {
          ...facts.products[0]!,
          coverage: {
            ...facts.products[0]!.coverage,
            coverageStatus: "unknown",
            coverageRationale: null,
            reviewedBy: null,
            reviewedAt: null,
          },
        },
      ],
      lots: [{ ...facts.lots[0]!, sourceResolved: false, currentOrigin: false }, facts.lots[1]!],
      draft: {
        ...draft,
        inputs: [
          { kind: "ftl_lot", lotId: "lot-1", quantity: "0", unitOfMeasure: "lb" },
          { kind: "ftl_lot", lotId: "lot-1", quantity: "1.0001", unitOfMeasure: "lb" },
        ],
      },
    });
    expect(issues.map(({ field, code }) => [field, code])).toEqual(
      expect.arrayContaining([
        ["coverage", "coverage_unresolved"],
        ["source", "unresolved"],
        ["origin", "unresolved"],
        ["quantity", "format"],
        ["lotId", "duplicate"],
      ]),
    );
  });
  it("allows documented non-FTL material without inventing a TLC", () => {
    const nonFtlProduct = {
      id: "non-ftl-product",
      archived: false,
      descriptionReady: true,
      coverage: {
        coverageStatus: "not_covered",
        coverageRationale: "Outside reviewed FTL scope",
        ftlCategory: null,
        ftlSourceUrl: null,
        ftlSourceVersion: null,
        reviewedBy: "qa-user",
        reviewedAt: "2026-09-25T12:00:00Z",
      },
    } as const;
    expect(
      assessTransformationReadiness({
        ...facts,
        products: [...facts.products, nonFtlProduct],
        draft: {
          ...draft,
          inputs: [
            {
              kind: "non_ftl",
              productId: "non-ftl-product",
              sourceLocationId: "processor",
              reference: "supplier invoice 12",
              quantity: "500",
              unitOfMeasure: "lb",
            },
          ],
        },
      }),
    ).toEqual([]);
  });
  it("requires reviewed coverage for FTL input lots", () => {
    const issues = assessTransformationReadiness({
      ...facts,
      products: [
        {
          ...facts.products[0]!,
          coverage: { ...facts.products[0]!.coverage, reviewedBy: null, reviewedAt: null },
        },
      ],
      draft: { ...draft, outputs: [] },
    });
    expect(
      issues.some(
        (issue) =>
          issue.group === "inputs" &&
          issue.field === "coverage" &&
          issue.code === "coverage_unresolved",
      ),
    ).toBe(true);
  });
  it.each(["covered", "unknown", "exemption_review_required", "not_covered"] as const)(
    "blocks a non-FTL input with %s coverage unless review is complete and not covered",
    (coverageStatus) => {
      const product = {
        ...facts.products[0]!,
        coverage: {
          ...facts.products[0]!.coverage,
          coverageStatus,
          reviewedBy: coverageStatus === "not_covered" ? null : "qa-user",
          reviewedAt: coverageStatus === "not_covered" ? null : "2026-09-25T12:00:00Z",
        },
      };
      const issues = assessTransformationReadiness({
        ...facts,
        products: [product],
        draft: {
          ...draft,
          inputs: [
            {
              kind: "non_ftl",
              productId: "product",
              sourceLocationId: "processor",
              reference: "invoice 12",
              quantity: "500",
              unitOfMeasure: "lb",
            },
          ],
        },
      });
      expect(issues).toContainEqual({
        severity: "error",
        group: "inputs",
        line: 1,
        field: "coverage",
        code: "coverage_unresolved",
        detail: null,
      });
    },
  );
  it("blocks archived input and output products", () => {
    const issues = assessTransformationReadiness({
      ...facts,
      products: [{ ...facts.products[0]!, archived: true }],
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        {
          severity: "error",
          group: "inputs",
          line: 1,
          field: "productId",
          code: "inactive",
          detail: null,
        },
        {
          severity: "error",
          group: "outputs",
          line: 1,
          field: "productId",
          code: "inactive",
          detail: null,
        },
      ]),
    );
  });
});

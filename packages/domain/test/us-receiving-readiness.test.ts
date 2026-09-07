import { describe, expect, it } from "vitest";
import { assessReceivingReadiness, type ReceivingReadinessInput } from "../src/index.js";

function at<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing fixture row ${index}`);
  return value;
}

function input(): ReceivingReadinessInput {
  const description = {
    businessName: "Synthetic supplier",
    phoneNumber: "+1 509 555 0100",
    addressKind: "street" as const,
    streetAddress: "100 Test Way",
    latitude: null,
    longitude: null,
    city: "Yakima",
    stateOrRegion: "WA",
    zipOrPostalCode: "98901",
    countryCode: "US",
  };
  return {
    profileCode: "US_FSMA204_PROCESSOR",
    draft: {
      dateReceived: "2026-09-07",
      locationId: "dock",
      previousSourceLocationId: "source",
      documentIds: ["bol"],
      items: [
        {
          productId: "apple",
          lotId: null,
          lotLinkMode: "create_on_finalize",
          tlc: "=Case/Ä-001",
          source: { kind: "location", locationId: "source" },
          quantity: "500.000",
          unitOfMeasure: "lb",
          exemptSupplier: false,
          exemptReason: null,
        },
      ],
    },
    products: [
      {
        id: "apple",
        archived: false,
        gtin14: "00000000000000",
        description: {
          productName: "Apple slices",
          brandName: null,
          commodity: null,
          variety: null,
          packagingSizeValue: null,
          packagingSizeUom: null,
          packagingStyle: null,
          defaultQuantityUom: null,
        },
        coverage: {
          coverageStatus: "covered",
          coverageRationale: "Manual review",
          ftlCategory: "Fresh-cut fruits",
          ftlSourceUrl: "https://example.test/ftl",
          ftlSourceVersion: "test-1",
          reviewedBy: "qa",
          reviewedAt: "2026-09-07T00:00:00Z",
        },
      },
    ],
    locations: ["dock", "source"].map((id) => ({
      id,
      archived: false,
      partyArchived: false,
      roles: ["receive_at"],
      description,
    })),
    lots: [],
    documents: [{ id: "bol", archived: false, type: "bol", number: "=BOL-01" }],
    conflictingCreateLines: [],
  };
}

describe("saved receiving data readiness", () => {
  it("checks exact data without changing lot identity, quantity, references or input", () => {
    const value = input();
    const before = structuredClone(value);
    expect(assessReceivingReadiness(value)).toEqual({
      state: "complete",
      issues: [],
      exemptReviewRequiredLines: [],
    });
    expect(value).toEqual(before);
  });
  it("blocks an invalid supplied GTIN but permits a product without one", () => {
    const value = input();
    at(value.products, 0).gtin14 = "00000000000001";
    expect(assessReceivingReadiness(value).issues).toContainEqual({
      severity: "error",
      group: "lines",
      line: 1,
      field: "product",
      code: "format",
      detail: "gtin",
    });
    at(value.products, 0).gtin14 = null;
    expect(assessReceivingReadiness(value)).toEqual({
      state: "complete",
      issues: [],
      exemptReviewRequiredLines: [],
    });
  });
  it("reports header gaps and an empty receipt without inventing a line", () => {
    const value = input();
    value.draft = {
      dateReceived: null,
      locationId: null,
      previousSourceLocationId: null,
      items: [],
      documentIds: [],
    };
    expect(assessReceivingReadiness(value)).toEqual({
      state: "blocked",
      exemptReviewRequiredLines: [],
      issues: [
        {
          severity: "error",
          group: "header",
          line: null,
          field: "dateReceived",
          code: "required",
          detail: null,
        },
        {
          severity: "error",
          group: "header",
          line: null,
          field: "location",
          code: "required",
          detail: null,
        },
        {
          severity: "error",
          group: "header",
          line: null,
          field: "previousSource",
          code: "required",
          detail: null,
        },
        {
          severity: "error",
          group: "lines",
          line: null,
          field: "items",
          code: "required",
          detail: null,
        },
        {
          severity: "error",
          group: "documents",
          line: null,
          field: "documents",
          code: "required",
          detail: null,
        },
      ],
    });
  });
  it("reports missing line fields with their one-based line number", () => {
    const value = input();
    value.draft.items = [
      {
        productId: null,
        lotId: null,
        lotLinkMode: "link_existing",
        tlc: null,
        source: null,
        quantity: null,
        unitOfMeasure: null,
        exemptSupplier: false,
        exemptReason: null,
      },
    ];
    expect(
      assessReceivingReadiness(value).issues.map((issue) => [issue.line, issue.field, issue.code]),
    ).toEqual([
      [1, "product", "required"],
      [1, "tlc", "required"],
      [1, "source", "required"],
      [1, "quantity", "required"],
      [1, "unitOfMeasure", "required"],
      [1, "lot", "required"],
    ]);
  });
  it("reports current location detail gaps, inactive owners and the receiving role", () => {
    const value = input();
    const dock = at(value.locations, 0);
    dock.description = { ...dock.description, phoneNumber: null };
    dock.roles = [];
    at(value.locations, 1).partyArchived = true;
    expect(assessReceivingReadiness(value).issues).toEqual(
      expect.arrayContaining([
        {
          severity: "error",
          group: "header",
          line: null,
          field: "location",
          code: "incomplete_description",
          detail: "phoneNumber",
        },
        {
          severity: "error",
          group: "header",
          line: null,
          field: "location",
          code: "wrong_role",
          detail: null,
        },
        {
          severity: "error",
          group: "header",
          line: null,
          field: "previousSource",
          code: "inactive",
          detail: null,
        },
        {
          severity: "error",
          group: "lines",
          line: 1,
          field: "source",
          code: "inactive",
          detail: null,
        },
      ]),
    );
  });
  it.each(["unknown", "exemption_review_required"] as const)(
    "blocks unresolved coverage %s",
    (coverageStatus) => {
      const value = input();
      at(value.products, 0).coverage.coverageStatus = coverageStatus;
      expect(assessReceivingReadiness(value).issues).toContainEqual({
        severity: "error",
        group: "lines",
        line: 1,
        field: "coverage",
        code: "coverage_unresolved",
        detail: "coverageStatus",
      });
    },
  );
  it("does not turn an exemption checkbox into a reviewed basis or silently assign a TLC", () => {
    const value = input();
    const line = at(value.draft.items, 0);
    line.exemptSupplier = true;
    line.exemptReason = "Supplier declaration";
    line.tlc = null;
    const result = assessReceivingReadiness(value);
    expect(result.state).toBe("blocked");
    expect(result.issues).toContainEqual({
      severity: "error",
      group: "lines",
      line: 1,
      field: "tlc",
      code: "tlc_assignment_required",
      detail: null,
    });
    expect(result.issues).toContainEqual({
      severity: "error",
      group: "lines",
      line: 1,
      field: "exemption",
      code: "required",
      detail: "evidenceUrl",
    });
    expect(line.tlc).toBeNull();
    line.tlc = "supplier-original";
    line.exemptReceipt = { evidenceUrl: null, tlcHandling: "preserve_existing", proposedTlc: null };
    expect(
      assessReceivingReadiness(value).issues.some((i) => i.code === "tlc_assignment_required"),
    ).toBe(false);
    expect(line.tlc).toBe("supplier-original");
  });
  it("assesses complete own assignments and effective duplicate identities without changing received TLCs", () => {
    const value = input();
    const line = at(value.draft.items, 0);
    Object.assign(line, {
      exemptSupplier: true,
      exemptReason: "Receipt rationale",
      tlc: null,
      source: { kind: "location", locationId: "dock" },
      exemptReceipt: {
        evidenceUrl: "https://supplier.example.test/review",
        tlcHandling: "assign_if_missing",
        proposedTlc: "=Own/Ä",
      },
    });
    expect(assessReceivingReadiness(value)).toEqual({
      state: "complete",
      issues: [],
      exemptReviewRequiredLines: [1],
    });
    value.draft.items.push({ ...line });
    expect(assessReceivingReadiness(value)).toMatchObject({
      state: "blocked",
      exemptReviewRequiredLines: [1, 2],
    });
    expect(
      assessReceivingReadiness(value)
        .issues.filter((i) => i.code === "duplicate_identity")
        .map((i) => i.line),
    ).toEqual([1, 2]);
    value.draft.items[1] = { ...line, exemptSupplier: false, tlc: "=Own/Ä" };
    expect(
      assessReceivingReadiness(value)
        .issues.filter((i) => i.code === "duplicate_identity")
        .map((i) => i.line),
    ).toEqual([1, 2]);
    expect(line.tlc).toBeNull();
  });
  it("requires linked lot product, TLC and complete source to match", () => {
    const value = input();
    const line = at(value.draft.items, 0);
    line.lotLinkMode = "link_existing";
    line.lotId = "lot";
    value.lots = [
      { id: "lot", productId: "other", tlc: "other", source: null, status: "quarantined" },
    ];
    expect(
      assessReceivingReadiness(value)
        .issues.filter((i) => i.field === "lot")
        .map((i) => i.code),
    ).toEqual(["inactive", "lot_product_mismatch", "lot_tlc_mismatch", "lot_source_mismatch"]);
  });
  it("rejects two new identities and existing collisions without linking anything automatically", () => {
    const value = input();
    value.draft.items.push(structuredClone(at(value.draft.items, 0)));
    value.conflictingCreateLines = [1];
    const result = assessReceivingReadiness(value);
    expect(result.issues.filter((i) => i.code === "duplicate_identity").map((i) => i.line)).toEqual(
      [1, 2],
    );
    expect(value.draft.items.every((i) => i.lotId === null)).toBe(true);
  });
  it("validates a source reference's resolved description without fetching its URL", () => {
    const value = input();
    at(value.draft.items, 0).source = {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: "https://supplier.example.test/Case/A",
      resolvedLocationId: "missing",
    };
    expect(assessReceivingReadiness(value).issues).toContainEqual({
      severity: "error",
      group: "lines",
      line: 1,
      field: "source",
      code: "unavailable",
      detail: null,
    });
  });
  it("keeps generic coverage unassessed and absent documents a warning, not FDA readiness", () => {
    const value = input();
    value.profileCode = "US_GENERIC_LOT_TRACEABILITY";
    value.draft.documentIds = [];
    expect(assessReceivingReadiness(value)).toEqual({
      state: "complete",
      exemptReviewRequiredLines: [],
      issues: [
        {
          severity: "warning",
          group: "lines",
          line: 1,
          field: "coverage",
          code: "not_assessed",
          detail: null,
        },
        {
          severity: "warning",
          group: "documents",
          line: null,
          field: "documents",
          code: "required",
          detail: null,
        },
      ],
    });
  });
  it("refuses missing references instead of treating an empty lookup as complete", () => {
    const value = input();
    value.products = [];
    value.documents = [];
    expect(
      assessReceivingReadiness(value)
        .issues.filter((i) => i.code === "unavailable")
        .map((i) => i.field),
    ).toEqual(["product", "documents"]);
  });
});

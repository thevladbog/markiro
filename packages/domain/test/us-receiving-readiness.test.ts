import { describe, expect, it } from "vitest";
import {
  assessReceivingReadiness,
  assessReceivingRevisionReadiness,
  type ReceivingReadinessInput,
  type ReceivingRetainedBinding,
} from "../src/index.js";

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

describe("retained Receiving line readiness", () => {
  const binding: ReceivingRetainedBinding = { lineNo: 1, previousLineNo: 2, lotId: "lot" };
  const context = { retainedBindings: [binding] };
  function retained(
    status = "recalled",
    mode: "create_on_finalize" | "link_existing" = "create_on_finalize",
  ) {
    const value = input();
    const row = at(value.draft.items, 0);
    row.lotId = "lot";
    row.lotLinkMode = mode;
    value.lots = [
      { id: "lot", productId: "apple", tlc: "=Case/Ä-001", source: row.source, status },
    ];
    value.conflictingCreateLines = [1];
    return value;
  }

  it.each(["consumed", "shipped", "quarantined", "recalled", "archived"])(
    "permits correction of retained %s lots without altering their status or identity",
    (status) => {
      for (const mode of ["create_on_finalize", "link_existing"] as const) {
        const value = retained(status, mode);
        const before = structuredClone(value);
        expect(assessReceivingRevisionReadiness(value, context)).toEqual({
          state: "complete",
          issues: [],
          exemptReviewRequiredLines: [],
        });
        expect(value).toEqual(before);
        expect(assessReceivingReadiness(value).state).toBe("blocked");
      }
    },
  );

  it("keeps existing readiness exactly for drafts without retained lines", () => {
    const value = input();
    expect(assessReceivingRevisionReadiness(value, { retainedBindings: [] })).toEqual({
      state: "complete",
      issues: [],
      exemptReviewRequiredLines: [],
    });
    expect(
      assessReceivingRevisionReadiness(retained(), { retainedBindings: [] }).issues.map(
        (i) => i.code,
      ),
    ).toEqual(["lot_link_inconsistent", "duplicate_identity"]);
  });

  it("still rejects a newly added non-active linked lot alongside a retained one", () => {
    const value = retained();
    value.draft.items.push({ ...at(value.draft.items, 0), lotLinkMode: "link_existing" });
    expect(assessReceivingRevisionReadiness(value, context)).toEqual({
      state: "blocked",
      exemptReviewRequiredLines: [],
      issues: [
        {
          severity: "error",
          group: "lines",
          line: 2,
          field: "lot",
          code: "inactive",
          detail: null,
        },
      ],
    });
  });

  it("does not suppress a new create collision with a retained identity", () => {
    const value = retained();
    value.draft.items.push({ ...at(value.draft.items, 0), lotId: null });
    expect(
      assessReceivingRevisionReadiness(value, context).issues.map((i) => [i.line, i.code]),
    ).toEqual([[2, "duplicate_identity"]]);
  });

  it("rechecks exact live lot identity, including resolved reference location", () => {
    const value = retained();
    at(value.draft.items, 0).source = {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: "https://supplier.example.test/Case/A",
      resolvedLocationId: "source",
    };
    value.lots = [
      {
        id: "lot",
        productId: "pear",
        tlc: "other",
        status: "recalled",
        source: {
          kind: "reference",
          referenceKind: "web_url",
          referenceValue: "https://supplier.example.test/Case/A",
          resolvedLocationId: "dock",
        },
      },
    ];
    expect(assessReceivingRevisionReadiness(value, context).issues.map((i) => i.code)).toEqual([
      "lot_product_mismatch",
      "lot_tlc_mismatch",
      "lot_source_mismatch",
    ]);
    value.lots = [];
    expect(assessReceivingRevisionReadiness(value, context).issues.map((i) => i.code)).toEqual([
      "unavailable",
    ]);
  });

  it("does not skip product, coverage, source, quantity, UOM, document or header checks", () => {
    const value = retained();
    const row = at(value.draft.items, 0);
    row.quantity = "0";
    row.unitOfMeasure = "invalid";
    row.source = null;
    value.draft.dateReceived = null;
    at(value.products, 0).archived = true;
    at(value.products, 0).coverage.coverageStatus = "unknown";
    at(value.documents, 0).archived = true;
    const result = assessReceivingRevisionReadiness(value, context);
    expect(result.state).toBe("blocked");
    expect(result.issues.map((i) => [i.field, i.code])).toEqual([
      ["dateReceived", "required"],
      ["product", "inactive"],
      ["coverage", "coverage_unresolved"],
      ["source", "required"],
      ["quantity", "format"],
      ["unitOfMeasure", "format"],
      ["lot", "lot_source_mismatch"],
      ["documents", "inactive"],
    ]);
  });

  it.each(
    [
      [{ ...binding, lotId: "other" }],
      [{ ...binding, previousLineNo: 0 }],
      [{ ...binding, previousLineNo: 101 }],
      [{ ...binding, previousLineNo: 1.5 }],
      [{ ...binding, lineNo: 2 }],
      [{ ...binding, lineNo: 0 }],
      [binding, { ...binding, previousLineNo: 3 }],
    ].map((retainedBindings) => ({ retainedBindings })),
  )("fails closed for malformed or conflicting binding context %#", ({ retainedBindings }) => {
    const result = assessReceivingRevisionReadiness(retained(), { retainedBindings });
    expect(result.state).toBe("blocked");
    expect(result.issues.some((i) => i.code === "lot_link_inconsistent")).toBe(true);
  });

  it("rejects a predecessor line reused on two current lines without granting either status exception", () => {
    const value = retained("recalled", "link_existing");
    value.draft.items.push({ ...at(value.draft.items, 0) });
    const result = assessReceivingRevisionReadiness(value, {
      retainedBindings: [binding, { ...binding, lineNo: 2 }],
    });
    expect(result.state).toBe("blocked");
    expect(result.issues.filter((i) => i.code === "inactive").map((i) => i.line)).toEqual([1, 2]);
    expect(
      result.issues.filter((i) => i.code === "lot_link_inconsistent").map((i) => i.line),
    ).toEqual([1, 2]);
  });

  it("retains an own-assigned lot with null received TLC and requires fresh QA review", () => {
    const value = retained();
    const row = at(value.draft.items, 0);
    Object.assign(row, {
      tlc: null,
      source: { kind: "location", locationId: "dock" },
      exemptSupplier: true,
      exemptReason: "Corrected supplier rationale",
      exemptReceipt: {
        evidenceUrl: "https://supplier.example.test/corrected",
        tlcHandling: "assign_if_missing",
        proposedTlc: "=Case/Ä-001",
      },
    });
    at(value.lots, 0).source = row.source;
    const before = structuredClone(value);
    expect(assessReceivingRevisionReadiness(value, context)).toEqual({
      state: "complete",
      issues: [],
      exemptReviewRequiredLines: [1],
    });
    expect(value).toEqual(before);
    expect(assessReceivingReadiness(value).state).toBe("blocked");
    row.exemptReason = null;
    row.exemptReceipt = {
      evidenceUrl: null,
      tlcHandling: "assign_if_missing",
      proposedTlc: "=Case/Ä-001",
    };
    expect(assessReceivingRevisionReadiness(value, context)).toMatchObject({
      state: "blocked",
      exemptReviewRequiredLines: [1],
    });
    expect(assessReceivingRevisionReadiness(value, context).issues.map((i) => i.detail)).toEqual([
      "exemptReason",
      "evidenceUrl",
    ]);
  });

  it("keeps retained own-assignment source distinct from a corrected receiving location", () => {
    const value = retained();
    const row = at(value.draft.items, 0);
    Object.assign(row, {
      tlc: null,
      exemptSupplier: true,
      exemptReason: "Rationale",
      exemptReceipt: {
        evidenceUrl: "https://supplier.example.test/evidence",
        tlcHandling: "assign_if_missing",
        proposedTlc: "=Case/Ä-001",
      },
    });
    // The saved lot/source remain at 'source'; only the receipt header says 'dock'.
    expect(assessReceivingRevisionReadiness(value, context)).toEqual({
      state: "complete",
      issues: [],
      exemptReviewRequiredLines: [1],
    });
    expect(assessReceivingReadiness(value).issues).toContainEqual({
      severity: "error",
      group: "lines",
      line: 1,
      field: "source",
      code: "format",
      detail: null,
    });
  });

  it("still rejects a retained own assignment with received TLC, wrong source or changed mode", () => {
    const value = retained("active", "link_existing");
    const row = at(value.draft.items, 0);
    row.source = {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: "https://supplier.example.test/source",
      resolvedLocationId: "source",
    };
    at(value.lots, 0).source = row.source;
    row.exemptSupplier = true;
    row.exemptReason = "Rationale";
    row.exemptReceipt = {
      evidenceUrl: "https://supplier.example.test/evidence",
      tlcHandling: "assign_if_missing",
      proposedTlc: "=Case/Ä-001",
    };
    expect(
      assessReceivingRevisionReadiness(value, context).issues.map((i) => [i.field, i.code]),
    ).toEqual([
      ["tlc", "format"],
      ["source", "format"],
      ["lot", "lot_link_inconsistent"],
    ]);
  });

  it("requires fresh review on retained preserved-TLC exemption lines too", () => {
    const value = retained();
    const row = at(value.draft.items, 0);
    row.exemptSupplier = true;
    row.exemptReason = "Updated rationale";
    row.exemptReceipt = {
      evidenceUrl: "https://supplier.example.test/evidence",
      tlcHandling: "preserve_existing",
      proposedTlc: null,
    };
    expect(assessReceivingRevisionReadiness(value, context)).toEqual({
      state: "complete",
      issues: [],
      exemptReviewRequiredLines: [1],
    });
  });
});

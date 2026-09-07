import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const operationKey = "b0000000-0000-4000-8000-000000000001";
const item = {
  productId: null,
  lotId: null,
  lotLinkMode: "create_on_finalize",
  tlc: null,
  source: null,
  exemptSupplier: false,
  exemptReason: null,
  supplierLotReference: null,
  quantity: null,
  unitOfMeasure: null,
  notes: null,
  previousLineNo: null,
};
const draft = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  items: [item],
  documentIds: [],
};
const base = { commandVersion: 2, operationKey, expectedLifecycleVersion: 2 };

describe("Receiving lifecycle commands", () => {
  it("requires an exact version and reason without accepting actor claims", () => {
    const input = { ...base, reason: "  Quantity corrected after recount  " };
    expect(contracts.amendReceivingSchema.parse(input)).toEqual({
      ...input,
      reason: "Quantity corrected after recount",
    });
    expect(contracts.amendReceivingSchema.safeParse({ ...input, actorId: "qa" }).success).toBe(
      false,
    );
  });
  it.each(["", " ", "\u0000", "\ud800", "x".repeat(2001)])(
    "rejects an invalid mandatory reason %j",
    (reason) => {
      expect(contracts.amendReceivingSchema.safeParse({ ...base, reason }).success).toBe(false);
      expect(
        contracts.voidReceivingSchema.safeParse({ ...base, expectedDraftVersion: null, reason })
          .success,
      ).toBe(false);
    },
  );
  it.each([undefined, 0, -1, 1.5, "2", 2147483648])(
    "rejects invalid lifecycle version %j",
    (expectedLifecycleVersion) => {
      expect(
        contracts.amendReceivingSchema.safeParse({
          ...base,
          expectedLifecycleVersion,
          reason: "Correction",
        }).success,
      ).toBe(false);
    },
  );
  it("requires an explicit nullable draft version for void; actual target status is a server check", () => {
    const input = { ...base, reason: "Duplicate receipt" };
    expect(contracts.voidReceivingSchema.safeParse(input).success).toBe(false);
    for (const expectedDraftVersion of [null, 1, 2147483647])
      expect(contracts.voidReceivingSchema.parse({ ...input, expectedDraftVersion })).toEqual({
        ...input,
        expectedDraftVersion,
      });
  });
  it("keeps original commands strict and requires an explicit binding on every amendment line", () => {
    expect(contracts.receivingAmendmentDraftSchema.parse(draft)).toEqual(draft);
    expect(contracts.receivingDraftSchema.safeParse(draft).success).toBe(false);
    const { previousLineNo, ...ordinary } = item;
    void previousLineNo;
    expect(
      contracts.receivingAmendmentDraftSchema.safeParse({ ...draft, items: [ordinary] }).success,
    ).toBe(false);
    expect(contracts.receivingDraftSchema.parse({ ...draft, items: [ordinary] })).toEqual({
      ...draft,
      items: [ordinary],
    });
  });
  it.each([0, 101, 1.5, "1"])("rejects invalid predecessor line %s", (previousLineNo) => {
    expect(
      contracts.receivingAmendmentDraftSchema.safeParse({
        ...draft,
        items: [{ ...item, previousLineNo }],
      }).success,
    ).toBe(false);
  });
  it("rejects reused bindings but permits independent new lines and reordered bound lines", () => {
    expect(
      contracts.receivingAmendmentDraftSchema.safeParse({
        ...draft,
        items: [
          { ...item, previousLineNo: 1 },
          { ...item, previousLineNo: 1 },
        ],
      }).success,
    ).toBe(false);
    const reordered = {
      ...draft,
      items: [{ ...item, previousLineNo: 9 }, item, { ...item, previousLineNo: 2 }, item],
    };
    expect(contracts.receivingAmendmentDraftSchema.parse(reordered)).toEqual(reordered);
  });
  it("requires both optimistic versions for an amendment save", () => {
    const input = { ...base, expectedDraftVersion: 3, draft };
    expect(contracts.saveReceivingAmendmentSchema.parse(input)).toEqual(input);
    expect(
      contracts.saveReceivingAmendmentSchema.safeParse({
        ...input,
        expectedDraftVersion: undefined,
      }).success,
    ).toBe(false);
    expect(
      contracts.saveReceivingAmendmentSchema.safeParse({ ...input, commandVersion: undefined })
        .success,
    ).toBe(false);
    expect(
      contracts.saveReceivingAmendmentSchema.safeParse({ ...input, reason: "changed reason" })
        .success,
    ).toBe(false);
  });
  it("binds finalization to the exact predecessor, digest and fresh explicit review set", () => {
    const input = {
      ...base,
      expectedDraftVersion: 3,
      previousRevisionId: operationKey,
      expectedInputDigest: "a".repeat(64),
      reviewedExemptLines: [1, 3],
    };
    expect(contracts.finalizeReceivingRevisionSchema.parse(input)).toEqual(input);
    for (const patch of [
      { previousRevisionId: undefined },
      { expectedInputDigest: "bad" },
      { reviewedExemptLines: undefined },
      { reviewedExemptLines: [1, 1] },
      { reviewedExemptLines: [3, 1] },
      { actorId: "forged" },
      { commandVersion: 1 },
    ])
      expect(
        contracts.finalizeReceivingRevisionSchema.safeParse({ ...input, ...patch }).success,
      ).toBe(false);
    expect(
      contracts.finalizeReceivingRevisionSchema.parse({
        ...input,
        previousRevisionId: null,
        reviewedExemptLines: [],
      }),
    ).toEqual({ ...input, previousRevisionId: null, reviewedExemptLines: [] });
  });
});

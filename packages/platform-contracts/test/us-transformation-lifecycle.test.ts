import { describe, expect, it } from "vitest";
import {
  amendTransformationSchema,
  voidTransformationSchema,
  transformationFinalizationSnapshotV1Schema,
  transformationHistoricalRecordSchema,
  transformationLifecycleReceiptSchema,
  transformationDraftRecordSchema,
  transformationDraftSchema,
} from "../src/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const successor = "00000000-0000-4000-8000-000000000003";
const now = "2026-09-26T12:00:00.000Z";
const coverage = {
  coverageStatus: "covered",
  coverageRationale: "Reviewed",
  ftlCategory: "Fresh-cut fruits",
  ftlSourceUrl: "https://www.fda.gov/food/food-traceability-list",
  ftlSourceVersion: "2026",
  reviewedBy: "qa",
  reviewedAt: now,
};
const snapshot = {
  snapshotVersion: 1,
  eventId: other,
  eventNumber: "TRN-26-0001",
  revision: 1,
  eventDate: "2026-09-26",
  timeZone: "America/Chicago",
  processor: { id, description: "Processor" },
  reason: "repacking",
  reasonNote: null,
  notes: null,
  inputs: [
    {
      kind: "ftl_lot",
      lineNo: 1,
      lotId: id,
      product: { id, description: "Apples", coverage },
      tlc: "IN",
      source: { kind: "location", id, description: "Supplier" },
      quantity: "5",
      unitOfMeasure: "lb",
    },
  ],
  outputs: [
    {
      lineNo: 1,
      lotId: other,
      product: { id, description: "Apples", coverage },
      tlc: "OUT",
      source: { kind: "location", id, description: "Processor" },
      quantity: "2",
      unitOfMeasure: "case",
    },
  ],
  documents: [{ id, type: "bol", number: "1" }],
  finalizedBy: "qa",
  finalizedAt: now,
};
const base = {
  id: other,
  eventNumber: snapshot.eventNumber,
  revision: 1,
  draftVersion: 1,
  timeZone: snapshot.timeZone,
  createdBy: "qa",
  updatedBy: "qa",
  createdAt: now,
  updatedAt: now,
};

describe("Transformation lifecycle contracts", () => {
  it("requires a bounded lifecycle version and nonempty reason", () => {
    const amend = { operationKey: id, expectedLifecycleVersion: 2, reason: "Correction" };
    expect(amendTransformationSchema.parse(amend)).toEqual(amend);
    for (const expectedLifecycleVersion of [0, 2147483648])
      expect(
        amendTransformationSchema.safeParse({ ...amend, expectedLifecycleVersion }).success,
      ).toBe(false);
    expect(amendTransformationSchema.safeParse({ ...amend, reason: " " }).success).toBe(false);
    expect(amendTransformationSchema.safeParse({ ...amend, lotId: id }).success).toBe(false);
    expect(voidTransformationSchema.safeParse({ ...amend, expectedDraftVersion: 1 }).success).toBe(
      true,
    );
    expect(voidTransformationSchema.safeParse(amend).success).toBe(true);
    expect(voidTransformationSchema.safeParse({ ...amend, expectedDraftVersion: 0 }).success).toBe(
      false,
    );
  });

  it("preserves v1 snapshot bytes and requires predecessor on revision 2", () => {
    expect(transformationFinalizationSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(
      transformationFinalizationSnapshotV1Schema.safeParse({ ...snapshot, revision: 2 }).success,
    ).toBe(false);
    expect(
      transformationFinalizationSnapshotV1Schema.safeParse({ ...snapshot, revision: 0 }).success,
    ).toBe(false);
    expect(
      transformationFinalizationSnapshotV1Schema.safeParse({ ...snapshot, revision: 2147483648 })
        .success,
    ).toBe(false);
    expect(
      transformationFinalizationSnapshotV1Schema.safeParse({ ...snapshot, previousRevisionId: id })
        .success,
    ).toBe(false);
    const second = { ...snapshot, revision: 2, previousRevisionId: id };
    expect(transformationFinalizationSnapshotV1Schema.parse(second)).toEqual(second);
  });

  it("rejects client-owned output lot IDs", () => {
    expect(
      transformationDraftSchema.safeParse({
        eventDate: null,
        processorLocationId: null,
        reason: null,
        reasonNote: null,
        notes: null,
        inputs: [],
        outputs: [
          { productId: id, tlc: "OUT", quantity: "2", unitOfMeasure: "case", lotId: other },
        ],
        documentIds: [],
      }).success,
    ).toBe(false);
  });

  it("parses historical amended and both void shapes with exact lifecycle receipt", () => {
    const lifecycle = {
      rootId: id,
      lifecycleVersion: 4,
      currentEventId: other,
      pendingDraftId: null,
      previousRevisionId: id,
      amendmentReason: "Correction",
      supersededByEventId: null,
      supersededAt: null,
      supersededBy: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
    };
    const finalized = {
      ...base,
      revision: 2,
      status: "finalized",
      finalizedAt: now,
      finalizedBy: "qa",
      snapshot: { ...snapshot, revision: 2, previousRevisionId: id },
      lifecycle,
    };
    expect(transformationHistoricalRecordSchema.safeParse(finalized).success).toBe(true);
    expect(
      transformationHistoricalRecordSchema.safeParse({ ...finalized, lifecycle: undefined })
        .success,
    ).toBe(false);
    expect(
      transformationHistoricalRecordSchema.safeParse({
        ...finalized,
        status: "amended",
        lifecycle: {
          ...lifecycle,
          currentEventId: successor,
          supersededByEventId: successor,
          supersededAt: now,
          supersededBy: "qa",
        },
      }).success,
    ).toBe(true);
    const finalizedVoid = {
      ...finalized,
      status: "void",
      lifecycle: {
        ...lifecycle,
        currentEventId: null,
        voidedAt: now,
        voidedBy: "qa",
        voidReason: "Invalid evidence",
      },
    };
    expect(transformationHistoricalRecordSchema.safeParse(finalizedVoid).success).toBe(true);
    const draftVoid = {
      ...base,
      revision: 2,
      status: "void",
      draft: {
        eventDate: null,
        processorLocationId: null,
        reason: null,
        reasonNote: null,
        notes: null,
        inputs: [],
        outputs: [],
        documentIds: [],
      },
      lifecycle: {
        ...lifecycle,
        pendingDraftId: null,
        voidedAt: now,
        voidedBy: "qa",
        voidReason: "Canceled",
      },
    };
    expect(transformationHistoricalRecordSchema.safeParse(draftVoid).success).toBe(true);
    const missingPredecessor = {
      ...draftVoid,
      lifecycle: { ...draftVoid.lifecycle, previousRevisionId: null },
    };
    expect(
      transformationDraftRecordSchema.safeParse({ ...missingPredecessor, status: "draft" }).success,
    ).toBe(false);
    expect(transformationHistoricalRecordSchema.safeParse(missingPredecessor).success).toBe(false);
    expect(
      transformationLifecycleReceiptSchema.safeParse({
        receiptVersion: 1,
        command: "transformation.void",
        operationKey: id,
        inputDigest: "a".repeat(64),
        eventId: other,
        record: missingPredecessor,
      }).success,
    ).toBe(false);
    expect(
      transformationHistoricalRecordSchema.safeParse({
        ...finalizedVoid,
        lifecycle: { ...finalizedVoid.lifecycle, voidedAt: null },
      }).success,
    ).toBe(false);
    expect(
      transformationHistoricalRecordSchema.safeParse({
        ...draftVoid,
        lifecycle: { ...draftVoid.lifecycle, voidReason: null },
      }).success,
    ).toBe(false);
    expect(
      transformationHistoricalRecordSchema.safeParse({ ...finalized, status: "amended" }).success,
    ).toBe(false);
    const receipt = {
      receiptVersion: 1,
      command: "transformation.void",
      operationKey: id,
      inputDigest: "a".repeat(64),
      eventId: other,
      record: finalizedVoid,
    };
    expect(transformationLifecycleReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(
      transformationLifecycleReceiptSchema.safeParse({ ...receipt, inputDigest: "bad" }).success,
    ).toBe(false);
  });
});

import { expect, it } from "vitest";
import {
  createTransformationDraftSchema,
  saveTransformationDraftSchema,
  finalizeTransformationSchema,
  transformationFinalizedRecordSchema,
  transformationFinalizationSnapshotV1Schema,
} from "../src/index.js";

it("requires server-owned IDs to stay out of commands and enforces version/digest", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const draft = {
    eventDate: null,
    processorLocationId: null,
    reason: null,
    reasonNote: null,
    notes: null,
    inputs: [],
    outputs: [],
    documentIds: [],
  };
  expect(createTransformationDraftSchema.safeParse({ operationKey: id, draft }).success).toBe(true);
  expect(
    createTransformationDraftSchema.safeParse({ operationKey: id, draft, tenantId: id }).success,
  ).toBe(false);
  expect(
    saveTransformationDraftSchema.safeParse({ operationKey: id, draft, expectedDraftVersion: 1 })
      .success,
  ).toBe(true);
  expect(
    finalizeTransformationSchema.safeParse({
      operationKey: id,
      expectedDraftVersion: 1,
      expectedInputDigest: "a".repeat(64),
    }).success,
  ).toBe(true);
  expect(
    finalizeTransformationSchema.safeParse({
      operationKey: id,
      expectedDraftVersion: 0,
      expectedInputDigest: "a".repeat(64),
    }).success,
  ).toBe(false);
  expect(transformationFinalizedRecordSchema.safeParse({}).success).toBe(false);
});

it("retains reviewed coverage for every product and the exact reference-backed input source", () => {
  const id = "00000000-0000-4000-8000-000000000001",
    outputId = "00000000-0000-4000-8000-000000000002";
  const coverage = {
    coverageStatus: "covered",
    coverageRationale: "  Signed review  ",
    ftlCategory: "Fresh-cut fruits",
    ftlSourceUrl: "https://www.fda.gov/food/food-traceability-list",
    ftlSourceVersion: "2026-09",
    reviewedBy: "original-reviewer",
    reviewedAt: "2026-09-25T13:14:15.123Z",
  };
  const product = { id, description: "Apple slices", coverage };
  const processor = { id, description: "Processor" };
  const source = {
    kind: "reference",
    id,
    description: "Supplier site",
    referenceKind: "web_url",
    referenceValue: "https://supplier.example.test/source/Ä?lot=001",
  };
  const snapshot = {
    snapshotVersion: 1,
    eventId: id,
    eventNumber: "TRN-26-0001",
    revision: 1,
    eventDate: "2026-09-26",
    timeZone: "America/Chicago",
    processor,
    reason: "repacking",
    reasonNote: null,
    notes: null,
    inputs: [
      {
        kind: "ftl_lot",
        lineNo: 1,
        lotId: id,
        product,
        tlc: "001",
        source,
        quantity: "500",
        unitOfMeasure: "lb",
      },
    ],
    outputs: [
      {
        lineNo: 1,
        lotId: outputId,
        product,
        tlc: "OUT",
        source: { kind: "location", ...processor },
        quantity: "100",
        unitOfMeasure: "case",
      },
    ],
    documents: [{ id, type: "bol", number: "1" }],
    finalizedBy: "finalizer",
    finalizedAt: "2026-09-26T13:00:00.000Z",
  };
  expect(transformationFinalizationSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
  for (const collection of ["inputs", "outputs"] as const) {
    for (const field of [
      "coverageStatus",
      "coverageRationale",
      "ftlCategory",
      "ftlSourceUrl",
      "ftlSourceVersion",
      "reviewedBy",
      "reviewedAt",
    ] as const) {
      const bad = structuredClone(snapshot);
      Reflect.deleteProperty(bad[collection][0]?.product.coverage ?? {}, field);
      expect(transformationFinalizationSnapshotV1Schema.safeParse(bad).success).toBe(false);
    }
  }
  for (const field of ["kind", "referenceKind", "referenceValue"]) {
    const bad = structuredClone(snapshot);
    Reflect.deleteProperty(bad.inputs[0]?.source ?? {}, field);
    expect(transformationFinalizationSnapshotV1Schema.safeParse(bad).success).toBe(false);
  }
  expect(
    transformationFinalizationSnapshotV1Schema.safeParse({
      ...snapshot,
      inputs: [
        {
          ...snapshot.inputs[0],
          product: { ...product, coverage: { ...coverage, reviewedBy: null } },
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    transformationFinalizationSnapshotV1Schema.safeParse({
      ...snapshot,
      outputs: [{ ...snapshot.outputs[0], source }],
    }).success,
  ).toBe(false);
});

it("pins a finalized non-FTL snapshot without invented input lot or TLC", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const location = { id, description: "Processor at 1 Main St" };
  const finalizedAt = "2026-09-26T12:00:00.000Z";
  const coverage = {
    coverageStatus: "covered",
    coverageRationale: "Reviewed product",
    ftlCategory: "Fresh-cut fruits",
    ftlSourceUrl: "https://www.fda.gov/food/food-traceability-list",
    ftlSourceVersion: "2026",
    reviewedBy: "reviewer",
    reviewedAt: finalizedAt,
  };
  const product = { id, description: "Frozen food, packaged case", coverage };
  const snapshot = {
    snapshotVersion: 1,
    eventId: id,
    eventNumber: "TRN-26-0001",
    revision: 1,
    eventDate: "2026-09-26",
    timeZone: "America/New_York",
    processor: location,
    reason: "processing",
    reasonNote: null,
    notes: null,
    inputs: [
      {
        kind: "non_ftl",
        lineNo: 1,
        product: {
          ...product,
          coverage: {
            ...coverage,
            coverageStatus: "not_covered",
            ftlCategory: null,
            ftlSourceUrl: null,
            ftlSourceVersion: null,
          },
        },
        source: { kind: "location", ...location },
        reference: "Supplier invoice 42",
        quantity: "500",
        unitOfMeasure: "lb",
      },
    ],
    outputs: [
      {
        lineNo: 1,
        lotId: id,
        product,
        tlc: "OUT:26/1",
        source: { kind: "location", ...location },
        quantity: "100",
        unitOfMeasure: "case",
      },
    ],
    documents: [{ id, type: "production_record", number: "PR-42" }],
    finalizedBy: "actor",
    finalizedAt,
  };
  const record = {
    id,
    eventNumber: snapshot.eventNumber,
    revision: 1,
    draftVersion: 2,
    timeZone: snapshot.timeZone,
    createdBy: "actor",
    updatedBy: "actor",
    createdAt: finalizedAt,
    updatedAt: finalizedAt,
    status: "finalized",
    finalizedAt,
    finalizedBy: "actor",
    snapshot,
  };
  expect(transformationFinalizedRecordSchema.safeParse(record).success).toBe(true);
  expect(
    transformationFinalizedRecordSchema.safeParse({
      ...record,
      snapshot: { ...snapshot, inputs: [{ ...snapshot.inputs[0], lotId: id }] },
    }).success,
  ).toBe(false);
  const otherId = "00000000-0000-4000-8000-000000000002";
  const badSnapshots = [
    {
      ...snapshot,
      outputs: [{ ...snapshot.outputs[0], source: { id: otherId, description: "Other site" } }],
    },
    { ...snapshot, outputs: [snapshot.outputs[0], { ...snapshot.outputs[0], lineNo: 2 }] },
    {
      ...snapshot,
      outputs: [
        { ...snapshot.outputs[0], lotId: otherId },
        { ...snapshot.outputs[0], lineNo: 2, lotId: otherId },
      ],
    },
    {
      ...snapshot,
      inputs: [
        {
          kind: "ftl_lot",
          lineNo: 1,
          lotId: id,
          product,
          tlc: "IN:26/1",
          source: { kind: "location", ...location },
          quantity: "500",
          unitOfMeasure: "lb",
        },
      ],
    },
    { ...snapshot, inputs: [snapshot.inputs[0], { ...snapshot.inputs[0], lineNo: 1 }] },
    { ...snapshot, documents: [snapshot.documents[0], snapshot.documents[0]] },
  ];
  for (const badSnapshot of badSnapshots)
    expect(
      transformationFinalizedRecordSchema.safeParse({ ...record, snapshot: badSnapshot }).success,
    ).toBe(false);
});

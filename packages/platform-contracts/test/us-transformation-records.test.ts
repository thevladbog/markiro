import { expect, it } from "vitest";
import { transformationV1, transformationV2 } from "./support/us-transformation-v2-fixture.js";
import { at } from "./support/us-receiving-lifecycle-fixture.js";
import {
  createTransformationDraftSchema,
  saveTransformationDraftSchema,
  finalizeTransformationSchema,
  transformationFinalizedRecordSchema,
  transformationFinalizationSnapshotV1Schema,
  transformationFinalizationSnapshotV2Schema,
  transformationFinalizationSnapshotSchema,
} from "../src/index.js";

it("accepts captured V2 facts in finalized records while retaining V1 parsing", () => {
  const snapshot = transformationV2;
  const record = {
    id: snapshot.eventId,
    eventNumber: snapshot.eventNumber,
    revision: 1,
    draftVersion: 1,
    timeZone: snapshot.timeZone,
    createdBy: "qa",
    updatedBy: "qa",
    createdAt: snapshot.finalizedAt,
    updatedAt: snapshot.finalizedAt,
    status: "finalized",
    finalizedAt: snapshot.finalizedAt,
    finalizedBy: "qa",
    snapshot,
  };
  expect(transformationFinalizedRecordSchema.safeParse(record).success).toBe(true);
  expect(transformationFinalizationSnapshotV1Schema.parse(transformationV1)).toEqual(
    transformationV1,
  );
  expect(transformationFinalizationSnapshotV2Schema.safeParse(snapshot).success).toBe(true);
  expect(transformationFinalizationSnapshotSchema.safeParse(transformationV1).success).toBe(true);
  expect(transformationFinalizationSnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect(transformationFinalizationSnapshotV1Schema.safeParse(snapshot).success).toBe(false);
  expect(transformationFinalizationSnapshotV2Schema.safeParse(transformationV1).success).toBe(
    false,
  );
  expect(
    transformationFinalizedRecordSchema.safeParse({ ...record, id: at(snapshot.outputs, 0).lotId })
      .success,
  ).toBe(false);
});

it("binds V2 structured identities and complete output processor facts", () => {
  const snapshot = transformationV2;
  const input = at(snapshot.inputs, 0);
  const output = at(snapshot.outputs, 0);
  const otherId = "00000000-0000-4000-8000-000000000099";
  const invalid = [
    {
      ...snapshot,
      processor: {
        ...snapshot.processor,
        kdes: { ...snapshot.processor.kdes, locationId: otherId },
      },
    },
    {
      ...snapshot,
      inputs: [
        {
          ...input,
          product: { ...input.product, kdes: { ...input.product.kdes, sourceProductId: otherId } },
        },
      ],
    },
    {
      ...snapshot,
      outputs: [
        {
          ...output,
          product: {
            ...output.product,
            kdes: { ...output.product.kdes, sourceProductId: otherId },
          },
        },
      ],
    },
    {
      ...snapshot,
      inputs: [
        {
          ...input,
          source: { ...input.source, kdes: { ...input.source.kdes, locationId: otherId } },
        },
      ],
    },
    {
      ...snapshot,
      outputs: [
        {
          ...output,
          source: { ...output.source, kdes: { ...output.source.kdes, locationId: otherId } },
        },
      ],
    },
    ...[
      { ...output.source.kdes, businessName: "Other processor" },
      { ...output.source.kdes, partyId: otherId },
      { ...output.source.kdes, address: { kind: "street", streetAddress: "Other street" } },
      { ...output.source.kdes, countryDisplay: "Different country label" },
    ].map((kdes) => ({
      ...snapshot,
      outputs: [{ ...output, source: { ...output.source, kdes } }],
    })),
  ];
  for (const value of invalid)
    expect(transformationFinalizationSnapshotSchema.safeParse(value).success).toBe(false);
  const parsed = transformationFinalizationSnapshotV2Schema.parse(snapshot);
  expect(at(parsed.inputs, 0).source).toMatchObject({
    kind: "reference",
    referenceKind: "web_url",
    referenceValue: "https://supplier.example.test/source/Ä?lot=001",
    kdes: {
      businessName: "Captured supplier",
      address: { kind: "street", streetAddress: "100 Test Way" },
    },
  });
});

it("rejects missing or extra V2 fields and malformed existing KDE schemas", () => {
  const snapshot = transformationV2;
  const input = at(snapshot.inputs, 0);
  const output = at(snapshot.outputs, 0);
  const omit = (value: object, key: string) => {
    const copy = { ...value };
    Reflect.deleteProperty(copy, key);
    return copy;
  };
  const invalid = [
    { ...snapshot, snapshotVersion: 3 },
    { ...snapshot, snapshotVersion: undefined },
    { ...snapshot, extra: true },
    { ...snapshot, processor: omit(snapshot.processor, "kdes") },
    { ...snapshot, inputs: [{ ...input, product: omit(input.product, "kdes") }] },
    { ...snapshot, inputs: [{ ...input, source: omit(input.source, "kdes") }] },
    { ...snapshot, outputs: [{ ...output, product: omit(output.product, "kdes") }] },
    { ...snapshot, outputs: [{ ...output, source: omit(output.source, "kdes") }] },
    { ...snapshot, processor: { ...snapshot.processor, extra: true } },
    {
      ...snapshot,
      processor: { ...snapshot.processor, kdes: { ...snapshot.processor.kdes, extra: true } },
    },
    {
      ...snapshot,
      processor: {
        ...snapshot.processor,
        kdes: { ...snapshot.processor.kdes, phoneNumber: "not a phone" },
      },
    },
    { ...snapshot, inputs: [{ ...input, product: { ...input.product, extra: true } }] },
    {
      ...snapshot,
      inputs: [
        { ...input, product: { ...input.product, kdes: { ...input.product.kdes, extra: true } } },
      ],
    },
    {
      ...snapshot,
      inputs: [
        {
          ...input,
          product: { ...input.product, kdes: { ...input.product.kdes, productName: "" } },
        },
      ],
    },
    {
      ...snapshot,
      inputs: [
        {
          ...input,
          product: {
            ...input.product,
            kdes: { ...input.product.kdes, packagingSize: { value: "wrong", uom: "lb" } },
          },
        },
      ],
    },
    {
      ...snapshot,
      inputs: [
        {
          ...input,
          product: { ...input.product, kdes: omit(input.product.kdes, "packagingStyle") },
        },
      ],
    },
    { ...snapshot, inputs: [{ ...input, source: { ...input.source, referenceKind: "unknown" } }] },
    {
      ...snapshot,
      inputs: [{ ...input, source: { ...input.source, referenceValue: "not a URL" } }],
    },
    { ...snapshot, inputs: [{ ...input, source: omit(input.source, "referenceValue") }] },
    {
      ...snapshot,
      outputs: [
        {
          ...output,
          source: {
            ...snapshot.processor,
            kind: "reference",
            referenceKind: "web_url",
            referenceValue: "https://example.test",
          },
        },
      ],
    },
  ];
  for (const value of invalid)
    expect(transformationFinalizationSnapshotSchema.safeParse(value).success).toBe(false);
});

it.each([transformationV1, transformationV2])(
  "preserves classification, quantity, line and revision rules in snapshot v$snapshotVersion",
  (snapshot) => {
    const input = at(snapshot.inputs, 0);
    const output = at(snapshot.outputs, 0);
    const invalid = [
      { ...snapshot, revision: 2 },
      { ...snapshot, previousRevisionId: snapshot.eventId },
      { ...snapshot, inputs: [] },
      { ...snapshot, outputs: [] },
      ...["0", "-1", " 5", "1.0000"].map((quantity) => ({
        ...snapshot,
        inputs: [{ ...input, quantity }],
      })),
      { ...snapshot, inputs: [{ ...input, unitOfMeasure: "wrong" }] },
      { ...snapshot, inputs: [{ ...input, lineNo: 0 }] },
      { ...snapshot, inputs: [input, { ...input, lineNo: 2 }] },
      { ...snapshot, inputs: [input, { ...input, lotId: output.lotId }] },
      { ...snapshot, outputs: [{ ...output, lotId: input.lotId }] },
      { ...snapshot, outputs: [output, { ...output, lineNo: 2 }] },
      { ...snapshot, outputs: [output, { ...output, lotId: snapshot.eventId }] },
      {
        ...snapshot,
        inputs: [
          {
            ...input,
            product: {
              ...input.product,
              coverage: { ...input.product.coverage, coverageStatus: "not_covered" },
            },
          },
        ],
      },
      {
        ...snapshot,
        outputs: [
          {
            ...output,
            product: {
              ...output.product,
              coverage: { ...output.product.coverage, reviewedBy: null },
            },
          },
        ],
      },
      {
        ...snapshot,
        outputs: [{ ...output, source: { ...output.source, description: "Other processor" } }],
      },
      { ...snapshot, documents: [at(snapshot.documents, 0), at(snapshot.documents, 0)] },
    ];
    for (const value of invalid)
      expect(transformationFinalizationSnapshotSchema.safeParse(value).success).toBe(false);
    expect(
      transformationFinalizationSnapshotSchema.safeParse({
        ...snapshot,
        revision: 2,
        previousRevisionId: snapshot.eventId,
      }).success,
    ).toBe(true);
  },
);

it("preserves V2 non-FTL structured facts without accepting invented lot or reference source fields", () => {
  const input = at(transformationV2.inputs, 0);
  const source = {
    id: input.source.id,
    description: input.source.description,
    kdes: input.source.kdes,
  };
  const nonFtl = {
    kind: "non_ftl",
    lineNo: 1,
    product: {
      ...input.product,
      coverage: {
        ...input.product.coverage,
        coverageStatus: "not_covered",
        ftlCategory: null,
        ftlSourceUrl: null,
        ftlSourceVersion: null,
      },
    },
    source: { ...source, kind: "location" },
    reference: "Supplier salt invoice",
    quantity: "1",
    unitOfMeasure: "lb",
  };
  const snapshot = { ...transformationV2, inputs: [nonFtl] };
  expect(transformationFinalizationSnapshotSchema.safeParse(snapshot).success).toBe(true);
  for (const bad of [
    { ...nonFtl, lotId: input.lotId },
    { ...nonFtl, tlc: "invented" },
    { ...nonFtl, source: input.source },
  ])
    expect(
      transformationFinalizationSnapshotSchema.safeParse({ ...snapshot, inputs: [bad] }).success,
    ).toBe(false);
});

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

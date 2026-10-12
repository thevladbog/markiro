import { describe, expect, it } from "vitest";
import {
  transformationDraftRecordSchema,
  transformationFinalizedRecordSchema,
  traceabilityLotSchema,
  referenceDocumentSchema,
} from "@markiro/platform-contracts";
import { assertBoundedSyntheticJson } from "../src/modules/traceability/demo/us-demo-journal-contract";
import { canonicalExportDigest } from "@markiro/domain";
import { receivingOperationReceiptV2Schema } from "@markiro/platform-contracts";
import { makeUsDatasetReceivingInput } from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import {
  makeUsDatasetTransformationInput,
  parseUsDatasetTransformationInput,
  parseUsDatasetTransformationResult,
  usDatasetTransformationRecordIds,
  makeUsDatasetReceivingIdentity,
  datasetTransformationError,
} from "../src/modules/traceability/demo/us-dataset-transformation-contract";

const datasetId = "00000000-0000-4000-8000-000000000001";
const references = {
  datasetId,
  unitKey: "references" as const,
  stage: "references" as const,
  revision: 2 as const,
  operationKey: "00000000-0000-4000-8000-000000000002",
  inputDigest: "a".repeat(64),
  resultDigest: "b".repeat(64),
};
const receiving = {
  datasetId,
  unitKey: "chain_0259",
  stage: "receiving" as const,
  revision: 2 as const,
  operationKey: "00000000-0000-4000-8000-000000000003",
  inputDigest: "c".repeat(64),
  resultDigest: "d".repeat(64),
};
describe("dataset Transformation intent", () => {
  it("rejects another chain's otherwise valid receipt identity", () => {
    expect(() =>
      makeUsDatasetTransformationInput(259, references, { ...receiving, unitKey: "chain_0258" }),
    ).toThrow();
  });
  it("preserves the exact recipe rather than accepting quantity drift", () => {
    const input = structuredClone(makeUsDatasetTransformationInput(259, references, receiving));
    expect(input.chain.transformation.output.quantity).toBe("100");
    expect(() =>
      parseUsDatasetTransformationInput({
        ...input,
        chain: {
          ...input.chain,
          transformation: {
            ...input.chain.transformation,
            output: { ...input.chain.transformation.output, quantity: "101" },
          },
        },
      }),
    ).toThrow();
  });
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-10-07T12:00:00.000Z";
function at<T>(rows: readonly T[], index: number): T {
  const value = rows[index];
  if (value === undefined) throw new Error("missing test fixture row");
  return value;
}
function receivingStage() {
  const input = makeUsDatasetReceivingInput(259, references);
  const source = { kind: "location", locationId: uuid(32) };
  const documents = input.chain.receiving.references.map((number, i) => {
    const d = input.chain.documents.find((d) => d.input.number === number);
    if (!d) throw new Error("missing receiving fixture document");
    return {
      key: d.key,
      record: referenceDocumentSchema.parse({
        ...d.input,
        id: uuid(100 + i),
        partyId: uuid(33),
        archivedAt: null,
        createdBy: "synthetic-owner",
        createdAt: stamp,
        updatedAt: stamp,
      }),
    };
  });
  const lots = input.chain.receiving.lines.map((line, i) =>
    traceabilityLotSchema.parse({
      id: uuid(40 + i),
      productId: uuid(50),
      tlc: line.tlc,
      source,
      assignmentBasis: "imported",
      sourceLockedAt: stamp,
      status: "active",
      revision: 1,
      createdBy: "synthetic-owner",
      updatedBy: "synthetic-owner",
      createdAt: stamp,
      updatedAt: stamp,
    }),
  );
  const draft = {
    dateReceived: input.chain.receiving.eventDate,
    locationId: uuid(31),
    previousSourceLocationId: uuid(32),
    receivedAtNote: null,
    notes: null,
    documentIds: documents.map((d) => d.record.id),
    items: input.chain.receiving.lines.map((line) => ({
      productId: uuid(50),
      lotLinkMode: "create_on_finalize",
      lotId: null,
      tlc: line.tlc,
      source,
      exemptSupplier: false,
      exemptReason: null,
      supplierLotReference: null,
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
      notes: null,
    })),
  };
  const description = (id: string) => ({
    schemaVersion: 1,
    locationId: id,
    partyId: id === uuid(32) ? uuid(33) : uuid(30),
    businessName: "Synthetic business",
    phoneNumber: "+1 509 555 0100",
    address: { kind: "street", streetAddress: "100 Example Rd" },
    city: "Yakima",
    stateOrRegion: "WA",
    zipOrPostalCode: "98901",
    countryCode: "US",
    countryDisplay: "United States",
  });
  const lifecycle = {
    rootId: uuid(90),
    lifecycleVersion: 1,
    previousRevisionId: null,
    supersededByEventId: null,
    currentEventId: null,
    pendingDraftId: uuid(90),
    amendmentReason: null,
    supersededAt: null,
    supersededBy: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
  };
  const record = {
    recordVersion: 2,
    id: uuid(90),
    eventNumber: "REC-26-0001",
    revision: 1,
    draftVersion: 1,
    timeZone: "America/Los_Angeles",
    createdBy: "synthetic-owner",
    updatedBy: "synthetic-owner",
    createdAt: stamp,
    updatedAt: stamp,
    status: "draft",
    lifecycle,
    content: { kind: "draft", draft },
  };
  const created = receivingOperationReceiptV2Schema.parse({
    receiptVersion: 2,
    command: "receiving.create",
    operationKey: receiving.operationKey,
    inputDigest: "a".repeat(64),
    eventId: record.id,
    record,
  });
  const snapshot = {
    snapshotVersion: 3,
    dateReceived: draft.dateReceived,
    locationId: uuid(31),
    previousSourceLocationId: uuid(32),
    receivedAtNote: null,
    notes: null,
    profileCode: "US_FSMA204_PROCESSOR",
    baselineVersion: "US-REG-2026-09-03",
    locationDescription: description(uuid(31)),
    previousSourceDescription: description(uuid(32)),
    items: draft.items.map((item, i) => {
      const { exemptSupplier, exemptReason, ...common } = item;
      void exemptSupplier;
      void exemptReason;
      return {
        ...common,
        lotId: at(lots, i).id,
        lineNo: i + 1,
        receiptBasis: { kind: "ordinary" },
        lotBinding: { kind: "created" },
        productDescription: {
          snapshotVersion: 1,
          sourceProductId: uuid(50),
          productName: "Synthetic apple slices",
          brandName: null,
          commodity: null,
          variety: null,
          packagingSize: null,
          packagingStyle: null,
          gtin: null,
        },
        coverage: {
          coverageStatus: "covered",
          coverageRationale: "Synthetic review",
          ftlCategory: "Fruits (fresh-cut)",
          ftlSourceUrl: "https://www.fda.gov/food/",
          ftlSourceVersion: "synthetic-v1",
          reviewedBy: "synthetic-owner",
          reviewedAt: stamp,
        },
        sourceDescription: description(uuid(32)),
      };
    }),
    documents: documents.map(({ record }) => {
      const { id, archivedAt, createdBy, createdAt, updatedAt, ...fields } = record;
      void archivedAt;
      void createdBy;
      void createdAt;
      void updatedAt;
      return {
        document: { ...fields, documentId: id, snapshotVersion: 1 },
        issuer: { id: record.partyId, name: "Synthetic supplier", legalName: null },
      };
    }),
    confirmation: {
      ruleVersion: "receiving-readiness-v4",
      inputDigest: "b".repeat(64),
      warnings: [],
      reviewedExemptLines: [],
    },
  };
  const finalized = receivingOperationReceiptV2Schema.parse({
    ...created,
    command: "receiving.finalize",
    inputDigest: "c".repeat(64),
    record: {
      ...record,
      status: "finalized",
      lifecycle: {
        ...lifecycle,
        lifecycleVersion: 2,
        currentEventId: record.id,
        pendingDraftId: null,
      },
      content: { kind: "finalized", finalizedAt: stamp, finalizedBy: "synthetic-owner", snapshot },
    },
  });
  const result = { input, documents, created, finalized, lots };
  return {
    unitKey: "chain_0259",
    stage: "receiving" as const,
    revision: 2,
    intent: {
      unitKey: "chain_0259",
      stage: "receiving" as const,
      operationKey: receiving.operationKey,
      input,
      inputDigest: canonicalExportDigest(input),
    },
    receipt: {
      recordIds: [uuid(100), uuid(101), uuid(90), uuid(40), uuid(41)],
      result,
      resultDigest: canonicalExportDigest(result),
    },
  };
}
function fixture() {
  const input = makeUsDatasetTransformationInput(259, references, receiving);
  const documents = input.chain.transformation.references.map((number, i) => {
    const definition = input.chain.documents.find((d) => d.input.number === number);
    if (!definition) throw new Error("fixture missing document");
    return {
      key: definition.key,
      record: referenceDocumentSchema.parse({
        ...definition.input,
        id: uuid(10 + i),
        partyId: uuid(30),
        archivedAt: null,
        createdBy: "synthetic-owner",
        createdAt: stamp,
        updatedAt: stamp,
      }),
    };
  });
  const draft = {
    eventDate: input.chain.transformation.eventDate,
    processorLocationId: uuid(31),
    reason: "commingling_and_repacking",
    reasonNote: null,
    notes: "Synthetic six-month demo transformation.",
    inputs: input.chain.transformation.inputs.map((line, i) => ({
      kind: "ftl_lot",
      lotId: uuid(40 + i),
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
    })),
    outputs: [
      {
        productId: uuid(51),
        tlc: input.chain.transformation.output.tlc,
        quantity: "100",
        unitOfMeasure: "case",
      },
    ],
    documentIds: documents.map((d) => d.record.id),
  };
  const lifecycle = {
    rootId: uuid(60),
    lifecycleVersion: 1,
    currentEventId: null,
    pendingDraftId: uuid(60),
    previousRevisionId: null,
    amendmentReason: null,
    supersededByEventId: null,
    supersededAt: null,
    supersededBy: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
  };
  const base = {
    id: uuid(60),
    eventNumber: "TRN-26-0001",
    revision: 1,
    draftVersion: 1,
    timeZone: "America/Los_Angeles",
    createdBy: "synthetic-owner",
    updatedBy: "synthetic-owner",
    createdAt: stamp,
    updatedAt: stamp,
  };
  const created = transformationDraftRecordSchema.parse({
    ...base,
    lifecycle,
    status: "draft",
    draft,
  });
  const coverage = {
    coverageStatus: "covered",
    coverageRationale: "Synthetic manual review",
    ftlCategory: "Fresh-cut fruits",
    ftlSourceUrl:
      "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
    ftlSourceVersion: "2026",
    reviewedBy: "synthetic-owner",
    reviewedAt: stamp,
  };
  const snapshot = {
    snapshotVersion: 1,
    eventId: uuid(60),
    eventNumber: "TRN-26-0001",
    revision: 1,
    eventDate: draft.eventDate,
    timeZone: base.timeZone,
    processor: { id: uuid(31), description: "Synthetic processor" },
    reason: draft.reason,
    reasonNote: null,
    notes: draft.notes,
    inputs: input.chain.transformation.inputs.map((line, i) => ({
      kind: "ftl_lot",
      lineNo: i + 1,
      lotId: uuid(40 + i),
      product: { id: uuid(50), description: "Synthetic input", coverage },
      tlc: line.tlc,
      source: { kind: "location", id: uuid(32), description: "Synthetic supplier" },
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
    })),
    outputs: [
      {
        lineNo: 1,
        lotId: uuid(61),
        product: { id: uuid(51), description: "Synthetic output", coverage },
        tlc: input.chain.transformation.output.tlc,
        source: { kind: "location", id: uuid(31), description: "Synthetic processor" },
        quantity: "100",
        unitOfMeasure: "case",
      },
    ],
    documents: documents.map(({ record }) => ({
      id: record.id,
      type: record.type,
      number: record.number,
    })),
    finalizedBy: "synthetic-owner",
    finalizedAt: stamp,
  };
  const finalized = transformationFinalizedRecordSchema.parse({
    ...base,
    lifecycle: {
      ...lifecycle,
      lifecycleVersion: 2,
      currentEventId: uuid(60),
      pendingDraftId: null,
    },
    status: "finalized",
    finalizedAt: stamp,
    finalizedBy: "synthetic-owner",
    snapshot,
  });
  const outputLot = traceabilityLotSchema.parse({
    id: uuid(61),
    productId: uuid(51),
    tlc: input.chain.transformation.output.tlc,
    source: { kind: "location", locationId: uuid(31) },
    assignmentBasis: "transformation",
    status: "active",
    revision: 1,
    sourceLockedAt: stamp,
    createdBy: "synthetic-owner",
    updatedBy: "synthetic-owner",
    createdAt: stamp,
    updatedAt: stamp,
  });
  return {
    input,
    documents,
    createInput: { operationKey: uuid(70), draft: created.draft },
    finalizeInput: {
      operationKey: uuid(70),
      expectedDraftVersion: 1,
      expectedInputDigest: "e".repeat(64),
    },
    created,
    finalized,
    outputLot,
    inputLots: [
      { lineNo: 1, lotId: uuid(40) },
      { lineNo: 2, lotId: uuid(41) },
    ],
  };
}

describe("strict evidence", () => {
  it.each([-1, 260, 1.5, NaN, Infinity, -Infinity])("rejects invalid index %s", (index) => {
    expect(() => makeUsDatasetTransformationInput(index, references, receiving)).toThrow(
      "us_dataset_transformation_input_invalid",
    );
  });
  it("rejects another dataset", () =>
    expect(() =>
      makeUsDatasetTransformationInput(259, references, { ...receiving, datasetId: uuid(99) }),
    ).toThrow("us_dataset_transformation_dependency_conflict"));
  it.each(["datasetId", "stage", "revision", "inputDigest", "resultDigest", "operationKey"])(
    "rejects malformed receiving %s",
    (field) => {
      expect(() =>
        parseUsDatasetTransformationInput({
          ...makeUsDatasetTransformationInput(259, references, receiving),
          receiving: { ...receiving, [field]: "wrong" },
        }),
      ).toThrow();
    },
  );
  it.each(["root", "nested"])("rejects unknown %s fields", (level) => {
    const input = makeUsDatasetTransformationInput(259, references, receiving);
    expect(() =>
      parseUsDatasetTransformationInput(
        level === "root"
          ? { ...input, extra: true }
          : { ...input, receiving: { ...receiving, extra: true } },
      ),
    ).toThrow();
  });
  it("rejects getters without invoking them", () => {
    let calls = 0;
    const raw = Object.defineProperty({}, "chain", {
      enumerable: true,
      get() {
        calls++;
        throw new Error("getter ran");
      },
    });
    expect(() => parseUsDatasetTransformationInput(raw)).toThrow(
      "us_dataset_transformation_input_invalid",
    );
    expect(calls).toBe(0);
  });
  it.each(["symbol", "prototype", "cycle", "nonfinite"])("rejects unsafe %s", (kind) => {
    const raw: Record<string | symbol, unknown> = structuredClone(
      makeUsDatasetTransformationInput(259, references, receiving),
    );
    if (kind === "symbol") raw[Symbol("hidden")] = true;
    if (kind === "prototype") Object.setPrototypeOf(raw, { hidden: true });
    if (kind === "cycle") raw["extra"] = raw;
    if (kind === "nonfinite") raw["extra"] = Infinity;
    expect(() => parseUsDatasetTransformationInput(raw)).toThrow();
  });
  it("preserves 256 KiB shared guard boundary and rejects oversized intent/result", () => {
    const boundary = { a: "x".repeat(256 * 1024 - 8) };
    expect(Buffer.byteLength(JSON.stringify(boundary))).toBe(256 * 1024);
    expect(() => assertBoundedSyntheticJson(boundary)).not.toThrow();
    expect(() => assertBoundedSyntheticJson({ a: boundary.a + "x" })).toThrow(
      "us_demo_json_too_large",
    );
    expect(() =>
      parseUsDatasetTransformationInput({
        ...makeUsDatasetTransformationInput(259, references, receiving),
        extra: boundary.a,
      }),
    ).toThrow();
    expect(() => parseUsDatasetTransformationResult({ ...fixture(), extra: boundary.a })).toThrow();
  });
  it("accepts coherent native-shaped evidence and derives only newly owned IDs", () => {
    const result = parseUsDatasetTransformationResult(fixture());
    expect(usDatasetTransformationRecordIds(result)).toEqual([
      uuid(10),
      uuid(11),
      uuid(60),
      uuid(61),
    ]);
    expect(Object.isFrozen(result.finalized.snapshot.inputs)).toBe(true);
  });
  it.each([
    "missing mapping",
    "duplicate mapping",
    "reordered mapping",
    "duplicate document",
    "inbound output",
    "command key",
    "command draft",
    "command version",
    "command digest",
    "snapshot quantity",
    "snapshot document",
    "output product",
    "normalized text",
    "metadata",
    "root",
    "lifecycle",
    "reordered documents",
    "unknown native field",
    "normalized draft text",
    "output source",
    "input TLC",
    "missing lifecycle",
  ])("rejects %s evidence", (mutation) => {
    const raw = fixture();
    switch (mutation) {
      case "missing mapping":
        raw.inputLots.pop();
        break;
      case "duplicate mapping":
        raw.inputLots[1] = { ...at(raw.inputLots, 0) };
        break;
      case "reordered mapping":
        raw.inputLots.reverse();
        break;
      case "duplicate document":
        raw.documents[1] = { ...at(raw.documents, 0) };
        break;
      case "inbound output":
        raw.outputLot.id = uuid(40);
        break;
      case "command key":
        raw.finalizeInput.operationKey = uuid(71);
        break;
      case "command draft":
        raw.createInput.draft = { ...raw.created.draft, eventDate: "2026-04-01" };
        break;
      case "command version":
        raw.finalizeInput.expectedDraftVersion = 2;
        break;
      case "command digest":
        raw.finalizeInput.expectedInputDigest = "G".repeat(64);
        break;
      case "snapshot quantity":
        at(raw.finalized.snapshot.inputs, 0).quantity = "1";
        break;
      case "snapshot document":
        at(raw.finalized.snapshot.documents, 0).number = "Forged";
        break;
      case "output product":
        raw.outputLot.productId = uuid(99);
        break;
      case "normalized text":
        raw.created.createdBy = " synthetic-owner ";
        break;
      case "metadata":
        raw.created.draft.notes = "Different";
        raw.createInput.draft.notes = "Different";
        raw.finalized.snapshot.notes = "Different";
        break;
      case "root":
        if (raw.finalized.lifecycle) raw.finalized.lifecycle.rootId = uuid(99);
        break;
      case "lifecycle":
        if (raw.finalized.lifecycle) raw.finalized.lifecycle.pendingDraftId = uuid(99);
        break;
      case "reordered documents":
        raw.documents.reverse();
        break;
      case "unknown native field":
        Object.assign(raw.outputLot, { extra: true });
        break;
      case "normalized draft text":
        raw.created.draft.notes = " Synthetic six-month demo transformation. ";
        break;
      case "output source":
        raw.outputLot.source = { kind: "location", locationId: uuid(32) };
        break;
      case "input TLC": {
        const line = at(raw.finalized.snapshot.inputs, 0);
        if (line.kind === "ftl_lot") line.tlc = "FORGED-TLC";
        break;
      }
      case "missing lifecycle":
        delete raw.created.lifecycle;
        break;
    }
    expect(() => parseUsDatasetTransformationResult(raw)).toThrow(
      "us_dataset_transformation_result_invalid",
    );
  });
  it("requires complete Receiving stage and preserves error cause/context", () => {
    const cause = new Error("driver_failure");
    const error = datasetTransformationError(
      "us_dataset_transformation_mismatch",
      "chain_0259",
      cause,
    );
    expect(error.cause).toBe(cause);
    expect(error).toMatchObject({ unitKey: "chain_0259", stage: "transformation" });
    expect(() =>
      makeUsDatasetReceivingIdentity(datasetId, {
        unitKey: "chain_0259",
        stage: "receiving",
        revision: 1,
        intent: {
          unitKey: "chain_0259",
          stage: "receiving",
          operationKey: uuid(80),
          input: {},
          inputDigest: "a".repeat(64),
        },
        receipt: null,
      }),
    ).toThrow("us_dataset_transformation_prerequisite_incomplete");
  });
  it("extracts the actual completed Receiving intent and receipt digests", () => {
    const stage = receivingStage();
    const identity = makeUsDatasetReceivingIdentity(datasetId, stage);
    expect(identity).toEqual({
      ...receiving,
      inputDigest: stage.intent.inputDigest,
      resultDigest: stage.receipt.resultDigest,
    });
  });
  it("rejects a Receiving journal operation identity that differs from its actual native command", () => {
    const stage = receivingStage();
    stage.intent.operationKey = uuid(99);
    expect(() => makeUsDatasetReceivingIdentity(datasetId, stage)).toThrow(
      "us_dataset_transformation_dependency_conflict",
    );
  });
  it("rejects distinct symbolic output product substituted with the inbound product everywhere", () => {
    const raw = fixture();
    at(raw.created.draft.outputs, 0).productId = uuid(50);
    at(raw.finalized.snapshot.outputs, 0).product.id = uuid(50);
    raw.outputLot.productId = uuid(50);
    expect(() => parseUsDatasetTransformationResult(raw)).toThrow(
      "us_dataset_transformation_result_invalid",
    );
  });
  it.each([
    "dataset",
    "unit",
    "stage",
    "revision",
    "input digest",
    "result digest",
    "owned IDs",
    "intent/result",
  ])("rejects Receiving dependency %s drift", (mutation) => {
    const stage = receivingStage();
    switch (mutation) {
      case "unit":
        stage.unitKey = "chain_0258";
        break;
      case "stage":
        Object.assign(stage, { stage: "references" });
        break;
      case "revision":
        stage.revision = 3;
        break;
      case "input digest":
        stage.intent.inputDigest = "0".repeat(64);
        break;
      case "result digest":
        stage.receipt.resultDigest = "0".repeat(64);
        break;
      case "owned IDs":
        stage.receipt.recordIds.pop();
        break;
      case "intent/result":
        stage.intent.input = makeUsDatasetReceivingInput(258, references);
        stage.intent.inputDigest = canonicalExportDigest(stage.intent.input);
        break;
    }
    expect(() =>
      makeUsDatasetReceivingIdentity(mutation === "dataset" ? uuid(99) : datasetId, stage),
    ).toThrow("us_dataset_transformation_dependency_conflict");
  });
});

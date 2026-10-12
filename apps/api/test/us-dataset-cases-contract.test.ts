import { describe, expect, it } from "vitest";
import { canonicalExportDigest } from "@markiro/domain";
import {
  transformationDraftRecordSchema,
  transformationFinalizedRecordSchema,
  traceabilityLotSchema,
  referenceDocumentSchema,
  receivingOperationReceiptV2Schema,
  caseLinkResultSchema,
} from "@markiro/platform-contracts";
import { assertBoundedSyntheticJson } from "../src/modules/traceability/demo/us-demo-journal-contract";
import {
  makeUsDatasetReferenceIdentity,
  makeUsDatasetReceivingInput,
} from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import {
  makeUsDatasetReceivingIdentity,
  makeUsDatasetTransformationInput,
  parseUsDatasetTransformationResult,
} from "../src/modules/traceability/demo/us-dataset-transformation-contract";
import { makeUsSixMonthCatalogue } from "../src/modules/traceability/demo/us-six-month-references";
import { makeUsSixMonthRegularChain } from "../src/modules/traceability/demo/us-six-month-chains";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { caseCommandDigest } from "../src/modules/traceability/cases/us-case-operations";
import {
  makeUsDatasetCasesInput,
  makeUsDatasetTransformationIdentity,
  parseUsDatasetCasesInput,
  parseUsDatasetCasesResult,
  caseDemoCommandDigest,
  caseDemoAuditIdentity,
  usDatasetCasesRecordIds,
  datasetCasesError,
  type UsDatasetCasesInput,
  type UsDatasetCasesResult,
} from "../src/modules/traceability/demo/us-dataset-cases-contract";

const datasetId = "00000000-0000-4000-8000-000000000001";
type Mutable<T> = { -readonly [P in keyof T]: Mutable<T[P]> };
function mutable<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-10-07T12:00:00.000Z";
function at<T>(rows: readonly T[], index: number): T {
  const value = rows[index];
  if (value === undefined) throw new Error("missing test fixture row");
  return value;
}
function receivingStage(index = 259) {
  const input = makeUsDatasetReceivingInput(index, references);
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
    operationKey: uuid(3),
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
    unitKey: input.chain.unitKey,
    stage: "receiving" as const,
    revision: 2,
    intent: {
      unitKey: input.chain.unitKey,
      stage: "receiving" as const,
      operationKey: uuid(3),
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
function transformationResult(index = 259) {
  const input = makeUsDatasetTransformationInput(
    index,
    references,
    makeUsDatasetReceivingIdentity(datasetId, receivingStage(index)),
  );
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
        quantity: input.chain.transformation.output.quantity,
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
        quantity: input.chain.transformation.output.quantity,
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

function referenceResult() {
  const catalogue = makeUsSixMonthCatalogue();
  const parties = catalogue.parties.map(({ key }, index) => ({ key, id: uuid(index + 1001) }));
  const locations = catalogue.locations.map(({ key }, index) => ({ key, id: uuid(index + 1024) }));
  const products = catalogue.products.map(({ key }, index) => ({ key, id: uuid(index + 1047) }));
  return {
    version: usSixMonthDefinition.version,
    definitionDigest: usSixMonthDefinition.digest,
    bindings: { parties, locations, products },
    evidence: {
      parties: catalogue.parties.map(({ input }, index) => ({
        ...input,
        id: parties[index]?.id,
        archived: false,
        createdAt: stamp,
        updatedAt: stamp,
      })),
      locations: catalogue.locations.map(({ input, partyKey }, index) => ({
        ...input,
        id: locations[index]?.id,
        partyId: parties.find(({ key }) => key === partyKey)?.id,
        archived: false,
        createdAt: stamp,
        updatedAt: stamp,
        descriptionStatus: { exportReady: true, issues: [] },
      })),
      products: catalogue.products.map(({ input }, index) => ({
        id: products[index]?.id,
        name: input.name,
        gtin14: null,
        archived: false,
        createdAt: stamp,
        updatedAt: stamp,
      })),
      profiles: catalogue.products.map(({ profile }, index) => {
        const { expectedRevision: _revision, ...editable } = profile;
        void _revision;
        return {
          ...editable,
          packagingSizeValue: `${profile.packagingSizeValue}.000`,
          productId: products[index]?.id,
          revision: 1,
          reviewedBy: uuid(99),
          reviewedAt: stamp,
          createdAt: stamp,
          updatedAt: stamp,
        };
      }),
    },
  };
}

function referenceStage() {
  const input = {
    version: usSixMonthDefinition.version,
    definitionDigest: usSixMonthDefinition.digest,
    catalogue: makeUsSixMonthCatalogue(),
  };
  const result = referenceResult();
  return {
    unitKey: "references",
    stage: "references" as const,
    revision: 2,
    intent: {
      unitKey: "references",
      stage: "references" as const,
      operationKey: uuid(2),
      input,
      inputDigest: canonicalExportDigest(input),
    },
    receipt: {
      recordIds: [
        ...result.bindings.parties,
        ...result.bindings.locations,
        ...result.bindings.products,
      ].map(({ id }) => id),
      result,
      resultDigest: canonicalExportDigest(result),
    },
  };
}
const references = makeUsDatasetReferenceIdentity(datasetId, referenceStage());
function transformationStage(index = 259) {
  const result = mutable(transformationResult(index));
  const input = mutable(result.input);
  return {
    unitKey: input.chain.unitKey,
    stage: "transformation" as const,
    revision: 2,
    intent: {
      unitKey: input.chain.unitKey,
      stage: "transformation" as const,
      operationKey: uuid(70),
      input,
      inputDigest: canonicalExportDigest(input),
    },
    receipt: {
      recordIds: [uuid(10), uuid(11), uuid(60), uuid(61)],
      result,
      resultDigest: canonicalExportDigest(result),
    },
  };
}
function support(index = 259) {
  return {
    capturedAt: "2027-01-01T00:01:00.000Z",
    shiftId: uuid(200),
    numberMonthKey: "JAN27",
    numberSeq: index + 1,
    boxes: makeUsSixMonthRegularChain(index).cases.map((sscc, i) => ({
      id: uuid(300 + i),
      deviceBoxId: `dataset-chain-${index}-box-${i}`,
      sscc,
    })),
  };
}
function input(index = 259): UsDatasetCasesInput {
  return makeUsDatasetCasesInput(
    index,
    datasetId,
    referenceStage(),
    receivingStage(index),
    transformationStage(index),
    support(index),
  );
}
function result(index = 259): Mutable<UsDatasetCasesResult> {
  const intent = mutable(input(index));
  return {
    input: intent,
    operationKey: uuid(500),
    requestId: "synthetic-case-request",
    support: {
      shift: {
        id: intent.support.shiftId,
        productId: intent.outputProductId,
        status: "planned",
        mode: "aggregation",
        numberMonthKey: "JAN27",
        numberSeq: index + 1,
        createdAt: stamp,
      },
      boxes: intent.support.boxes.map((b) => ({
        ...b,
        shiftId: intent.support.shiftId,
        openedAt: stamp,
      })),
      markers: intent.support.boxes.map((b) => ({
        boxId: b.id,
        seedId: datasetId,
        seedVersion: 1,
        createdAt: stamp,
      })),
    },
    linked: caseLinkResultSchema.parse({
      lotId: intent.outputLotId,
      unchanged: [],
      created: [...intent.support.boxes]
        .sort((a, b) => a.sscc.localeCompare(b.sscc) || a.id.localeCompare(b.id))
        .map((b, i) => ({
          linkId: uuid(600 + i),
          boxId: b.id,
          lotId: intent.outputLotId,
          ssccAtLink: b.sscc,
          linkSource: "demo_seed",
          provenance: "synthetic_demo",
          linkedAt: stamp,
          linkedBy: "synthetic-owner",
          unlinkedAt: null,
          unlinkedBy: null,
          unlinkReason: null,
          originState: "current",
          ssccState: "consistent",
        })),
    }),
  };
}
describe("strict Cases capture", () => {
  it.each([0, 133, 259])("binds native-shaped prerequisites for regular chain %s", (index) => {
    const parsed = input(index);
    expect(parsed.index).toBe(index);
    expect(parsed.outputLotId).toBe(uuid(61));
    expect(parsed.outputProductId).toBe(uuid(51));
    expect(parsed.support.boxes.map((b) => b.sscc)).toEqual(
      makeUsSixMonthRegularChain(index).cases,
    );
    expect(Object.isFrozen(parsed.support.boxes)).toBe(true);
  });
  it.each([-1, 260, 0.5, NaN, Infinity, -Infinity])("rejects invalid index %s", (index) => {
    expect(() =>
      makeUsDatasetCasesInput(
        index,
        datasetId,
        referenceStage(),
        receivingStage(),
        transformationStage(),
        support(),
      ),
    ).toThrow("us_dataset_cases_input_invalid");
  });
  it("derives the complete Transformation identity from the stage", () => {
    const stage = transformationStage();
    expect(makeUsDatasetTransformationIdentity(datasetId, stage)).toEqual({
      datasetId,
      unitKey: "chain_0259",
      stage: "transformation",
      revision: 2,
      operationKey: uuid(70),
      inputDigest: canonicalExportDigest(stage.intent.input),
      resultDigest: canonicalExportDigest(stage.receipt.result),
    });
  });
  it.each([
    "unit",
    "stage",
    "revision",
    "intent unit",
    "intent stage",
    "operation",
    "input digest",
    "result digest",
    "owned IDs",
    "intent result",
    "reference identity",
    "receiving identity",
    "inbound output",
    "output product",
    "extra stage",
  ])("rejects upstream %s drift", (mutation) => {
    const stage = transformationStage();
    switch (mutation) {
      case "unit":
        stage.unitKey = "chain_0258";
        break;
      case "stage":
        Object.assign(stage, { stage: "receiving" });
        break;
      case "revision":
        stage.revision = 3;
        break;
      case "intent unit":
        stage.intent.unitKey = "chain_0258";
        break;
      case "intent stage":
        Object.assign(stage.intent, { stage: "cases" });
        break;
      case "operation":
        stage.intent.operationKey = uuid(999);
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
      case "intent result":
        Object.assign(stage.intent.input, { definitionDigest: "0".repeat(64) });
        stage.intent.inputDigest = canonicalExportDigest(stage.intent.input);
        break;
      case "reference identity":
        Object.assign(stage.receipt.result.input.references, { resultDigest: "0".repeat(64) });
        break;
      case "receiving identity":
        Object.assign(stage.receipt.result.input.receiving, { resultDigest: "0".repeat(64) });
        break;
      case "inbound output":
        stage.receipt.result.outputLot.id = uuid(40);
        break;
      case "output product":
        stage.receipt.result.outputLot.productId = uuid(50);
        break;
      case "extra stage":
        Object.assign(stage, { extra: true });
        break;
    }
    expect(() =>
      makeUsDatasetCasesInput(259, datasetId, referenceStage(), receivingStage(), stage, support()),
    ).toThrow("us_dataset_cases_dependency_conflict");
  });
  it.each(["references", "receiving", "transformation"])("requires completed %s", (which) => {
    const refs = referenceStage(),
      recv = receivingStage(),
      trans = transformationStage();
    const stage = which === "references" ? refs : which === "receiving" ? recv : trans;
    Object.assign(stage, { revision: 1, receipt: null });
    expect(() => makeUsDatasetCasesInput(259, datasetId, refs, recv, trans, support())).toThrow(
      "us_dataset_cases_prerequisite_incomplete",
    );
  });
  it("rejects another dataset or regular unit", () => {
    expect(() =>
      makeUsDatasetCasesInput(
        259,
        uuid(999),
        referenceStage(),
        receivingStage(),
        transformationStage(),
        support(),
      ),
    ).toThrow("us_dataset_cases_dependency_conflict");
    expect(() =>
      makeUsDatasetCasesInput(
        0,
        datasetId,
        referenceStage(),
        receivingStage(),
        transformationStage(),
        support(0),
      ),
    ).toThrow("us_dataset_cases_dependency_conflict");
  });
  it.each(["references", "receiving", "input lot"] as const)(
    "rejects coherent but mismatched %s upstream binding",
    (which) => {
      const stage = transformationStage();
      if (which === "input lot") {
        at(stage.receipt.result.inputLots, 0).lotId = uuid(999);
        Object.assign(at(stage.receipt.result.created.draft.inputs, 0), { lotId: uuid(999) });
        Object.assign(at(stage.receipt.result.finalized.snapshot.inputs, 0), { lotId: uuid(999) });
      } else {
        stage.receipt.result.input[which].resultDigest = "0".repeat(64);
      }
      stage.intent.input = mutable(stage.receipt.result.input);
      stage.intent.inputDigest = canonicalExportDigest(stage.intent.input);
      stage.receipt.resultDigest = canonicalExportDigest(stage.receipt.result);
      expect(() => parseUsDatasetTransformationResult(stage.receipt.result)).not.toThrow();
      expect(() =>
        makeUsDatasetCasesInput(
          259,
          datasetId,
          referenceStage(),
          receivingStage(),
          stage,
          support(),
        ),
      ).toThrow("us_dataset_cases_dependency_conflict");
    },
  );
  it.each(["references", "receiving"])("rejects changed %s command identity", (which) => {
    const refs = referenceStage(),
      recv = receivingStage();
    if (which === "references") refs.intent.operationKey = uuid(999);
    else recv.intent.operationKey = uuid(999);
    expect(() =>
      makeUsDatasetCasesInput(259, datasetId, refs, recv, transformationStage(), support()),
    ).toThrow("us_dataset_cases_dependency_conflict");
  });
  it.each([
    "dataset",
    "unit",
    "revision",
    "stage",
    "digest",
    "SSCC order",
    "SSCC check digit",
    "duplicate SSCC",
    "missing box",
    "empty boxes",
    "extra box",
    "duplicate box",
    "duplicate device",
    "shift box",
    "sequence",
    "capture ISO",
    "capture calendar",
    "month",
    "year",
    "extra field",
    "nested field",
    "normalized device",
    "uppercase UUID",
  ])("rejects captured %s", (mutation) => {
    const raw = mutable(input());
    const first = at(raw.support.boxes, 0),
      second = at(raw.support.boxes, 1);
    switch (mutation) {
      case "dataset":
        raw.receiving.datasetId = uuid(999);
        break;
      case "unit":
        raw.transformation.unitKey = "chain_0258";
        break;
      case "revision":
        Object.assign(raw.references, { revision: 1 });
        break;
      case "stage":
        Object.assign(raw.transformation, { stage: "receiving" });
        break;
      case "digest":
        raw.definitionDigest = "0".repeat(64);
        break;
      case "SSCC order":
        raw.support.boxes = [...raw.support.boxes].reverse();
        break;
      case "SSCC check digit":
        first.sscc = first.sscc.slice(0, -1) + (first.sscc.endsWith("0") ? "1" : "0");
        break;
      case "duplicate SSCC":
        second.sscc = first.sscc;
        break;
      case "missing box":
        raw.support.boxes = raw.support.boxes.slice(1);
        break;
      case "empty boxes":
        raw.support.boxes = [];
        break;
      case "extra box":
        raw.support.boxes = [...raw.support.boxes, first];
        break;
      case "duplicate box":
        second.id = first.id;
        break;
      case "duplicate device":
        second.deviceBoxId = first.deviceBoxId;
        break;
      case "shift box":
        first.id = raw.support.shiftId;
        break;
      case "sequence":
        raw.support.numberSeq = 259;
        break;
      case "capture ISO":
        raw.support.capturedAt = "2027-01-01T00:01:00+00:00";
        break;
      case "capture calendar":
        raw.support.capturedAt = "2027-02-30T00:01:00.000Z";
        break;
      case "month":
        raw.support.numberMonthKey = "DEC26";
        break;
      case "year":
        raw.support.numberMonthKey = "JAN26";
        break;
      case "extra field":
        Object.assign(raw, { extra: true });
        break;
      case "nested field":
        Object.assign(first, { extra: true });
        break;
      case "normalized device":
        first.deviceBoxId = " " + first.deviceBoxId + " ";
        break;
      case "uppercase UUID":
        first.id = "ABCDEFAB-0000-4000-8000-000000000001";
        break;
    }
    expect(() => parseUsDatasetCasesInput(raw)).toThrow("us_dataset_cases_input_invalid");
  });
  it("uses UTC capture month and actual year at the Los Angeles date boundary", () => {
    const raw = mutable(input());
    raw.support.capturedAt = "2031-03-01T00:01:00.000Z";
    raw.support.numberMonthKey = "MAR31";
    expect(parseUsDatasetCasesInput(raw).support.numberMonthKey).toBe("MAR31");
  });
  it.each([
    "root getter",
    "nested getter",
    "symbol",
    "cycle",
    "prototype",
    "array prototype",
    "nonfinite",
  ])("rejects unsafe %s without invoking accessors", (kind) => {
    const raw = mutable(input());
    let calls = 0;
    if (kind === "root getter")
      Object.defineProperty(raw, "codec", {
        enumerable: true,
        get() {
          calls++;
          return "us-dataset-cases-v1";
        },
      });
    if (kind === "nested getter")
      Object.defineProperty(at(raw.support.boxes, 0), "id", {
        enumerable: true,
        get() {
          calls++;
          return uuid(300);
        },
      });
    if (kind === "symbol") Object.assign(raw, { [Symbol("hidden")]: true });
    if (kind === "cycle") Object.assign(raw, { extra: raw });
    if (kind === "prototype") Object.setPrototypeOf(raw, { hidden: true });
    if (kind === "array prototype")
      Object.setPrototypeOf(raw.support.boxes, Object.create(Array.prototype));
    if (kind === "nonfinite") Object.assign(raw, { extra: Infinity });
    expect(() => parseUsDatasetCasesInput(raw)).toThrow("us_dataset_cases_input_invalid");
    expect(calls).toBe(0);
  });
});
describe("Cases receipt", () => {
  it.each(["root", "nested"])("rejects %s result getters without invoking them", (where) => {
    const raw = result();
    let calls = 0;
    Object.defineProperty(
      where === "root" ? raw : raw.support.shift,
      where === "root" ? "operationKey" : "id",
      {
        enumerable: true,
        get() {
          calls++;
          return uuid(200);
        },
      },
    );
    expect(() => parseUsDatasetCasesResult(raw)).toThrow("us_dataset_cases_result_invalid");
    expect(calls).toBe(0);
  });
  it("rejects upstream stage accessors before diagnostic reads", () => {
    const stage = transformationStage();
    let calls = 0;
    Object.defineProperty(stage, "unitKey", {
      enumerable: true,
      get() {
        calls++;
        return "chain_0259";
      },
    });
    expect(() => makeUsDatasetTransformationIdentity(datasetId, stage)).toThrow(
      "us_dataset_cases_dependency_conflict",
    );
    expect(calls).toBe(0);
  });
  it("returns only owned shift, boxes in support order and links in service order", () => {
    const raw = result();
    expect(usDatasetCasesRecordIds(raw)).toEqual([
      uuid(200),
      ...Array.from({ length: 100 }, (_, i) => uuid(300 + i)),
      ...Array.from({ length: 100 }, (_, i) => uuid(600 + i)),
    ]);
    expect(parseUsDatasetCasesResult(raw)).toEqual(raw);
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThan(256 * 1024);
    expect(Object.isFrozen(parseUsDatasetCasesResult(raw).linked.created)).toBe(true);
  });
  it("retains the exact ascending Scenario A SSCC order", () => {
    const raw = result(259);
    expect(raw.linked.created).toHaveLength(100);
    expect(at(raw.linked.created, 0).ssccAtLink).toBe("999999990000000013");
    expect(at(raw.linked.created, 99).ssccAtLink).toBe("999999990000001003");
    expect(raw.linked.created.map((b) => b.ssccAtLink)).toEqual(
      [...makeUsSixMonthRegularChain(259).cases].sort(),
    );
    expect(() => parseUsDatasetCasesResult(raw)).not.toThrow();
  });
  it.each([
    "shift",
    "shift product",
    "status",
    "mode",
    "number",
    "shift time",
    "box",
    "box shift",
    "box device",
    "box SSCC",
    "box time",
    "marker box",
    "marker dataset",
    "marker version",
    "marker time",
    "missing marker",
    "marker order",
    "link box",
    "link lot",
    "link SSCC",
    "manual",
    "provenance",
    "origin gap",
    "inconsistent",
    "unlinked",
    "actor",
    "different actor",
    "time",
    "duplicate link",
    "link order",
    "missing link",
    "unchanged",
    "operation",
    "request",
    "normalized actor",
    "unknown field",
  ])("rejects %s receipt evidence", (mutation) => {
    const raw = result();
    const box = at(raw.support.boxes, 0),
      marker = at(raw.support.markers, 0),
      link = at(raw.linked.created, 0);
    switch (mutation) {
      case "shift":
        raw.support.shift.id = uuid(999);
        break;
      case "shift product":
        raw.support.shift.productId = uuid(50);
        break;
      case "status":
        Object.assign(raw.support.shift, { status: "closed" });
        break;
      case "mode":
        Object.assign(raw.support.shift, { mode: "production" });
        break;
      case "number":
        raw.support.shift.numberMonthKey = "SEP26";
        break;
      case "shift time":
        raw.support.shift.createdAt = "2026-09-31T00:00:00.000Z";
        break;
      case "box":
        box.id = uuid(999);
        break;
      case "box shift":
        box.shiftId = uuid(999);
        break;
      case "box device":
        box.deviceBoxId = "another-device";
        break;
      case "box SSCC":
        box.sscc = at(raw.support.boxes, 1).sscc;
        break;
      case "box time":
        box.openedAt = "2026-10-07T12:00:00+00:00";
        break;
      case "marker box":
        marker.boxId = uuid(999);
        break;
      case "marker dataset":
        marker.seedId = uuid(999);
        break;
      case "marker version":
        Object.assign(marker, { seedVersion: 2 });
        break;
      case "marker time":
        marker.createdAt = "recipe-day";
        break;
      case "missing marker":
        raw.support.markers.pop();
        break;
      case "marker order":
        raw.support.markers.reverse();
        break;
      case "link box":
        link.boxId = uuid(999);
        break;
      case "link lot":
        link.lotId = uuid(40);
        break;
      case "link SSCC":
        link.ssccAtLink = at(raw.linked.created, 1).ssccAtLink;
        break;
      case "manual":
        link.linkSource = "manual";
        break;
      case "provenance":
        link.provenance = "existing_record";
        break;
      case "origin gap":
        link.originState = "gap";
        break;
      case "inconsistent":
        link.ssccState = "inconsistent";
        break;
      case "unlinked":
        link.unlinkedAt = stamp;
        break;
      case "actor":
        link.linkedBy = "";
        break;
      case "different actor":
        at(raw.linked.created, 1).linkedBy = "another-actor";
        break;
      case "time":
        link.linkedAt = "2026-10-07T12:00:00+00:00";
        break;
      case "duplicate link":
        at(raw.linked.created, 1).linkId = link.linkId;
        break;
      case "link order":
        raw.linked.created.reverse();
        break;
      case "missing link":
        raw.linked.created.pop();
        break;
      case "unchanged":
        raw.linked.unchanged.push(link);
        break;
      case "operation":
        raw.operationKey = "invalid";
        break;
      case "request":
        raw.requestId = " ";
        break;
      case "normalized actor":
        link.linkedBy = " synthetic-owner ";
        break;
      case "unknown field":
        Object.assign(link, { extra: true });
        break;
    }
    expect(() => parseUsDatasetCasesResult(raw)).toThrow("us_dataset_cases_result_invalid");
  });
  it("preserves the 256 KiB guard boundary and refuses larger intent/result", () => {
    const boundary = { a: "x".repeat(256 * 1024 - 8) };
    expect(Buffer.byteLength(JSON.stringify(boundary))).toBe(256 * 1024);
    expect(() => assertBoundedSyntheticJson(boundary)).not.toThrow();
    expect(() => assertBoundedSyntheticJson({ a: boundary.a + "x" })).toThrow(
      "us_demo_json_too_large",
    );
    expect(() => parseUsDatasetCasesInput({ ...input(), extra: boundary.a })).toThrow(
      "us_dataset_cases_input_invalid",
    );
    expect(() => parseUsDatasetCasesResult({ ...result(), extra: boundary.a })).toThrow(
      "us_dataset_cases_result_invalid",
    );
  });
});
describe("Cases demo identity", () => {
  it("hashes the independent v2 source and seed envelope and differs from manual", () => {
    const captured = input();
    const seed = {
      datasetId,
      recipeVersion: "us-processor-six-month-v1",
      recipeDigest: usSixMonthDefinition.digest,
      unitKey: "chain_0259",
      intentDigest: canonicalExportDigest(captured),
    };
    expect(caseDemoAuditIdentity(captured)).toEqual(seed);
    const ssccs = captured.support.boxes.map((b) => b.sscc).sort();
    expect(caseDemoCommandDigest(captured)).toBe(
      canonicalExportDigest({
        commandVersion: 2,
        command: "case.link",
        source: "demo_seed",
        lotId: uuid(61),
        input: { ssccs },
        seed,
      }),
    );
    expect(caseDemoCommandDigest(captured)).not.toBe(
      caseCommandDigest("case.link", uuid(61), { ssccs }),
    );
    const changed = mutable(captured);
    changed.support.capturedAt = "2030-01-01T00:00:00.000Z";
    changed.support.numberMonthKey = "JAN30";
    expect(caseDemoCommandDigest(changed)).not.toBe(caseDemoCommandDigest(captured));
    const other = mutable(captured);
    other.references.datasetId = uuid(999);
    other.receiving.datasetId = uuid(999);
    other.transformation.datasetId = uuid(999);
    expect(caseDemoCommandDigest(other)).not.toBe(caseDemoCommandDigest(captured));
    expect(caseDemoCommandDigest(input(0))).not.toBe(caseDemoCommandDigest(captured));
  });
  it("retains original cause and only bounded unit/stage context", () => {
    const cause = new Error("driver_failure");
    const error = datasetCasesError("us_dataset_cases_mismatch", "chain_0259", cause);
    expect(error.cause).toBe(cause);
    expect(error).toMatchObject({ unitKey: "chain_0259", stage: "cases" });
    expect(Object.keys(error).sort()).toEqual(["stage", "unitKey"]);
    expect(datasetCasesError("us_dataset_cases_mismatch", "x".repeat(1000)).unitKey).toBe(
      "unknown",
    );
  });
});

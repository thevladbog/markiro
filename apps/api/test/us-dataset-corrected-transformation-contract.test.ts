import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import {
  makeUsDatasetCorrectedCasesInput,
  parseUsDatasetCorrectedCasesInput,
} from "../src/modules/traceability/demo/us-dataset-corrected-cases-contract";
import {
  parseUsDatasetCorrectedTransformationResult,
  usDatasetCorrectedTransformationRecordIds,
} from "../src/modules/traceability/demo/us-dataset-corrected-transformation-result";
import {
  makeUsSixMonthSpecialExamples,
  usSixMonthDefinition,
} from "../src/modules/traceability/demo/us-six-month-definition";
import { datasetCorrectedTransformationError } from "../src/modules/traceability/demo/us-dataset-corrected-transformation-contract";
import { specialFixture } from "./support/us-dataset-special-fixture";
import { prepareDatasetCorrectedTransformation } from "./support/us-dataset-corrected-transformation-fixture";
import { UsDatasetCorrectedTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-transformation-seed";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { makeUsDatasetReferenceIdentity } from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetSpecialSeedStore } from "../src/modules/traceability/demo/us-dataset-special-seed";
import { makeUsDatasetSpecialInput } from "../src/modules/traceability/demo/us-dataset-special-contract";

const uuid = (n: number) => `abcdefab-1234-4234-8234-${String(n).padStart(12, "0")}`;
const stamp = "2026-10-09T12:00:00.000Z";
function at<T>(rows: readonly T[], index: number): T {
  const row = rows[index];
  if (row === undefined) throw new Error("Missing corrected fixture row");
  return row;
}
function fixture() {
  const input = {
    codec: "us-dataset-corrected-transformation-input-v1",
    version: "us-processor-six-month-v1",
    definitionDigest: usSixMonthDefinition.digest,
    references: {
      datasetId: uuid(1),
      unitKey: "references",
      stage: "references",
      revision: 2,
      operationKey: uuid(2),
      inputDigest: "a".repeat(64),
      resultDigest: "b".repeat(64),
    },
    amendment: {
      datasetId: uuid(1),
      unitKey: "correction_0001",
      stage: "amend_receiving",
      revision: 2,
      operationKey: uuid(3),
      inputDigest: "c".repeat(64),
      resultDigest: "d".repeat(64),
    },
    receivingOrigin: {
      rootId: uuid(90),
      eventId: uuid(91),
      revision: 2,
      lifecycleVersion: 4,
      inputLots: [
        { lineNo: 1, lotId: uuid(40) },
        { lineNo: 2, lotId: uuid(41) },
      ],
    },
    chain: makeUsSixMonthSpecialExamples().correction.correctedChain,
  };
  const documents = input.chain.transformation.references.map((number, i) => {
    const definition = input.chain.documents.find((d) => d.input.number === number);
    if (!definition) throw new Error("Missing corrected fixture document");
    return {
      key: definition.key,
      record: {
        ...definition.input,
        id: uuid(10 + i),
        partyId: uuid(30),
        archivedAt: null,
        createdBy: "synthetic-owner",
        createdAt: stamp,
        updatedAt: stamp,
      },
    };
  });
  const draft = {
    eventDate: "2026-06-11",
    processorLocationId: uuid(31),
    reason: "commingling_and_repacking",
    reasonNote: null,
    notes: "Synthetic six-month demo transformation.",
    inputs: [
      { kind: "ftl_lot", lotId: uuid(40), quantity: "300", unitOfMeasure: "lb" },
      { kind: "ftl_lot", lotId: uuid(41), quantity: "400", unitOfMeasure: "lb" },
    ],
    outputs: [
      {
        productId: uuid(51),
        tlc: input.chain.transformation.output.tlc,
        quantity: "60",
        unitOfMeasure: "case",
      },
    ],
    documentIds: documents.map((d) => d.record.id),
  };
  const lifecycle = {
    rootId: uuid(60),
    lifecycleVersion: 1,
    currentEventId: null as string | null,
    pendingDraftId: uuid(60) as string | null,
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
  const created = { ...base, lifecycle, status: "draft", draft };
  const finalized = {
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
    snapshot: {
      snapshotVersion: 1,
      eventId: uuid(60),
      eventNumber: "TRN-26-0001",
      revision: 1,
      eventDate: "2026-06-11",
      timeZone: "America/Los_Angeles",
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
        quantity: i === 0 ? "300" : "400",
        unitOfMeasure: "lb",
      })),
      outputs: [
        {
          lineNo: 1,
          lotId: uuid(61),
          product: { id: uuid(51), description: "Synthetic output", coverage },
          tlc: input.chain.transformation.output.tlc,
          source: { kind: "location", id: uuid(31), description: "Synthetic processor" },
          quantity: "60",
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
    },
  };
  const outputLot = {
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
  };
  return {
    input,
    documents,
    createInput: { operationKey: uuid(70), draft: structuredClone(draft) },
    finalizeInput: {
      operationKey: uuid(70),
      expectedDraftVersion: 1,
      expectedInputDigest: "e".repeat(64),
    },
    created,
    finalized,
    outputLot,
    inputLots: structuredClone(input.receivingOrigin.inputLots),
  };
}

describe("corrected Transformation result codec", () => {
  // Break caught: missing corrected-result parser or changed evidence content.
  it("accepts amended 300/400 lb evidence and only four newly owned records", () => {
    const raw = fixture();
    const parsed = parseUsDatasetCorrectedTransformationResult(raw);
    expect(parsed).toEqual(raw);
    expect(usDatasetCorrectedTransformationRecordIds(parsed)).toEqual([
      uuid(10),
      uuid(11),
      uuid(60),
      uuid(61),
    ]);
  });
  // Break caught: retaining caller-owned objects or freezing caller evidence.
  it("returns an independent deeply frozen copy and leaves caller evidence mutable", () => {
    const raw = fixture();
    const before = structuredClone(raw);
    const parsed = parseUsDatasetCorrectedTransformationResult(raw);
    expect(parsed).not.toBe(raw);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.finalized.snapshot.inputs)).toBe(true);
    expect(Object.isFrozen(parsed.input.receivingOrigin.inputLots[0])).toBe(true);
    expect(Object.isFrozen(parsed.documents[0]?.record)).toBe(true);
    expect(parsed.finalized.snapshot.inputs).not.toBe(raw.finalized.snapshot.inputs);
    expect(raw).toEqual(before);
    expect(Object.isFrozen(raw.finalized.snapshot.inputs)).toBe(false);
    at(raw.finalized.snapshot.inputs, 0).quantity = "1";
    expect(parsed.finalized.snapshot.inputs[0]?.quantity).toBe("300");
  });
  // Break caught: adopting an upstream Receiving root/current event as a newly owned record.
  it.each([
    ["transformation", "rootId"],
    ["transformation", "eventId"],
    ["first document", "rootId"],
    ["first document", "eventId"],
    ["second document", "rootId"],
    ["second document", "eventId"],
    ["output lot", "rootId"],
    ["output lot", "eventId"],
  ] as const)("rejects self-consistent %s identity overlapping Receiving %s", (owned, upstream) => {
    const raw = fixture();
    const alias = raw.input.receivingOrigin[upstream];
    if (owned === "transformation") {
      raw.created.id =
        raw.finalized.id =
        raw.finalized.snapshot.eventId =
        raw.created.lifecycle.rootId =
        raw.finalized.lifecycle.rootId =
        raw.created.lifecycle.pendingDraftId =
        raw.finalized.lifecycle.currentEventId =
          alias;
    } else if (owned === "output lot") {
      raw.outputLot.id = at(raw.finalized.snapshot.outputs, 0).lotId = alias;
    } else {
      const index = owned === "first document" ? 0 : 1;
      at(raw.documents, index).record.id =
        raw.created.draft.documentIds[index] =
        raw.createInput.draft.documentIds[index] =
        at(raw.finalized.snapshot.documents, index).id =
          alias;
    }
    expect(() => parseUsDatasetCorrectedTransformationResult(raw)).toThrow(
      "us_dataset_corrected_transformation_result_invalid",
    );
  });
  // Break caught: omission of native coherence, amended mapping or strict-shape checks.
  it.each([
    "codec",
    "unknown root",
    "unknown native",
    "original quantity",
    "quantity",
    "input UOM",
    "output UOM",
    "date",
    "document",
    "document order",
    "source",
    "product",
    "output identity",
    "mapping",
    "mapping order",
    "missing mapping",
    "native lifecycle",
    "native revision",
    "operation",
    "operation alias",
    "root alias",
    "document alias",
    "mapping alias",
    "output alias",
    "actor",
    "metadata",
    "native command",
    "missing lifecycle",
  ])("rejects %s drift with fixed safe context and a cause", (mutation) => {
    const raw = fixture();
    switch (mutation) {
      case "codec":
        raw.input.codec = "us-dataset-transformation-v1";
        break;
      case "unknown root":
        Object.assign(raw, { extra: true });
        break;
      case "unknown native":
        Object.assign(raw.outputLot, { extra: true });
        break;
      case "original quantity":
      case "quantity":
        at(raw.created.draft.inputs, 0).quantity =
          at(raw.createInput.draft.inputs, 0).quantity =
          at(raw.finalized.snapshot.inputs, 0).quantity =
            mutation === "original quantity" ? "250" : "301";
        break;
      case "input UOM":
        at(raw.finalized.snapshot.inputs, 0).unitOfMeasure = "kg";
        break;
      case "output UOM":
        at(raw.finalized.snapshot.outputs, 0).unitOfMeasure = "lb";
        break;
      case "date":
        raw.created.draft.eventDate =
          raw.createInput.draft.eventDate =
          raw.finalized.snapshot.eventDate =
            "2026-06-10";
        break;
      case "document":
        at(raw.documents, 0).record.number = at(raw.finalized.snapshot.documents, 0).number =
          "Forged";
        break;
      case "document order":
        raw.documents.reverse();
        break;
      case "source":
        raw.outputLot.source.locationId = uuid(32);
        break;
      case "product":
        raw.outputLot.productId =
          at(raw.created.draft.outputs, 0).productId =
          at(raw.createInput.draft.outputs, 0).productId =
          at(raw.finalized.snapshot.outputs, 0).product.id =
            uuid(50);
        break;
      case "output identity":
        raw.outputLot.id = at(raw.finalized.snapshot.outputs, 0).lotId = uuid(40);
        break;
      case "mapping":
        raw.inputLots[0] = { lineNo: 1, lotId: uuid(42) };
        at(raw.created.draft.inputs, 0).lotId =
          at(raw.createInput.draft.inputs, 0).lotId =
          at(raw.finalized.snapshot.inputs, 0).lotId =
            uuid(42);
        break;
      case "mapping order":
        raw.inputLots.reverse();
        break;
      case "missing mapping":
        raw.inputLots.pop();
        break;
      case "native lifecycle":
        raw.finalized.lifecycle.lifecycleVersion = 4;
        break;
      case "native revision":
        raw.created.revision = raw.finalized.revision = raw.finalized.snapshot.revision = 2;
        break;
      case "operation":
        raw.finalizeInput.operationKey = uuid(71);
        break;
      case "operation alias":
        raw.createInput.operationKey = raw.finalizeInput.operationKey = uuid(70).toUpperCase();
        break;
      case "root alias":
        raw.created.id =
          raw.finalized.id =
          raw.finalized.snapshot.eventId =
          raw.created.lifecycle.rootId =
          raw.finalized.lifecycle.rootId =
            uuid(60).toUpperCase();
        raw.created.lifecycle.pendingDraftId = raw.finalized.lifecycle.currentEventId =
          uuid(60).toUpperCase();
        break;
      case "document alias":
        at(raw.documents, 0).record.id = at(raw.created.draft.documentIds, 0).toUpperCase();
        raw.created.draft.documentIds[0] =
          raw.createInput.draft.documentIds[0] =
          at(raw.finalized.snapshot.documents, 0).id =
            at(raw.documents, 0).record.id;
        break;
      case "mapping alias":
        at(raw.inputLots, 0).lotId =
          at(raw.created.draft.inputs, 0).lotId =
          at(raw.createInput.draft.inputs, 0).lotId =
          at(raw.finalized.snapshot.inputs, 0).lotId =
            uuid(40).toUpperCase();
        break;
      case "output alias":
        raw.outputLot.id = at(raw.finalized.snapshot.outputs, 0).lotId = uuid(61).toUpperCase();
        break;
      case "actor":
        raw.finalized.finalizedBy = "another-actor";
        break;
      case "metadata":
        raw.created.draft.notes =
          raw.createInput.draft.notes =
          raw.finalized.snapshot.notes =
            "Different";
        break;
      case "native command":
        raw.finalizeInput.expectedDraftVersion = 2;
        break;
      case "missing lifecycle":
        Reflect.deleteProperty(raw.created, "lifecycle");
        break;
    }
    let failure: unknown;
    try {
      parseUsDatasetCorrectedTransformationResult(raw);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message: "us_dataset_corrected_transformation_result_invalid",
      unitKey: "correction_0001",
      stage: "transformation",
      cause: expect.anything(),
    });
  });
  // Break caught: evaluating caller accessors/iterators before safe bounded JSON validation.
  it.each([
    "getter",
    "array prototype",
    "array accessor",
    "symbol",
    "cycle",
    "nonfinite",
    "oversize",
    "depth",
    "nonobject",
  ])("rejects unsafe %s before caller code runs", (kind) => {
    const raw = fixture();
    let calls = 0;
    let candidate: unknown = raw;
    if (kind === "getter")
      Object.defineProperty(raw, "input", {
        enumerable: true,
        get() {
          calls++;
          throw new Error("caller getter");
        },
      });
    if (kind === "array prototype")
      Object.setPrototypeOf(raw.documents, {
        [Symbol.iterator]() {
          calls++;
          throw new Error("caller iterator");
        },
      });
    if (kind === "array accessor")
      Object.defineProperty(raw.documents, "0", {
        enumerable: true,
        get() {
          calls++;
          throw new Error("caller array getter");
        },
      });
    if (kind === "symbol") Object.assign(raw, { [Symbol("hidden")]: true });
    if (kind === "cycle") Object.assign(raw, { cycle: raw });
    if (kind === "nonfinite") Object.assign(raw, { invalid: Infinity });
    if (kind === "oversize") Object.assign(raw, { oversized: "x".repeat(256 * 1024) });
    if (kind === "depth")
      Object.assign(raw, {
        deep: Array.from({ length: 70 }).reduce<unknown>((value) => ({ value }), null),
      });
    if (kind === "nonobject") candidate = [];
    expect(() => parseUsDatasetCorrectedTransformationResult(candidate)).toThrow(
      "us_dataset_corrected_transformation_result_invalid",
    );
    expect(calls).toBe(0);
  });
  it("retains the original error cause and safe stage context", () => {
    const cause = new Error("original_driver_failure");
    const failure = datasetCorrectedTransformationError(
      "us_dataset_corrected_transformation_mismatch",
      cause,
    );
    expect(failure.cause).toBe(cause);
    expect(failure).toMatchObject({
      message: "us_dataset_corrected_transformation_mismatch",
      unitKey: "correction_0001",
      stage: "transformation",
    });
  });
});

const base = process.env.US_TEST_DATABASE_URL;

function correctedCasesFixture() {
  const result = fixture();
  return {
    codec: "us-dataset-corrected-cases-input-v1",
    version: result.input.version,
    definitionDigest: result.input.definitionDigest,
    references: structuredClone(result.input.references),
    amendment: structuredClone(result.input.amendment),
    receivingOrigin: structuredClone(result.input.receivingOrigin),
    transformation: {
      datasetId: result.input.references.datasetId,
      unitKey: "correction_0001",
      stage: "transformation",
      revision: 2,
      operationKey: result.createInput.operationKey,
      inputDigest: "e".repeat(64),
      resultDigest: "f".repeat(64),
    },
    transformationOrigin: {
      rootId: result.finalized.id,
      eventId: result.finalized.id,
      revision: 1,
      lifecycleVersion: 2,
    },
    outputLotId: result.outputLot.id,
    outputProductId: result.outputLot.productId,
    support: {
      capturedAt: stamp,
      shiftId: uuid(100),
      numberMonthKey: "OCT26",
      numberSeq: 261,
      boxes: result.input.chain.cases.map((sscc, index) => ({
        id: uuid(101 + index),
        deviceBoxId: `corrected-case-${index + 1}`,
        sscc,
      })),
    },
  };
}

describe("corrected Transformation to Cases input", () => {
  // Break caught: losing corrected/native origin identity or accepting a regular-chain alias.
  it("carries amended origins into 60 Cases without a regular-chain index", () => {
    const raw = correctedCasesFixture();
    const parsed = parseUsDatasetCorrectedCasesInput(raw);
    expect(parsed).toEqual(raw);
    expect(parsed).not.toHaveProperty("index");
    expect(parsed).not.toHaveProperty("receiving");
    expect(parsed).not.toHaveProperty("chain");
    expect(parsed).toMatchObject({
      transformation: { unitKey: "correction_0001", revision: 2 },
      transformationOrigin: {
        rootId: uuid(60),
        eventId: uuid(60),
        revision: 1,
        lifecycleVersion: 2,
      },
      outputLotId: uuid(61),
      outputProductId: uuid(51),
      support: { numberSeq: 261, numberMonthKey: "OCT26" },
    });
    expect(parsed.support.boxes).toHaveLength(60);
    expect(parsed.support.boxes[0]?.sscc).toBe("999999990000156413");
    expect(parsed.support.boxes[59]?.sscc).toBe("999999990000157007");
  });

  // Break caught: caller aliases remain mutable inside the returned evidence.
  it("returns an owned deep-frozen copy while leaving caller evidence mutable", () => {
    const raw = correctedCasesFixture();
    const before = structuredClone(raw);
    const parsed = parseUsDatasetCorrectedCasesInput(raw);
    expect(parsed).not.toBe(raw);
    for (const owned of [
      parsed.references,
      parsed.amendment,
      parsed.receivingOrigin.inputLots,
      parsed.transformationOrigin,
      parsed.support.boxes,
      parsed.support.boxes[0],
    ])
      expect(Object.isFrozen(owned)).toBe(true);
    expect(raw).toEqual(before);
    expect(Object.isFrozen(raw.support.boxes[0])).toBe(false);
    at(raw.support.boxes, 0).deviceBoxId = "mutated";
    at(raw.receivingOrigin.inputLots, 0).lotId = uuid(300);
    expect(parsed.support.boxes[0]?.deviceBoxId).toBe("corrected-case-1");
    expect(parsed.receivingOrigin.inputLots[0]?.lotId).toBe(uuid(40));
  });

  // Break caught: conflating the backdated business month and technical UTC shift month.
  it("uses the captured UTC month across year boundaries", () => {
    const raw = correctedCasesFixture();
    raw.support.capturedAt = "2027-01-01T00:00:00.000Z";
    raw.support.numberMonthKey = "JAN27";
    expect(parseUsDatasetCorrectedCasesInput(raw).support.numberMonthKey).toBe("JAN27");
    raw.support.numberMonthKey = "DEC26";
    expect(() => parseUsDatasetCorrectedCasesInput(raw)).toThrow(
      "us_dataset_corrected_cases_input_invalid",
    );
  });

  // Break caught: widening strict shape, normalizing aliases or skipping origin/support checks.
  it.each([
    "codec",
    "version",
    "definition",
    "extra",
    "index",
    "regular receiving",
    "recipe",
    "references extra",
    "reference revision",
    "reference digest",
    "amendment dataset",
    "amendment unit",
    "amendment stage",
    "amendment revision",
    "upstream operation reuse",
    "receiving root alias",
    "receiving revision",
    "receiving lifecycle",
    "receiving root overlap",
    "receiving lot order",
    "transformation dataset",
    "transformation unit",
    "transformation stage",
    "transformation journal revision",
    "transformation operation alias",
    "transformation digest",
    "native revision",
    "native lifecycle",
    "native event mismatch",
    "native root alias",
    "native receiving overlap",
    "output lot alias",
    "output product alias",
    "output input overlap",
    "output native overlap",
    "support extra",
    "box extra",
    "date alias",
    "invalid date",
    "business month",
    "regular sequence",
    "case order",
    "case count",
    "duplicate SSCC",
    "wrong SSCC",
    "duplicate UUID",
    "shift overlap",
    "prerequisite overlap",
    "uppercase box",
    "blank device ID",
    "untrimmed device ID",
    "duplicate device ID",
  ])("rejects %s drift with fixed Cases context", (kind) => {
    const raw = correctedCasesFixture();
    const box = at(raw.support.boxes, 0);
    switch (kind) {
      case "codec":
        raw.codec = "us-dataset-cases-v1";
        break;
      case "version":
        raw.version = "v2";
        break;
      case "definition":
        raw.definitionDigest = "0".repeat(64);
        break;
      case "extra":
        Object.assign(raw, { extra: true });
        break;
      case "index":
        Object.assign(raw, { index: 260 });
        break;
      case "regular receiving":
        Object.assign(raw, { receiving: raw.amendment });
        break;
      case "recipe":
        Object.assign(raw, { chain: fixture().input.chain });
        break;
      case "references extra":
        Object.assign(raw.references, { extra: true });
        break;
      case "reference revision":
        raw.references.revision = 1;
        break;
      case "reference digest":
        raw.references.inputDigest = "A".repeat(64);
        break;
      case "amendment dataset":
        raw.amendment.datasetId = uuid(300);
        break;
      case "amendment unit":
        raw.amendment.unitKey = "orphan_0001";
        break;
      case "amendment stage":
        raw.amendment.stage = "receiving";
        break;
      case "amendment revision":
        raw.amendment.revision = 1;
        break;
      case "upstream operation reuse":
        raw.amendment.operationKey = raw.references.operationKey;
        break;
      case "receiving root alias":
        raw.receivingOrigin.rootId = raw.receivingOrigin.rootId.toUpperCase();
        break;
      case "receiving revision":
        raw.receivingOrigin.revision = 1;
        break;
      case "receiving lifecycle":
        raw.receivingOrigin.lifecycleVersion = 3;
        break;
      case "receiving root overlap":
        raw.receivingOrigin.eventId = raw.receivingOrigin.rootId;
        break;
      case "receiving lot order":
        raw.receivingOrigin.inputLots.reverse();
        break;
      case "transformation dataset":
        raw.transformation.datasetId = uuid(300);
        break;
      case "transformation unit":
        raw.transformation.unitKey = "chain_0260";
        break;
      case "transformation stage":
        raw.transformation.stage = "receiving";
        break;
      case "transformation journal revision":
        raw.transformation.revision = 1;
        break;
      case "transformation operation alias":
        raw.transformation.operationKey = raw.transformation.operationKey.toUpperCase();
        break;
      case "transformation digest":
        raw.transformation.resultDigest = "short";
        break;
      case "native revision":
        raw.transformationOrigin.revision = 2;
        break;
      case "native lifecycle":
        raw.transformationOrigin.lifecycleVersion = 4;
        break;
      case "native event mismatch":
        raw.transformationOrigin.eventId = uuid(301);
        break;
      case "native root alias":
        raw.transformationOrigin.rootId = raw.transformationOrigin.eventId =
          raw.transformationOrigin.rootId.toUpperCase();
        break;
      case "native receiving overlap":
        raw.transformationOrigin.rootId = raw.transformationOrigin.eventId =
          raw.receivingOrigin.rootId;
        break;
      case "output lot alias":
        raw.outputLotId = raw.outputLotId.toUpperCase();
        break;
      case "output product alias":
        raw.outputProductId = raw.outputProductId.toUpperCase();
        break;
      case "output input overlap":
        raw.outputLotId = at(raw.receivingOrigin.inputLots, 0).lotId;
        break;
      case "output native overlap":
        raw.outputLotId = raw.transformationOrigin.rootId;
        break;
      case "support extra":
        Object.assign(raw.support, { extra: true });
        break;
      case "box extra":
        Object.assign(box, { extra: true });
        break;
      case "date alias":
        raw.support.capturedAt = "2026-10-09T12:00:00Z";
        break;
      case "invalid date":
        raw.support.capturedAt = "2026-02-30T12:00:00.000Z";
        break;
      case "business month":
        raw.support.numberMonthKey = "JUN26";
        break;
      case "regular sequence":
        raw.support.numberSeq = 260;
        break;
      case "case order":
        raw.support.boxes.reverse();
        break;
      case "case count":
        raw.support.boxes.pop();
        break;
      case "duplicate SSCC":
        box.sscc = at(raw.support.boxes, 1).sscc;
        break;
      case "wrong SSCC":
        box.sscc = "999999990000157014";
        break;
      case "duplicate UUID":
        box.id = at(raw.support.boxes, 1).id;
        break;
      case "shift overlap":
        raw.support.shiftId = box.id;
        break;
      case "prerequisite overlap":
        box.id = raw.outputProductId;
        break;
      case "uppercase box":
        box.id = box.id.toUpperCase();
        break;
      case "blank device ID":
        box.deviceBoxId = "  ";
        break;
      case "untrimmed device ID":
        box.deviceBoxId = " case ";
        break;
      case "duplicate device ID":
        box.deviceBoxId = at(raw.support.boxes, 1).deviceBoxId;
        break;
    }
    expect(() => parseUsDatasetCorrectedCasesInput(raw)).toThrowError(
      expect.objectContaining({
        message: "us_dataset_corrected_cases_input_invalid",
        unitKey: "correction_0001",
        stage: "cases",
        cause: expect.anything(),
      }),
    );
  });

  // Break caught: accidental speculative uniqueness constraint on unrelated stage operation keys.
  it("preserves accepted upstream operation-key constraints without adding cross-stage restrictions", () => {
    const raw = correctedCasesFixture();
    raw.transformation.operationKey = raw.amendment.operationKey;
    expect(parseUsDatasetCorrectedCasesInput(raw).transformation.operationKey).toBe(
      raw.amendment.operationKey,
    );
  });

  // Break caught: ownership collision with any identity actually carried by this codec.
  it.each([
    "dataset",
    "receiving root",
    "receiving event",
    "input lot",
    "transformation",
    "output lot",
    "output product",
  ])("rejects shift and box collision with %s", (kind) => {
    const raw = correctedCasesFixture();
    const id =
      kind === "dataset"
        ? raw.references.datasetId
        : kind === "receiving root"
          ? raw.receivingOrigin.rootId
          : kind === "receiving event"
            ? raw.receivingOrigin.eventId
            : kind === "input lot"
              ? at(raw.receivingOrigin.inputLots, 0).lotId
              : kind === "transformation"
                ? raw.transformationOrigin.rootId
                : kind === "output lot"
                  ? raw.outputLotId
                  : raw.outputProductId;
    for (const target of ["shift", "box"]) {
      const changed = structuredClone(raw);
      if (target === "shift") changed.support.shiftId = id;
      else at(changed.support.boxes, 0).id = id;
      expect(() => parseUsDatasetCorrectedCasesInput(changed)).toThrow(
        "us_dataset_corrected_cases_input_invalid",
      );
    }
  });

  // Break caught: caller getters/iterators run before the combined evidence guard.
  it.each([
    "getter",
    "array accessor",
    "array prototype",
    "symbol",
    "cycle",
    "nonfinite",
    "oversize",
    "depth",
    "prototype",
    "nonobject",
  ])("rejects hostile %s in parser and factory without caller code", (kind) => {
    const raw = correctedCasesFixture();
    let calls = 0;
    let candidate: unknown = raw;
    if (kind === "getter")
      Object.defineProperty(raw.support, "shiftId", {
        enumerable: true,
        get() {
          calls++;
          throw new Error("private");
        },
      });
    if (kind === "array accessor")
      Object.defineProperty(raw.support.boxes, "0", {
        enumerable: true,
        get() {
          calls++;
          throw new Error("private");
        },
      });
    if (kind === "array prototype")
      Object.setPrototypeOf(raw.support.boxes, {
        [Symbol.iterator]() {
          calls++;
          throw new Error("private");
        },
      });
    if (kind === "symbol") Object.assign(raw.support, { [Symbol("private")]: true });
    if (kind === "cycle") Object.assign(raw.support, { cycle: raw });
    if (kind === "nonfinite") Object.assign(raw.support, { value: Infinity });
    if (kind === "oversize") Object.assign(raw.support, { value: "x".repeat(256 * 1024) });
    if (kind === "depth")
      Object.assign(raw.support, {
        value: Array.from({ length: 70 }).reduce<unknown>((value) => ({ value }), null),
      });
    if (kind === "prototype") Object.setPrototypeOf(raw.support, { inherited: true });
    if (kind === "nonobject") candidate = null;
    expect(() => parseUsDatasetCorrectedCasesInput(candidate)).toThrow(
      "us_dataset_corrected_cases_input_invalid",
    );
    expect(() => makeUsDatasetCorrectedCasesInput(raw.references, {}, {}, raw.support)).toThrow(
      "us_dataset_corrected_cases_dependency_conflict",
    );
    expect(calls).toBe(0);
  });

  // Break caught: classifying malformed pending amendment evidence as prerequisite-incomplete.
  it("only classifies a coherent pending amendment as incomplete", () => {
    const references = fixture().input.references;
    const input = makeUsDatasetSpecialInput(
      "correction",
      "amend_receiving",
      {
        ...references,
        unitKey: "references",
        stage: "references",
        revision: 2,
      },
      {
        datasetId: references.datasetId,
        unitKey: "correction_0001",
        stage: "receiving",
        revision: 2,
        operationKey: uuid(80),
        inputDigest: "c".repeat(64),
        resultDigest: "d".repeat(64),
      },
    );
    const pending = {
      unitKey: "correction_0001",
      stage: "amend_receiving",
      revision: 1,
      intent: {
        unitKey: "correction_0001",
        stage: "amend_receiving",
        operationKey: uuid(3),
        input,
        inputDigest: canonicalExportDigest(input),
      },
      receipt: null,
    };
    expect(() =>
      makeUsDatasetCorrectedCasesInput(references, pending, {}, correctedCasesFixture().support),
    ).toThrow("us_dataset_corrected_cases_prerequisite_incomplete");
    expect(() =>
      makeUsDatasetCorrectedCasesInput(
        references,
        { ...pending, revision: 2 },
        {},
        correctedCasesFixture().support,
      ),
    ).toThrow("us_dataset_corrected_cases_dependency_conflict");
    expect(() =>
      makeUsDatasetCorrectedCasesInput(
        references,
        { ...pending, intent: { ...pending.intent, inputDigest: "e".repeat(64) } },
        {},
        correctedCasesFixture().support,
      ),
    ).toThrow("us_dataset_corrected_cases_dependency_conflict");
  });
});

describe.skipIf(!base)("corrected Transformation native prerequisite witnesses", () => {
  describe("corrected Transformation persisted amended native witness", () => {
    const h = specialFixture(base);
    it(
      "composes actual native evidence from the completed persisted amendment",
      h.phase(async () => {
        const prepared = await prepareDatasetCorrectedTransformation(h.f.db, h.context);
        expect(prepared.referenceStage.revision).toBe(2);
        expect(prepared.originalStage.revision).toBe(2);
        expect(prepared.amendmentStage.revision).toBe(2);
        const receipt = await h.f.db.transaction(prepared.apply);
        const result = parseUsDatasetCorrectedTransformationResult(receipt.result);
        expect(
          result.createInput.draft.inputs.map(({ quantity, unitOfMeasure }) => [
            quantity,
            unitOfMeasure,
          ]),
        ).toEqual([
          ["300", "lb"],
          ["400", "lb"],
        ]);
        expect(
          result.finalized.snapshot.outputs.map(({ quantity, unitOfMeasure }) => [
            quantity,
            unitOfMeasure,
          ]),
        ).toEqual([["60", "case"]]);
        expect(result.created.draft.eventDate).toBe("2026-06-11");
        expect(result.created.timeZone).toBe("America/Los_Angeles");
        const origin = result.input.receivingOrigin;
        expect(origin.rootId).toBe(prepared.original.finalized.eventId);
        expect(origin.eventId).toBe(prepared.lifecycle.finalized.eventId);
        expect(origin.eventId).not.toBe(origin.rootId);
        expect(origin.revision).toBe(2);
        expect(origin.lifecycleVersion).toBe(4);
        expect(prepared.original.finalized.record.content.kind).toBe("finalized");
        if (prepared.original.finalized.record.content.kind !== "finalized")
          throw new Error("Missing original snapshot");
        expect(
          prepared.original.finalized.record.content.snapshot.items.map(({ quantity }) => quantity),
        ).toEqual(["250", "400"]);
        expect(result.inputLots).toEqual(
          prepared.original.lots.map(({ id }, i) => ({ lineNo: i + 1, lotId: id })),
        );
        expect(result.inputLots).toEqual(origin.inputLots);
        expect(usDatasetCorrectedTransformationRecordIds(result)).toEqual([
          result.documents[0]?.record.id,
          result.documents[1]?.record.id,
          result.created.id,
          result.outputLot.id,
        ]);
        expect(receipt.recordIds).toHaveLength(4);
        expect(receipt.recordIds).not.toContain(origin.rootId);
        expect(receipt.recordIds).not.toContain(origin.eventId);
        expect(Object.isFrozen(result.finalized.snapshot.inputs)).toBe(true);
        for (const mutation of ["root", "operation", "document", "mapping"] as const) {
          const raw = structuredClone(result);
          if (mutation === "root") {
            const alias = raw.created.id.toUpperCase();
            expect(alias).not.toBe(raw.created.id);
            raw.created.id = raw.finalized.id = raw.finalized.snapshot.eventId = alias;
            if (!raw.created.lifecycle || !raw.finalized.lifecycle)
              throw new Error("Missing native lifecycle");
            raw.created.lifecycle.rootId =
              raw.created.lifecycle.pendingDraftId =
              raw.finalized.lifecycle.rootId =
              raw.finalized.lifecycle.currentEventId =
                alias;
          }
          if (mutation === "operation")
            raw.createInput.operationKey = raw.finalizeInput.operationKey =
              raw.createInput.operationKey.toUpperCase();
          if (mutation === "document") {
            const alias = at(raw.documents, 0).record.id.toUpperCase();
            expect(alias).not.toBe(at(raw.documents, 0).record.id);
            at(raw.documents, 0).record.id =
              raw.created.draft.documentIds[0] =
              raw.createInput.draft.documentIds[0] =
              at(raw.finalized.snapshot.documents, 0).id =
                alias;
          }
          if (mutation === "mapping") {
            const alias = at(raw.inputLots, 0).lotId.toUpperCase();
            expect(alias).not.toBe(at(raw.inputLots, 0).lotId);
            Object.assign(at(raw.inputLots, 0), { lotId: alias });
            Object.assign(at(raw.input.receivingOrigin.inputLots, 0), { lotId: alias });
            for (const line of [
              at(raw.createInput.draft.inputs, 0),
              at(raw.created.draft.inputs, 0),
              at(raw.finalized.snapshot.inputs, 0),
            ]) {
              if (line.kind !== "ftl_lot") throw new Error("Wrong native input kind");
              line.lotId = alias;
            }
          }
          expect(() => parseUsDatasetCorrectedTransformationResult(raw)).toThrow(
            "us_dataset_corrected_transformation_result_invalid",
          );
        }
        console.info(
          "Actual persisted amendment corrected Transformation native witness accepted: 300/400 lb to 60 case; no Transformation stage receipt fabricated",
        );
      }),
      60_000,
    );
  });

  describe("corrected Cases input from saved native Transformation", () => {
    const h = specialFixture(base);
    // Break caught: synthesizing a receipt or trusting mismatched intent/receipt/upstream bindings.
    it(
      "binds actual completed journal evidence without creating Cases support or links",
      h.phase(async () => {
        await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
        await new UsDatasetSpecialSeedStore(h.f.db).initialize(h.context, "correction");
        const native = await new UsDatasetCorrectedTransformationSeedStore(h.f.db).initialize(
          h.context,
        );
        const journal = new UsDatasetJournalStore(h.f.db, usSixMonthDefinition);
        const header = await journal.read(h.context);
        if (!header) throw new Error("Missing native dataset header");
        const referencesStage = await journal.readStage(
          h.context,
          header.id,
          "references",
          "references",
        );
        const amendmentStage = await journal.readStage(
          h.context,
          header.id,
          "correction_0001",
          "amend_receiving",
        );
        const transformationStage = await journal.readStage(
          h.context,
          header.id,
          "correction_0001",
          "transformation",
        );
        if (!referencesStage?.receipt || !amendmentStage?.receipt || !transformationStage?.receipt)
          throw new Error("Missing completed native prerequisite");
        expect(transformationStage.revision).toBe(2);
        const references = makeUsDatasetReferenceIdentity(header.id, referencesStage);
        const supportId = (): string => randomUUID();
        const support = {
          ...correctedCasesFixture().support,
          shiftId: supportId(),
          boxes: native.input.chain.cases.map((sscc, index) => ({
            id: supportId(),
            deviceBoxId: `native-corrected-${index + 1}`,
            sscc,
          })),
        };
        const raw = structuredClone({
          references,
          amendmentStage: { ...amendmentStage, receipt: amendmentStage.receipt },
          transformationStage: { ...transformationStage, receipt: transformationStage.receipt },
          support,
        });
        const original = structuredClone(raw);
        const before = await h.f.snapshot();
        const input = makeUsDatasetCorrectedCasesInput(
          raw.references,
          raw.amendmentStage,
          raw.transformationStage,
          raw.support,
        );
        expect(input.references).toEqual(references);
        expect(input.amendment).toEqual(native.input.amendment);
        expect(input.receivingOrigin).toEqual(native.input.receivingOrigin);
        expect(input.transformation).toEqual({
          datasetId: header.id,
          unitKey: "correction_0001",
          stage: "transformation",
          revision: 2,
          operationKey: transformationStage.intent.operationKey,
          inputDigest: transformationStage.intent.inputDigest,
          resultDigest: transformationStage.receipt.resultDigest,
        });
        expect(input.transformationOrigin).toEqual({
          rootId: native.finalized.id,
          eventId: native.finalized.id,
          revision: 1,
          lifecycleVersion: 2,
        });
        expect(input.outputLotId).toBe(native.outputLot.id);
        expect(input.outputProductId).toBe(native.outputLot.productId);
        expect(input.support.boxes).toHaveLength(60);
        expect(input.support.boxes[0]?.sscc).toBe("999999990000156413");
        expect(input.support.boxes[59]?.sscc).toBe("999999990000157007");
        expect(parseUsDatasetCorrectedCasesInput(input)).toEqual(input);
        expect(Object.isFrozen(input.support.boxes[0])).toBe(true);
        expect(Object.isFrozen(input.receivingOrigin.inputLots[0])).toBe(true);
        expect(Object.isFrozen(raw.transformationStage.receipt.result)).toBe(false);
        expect(Object.isFrozen(raw.support.boxes[0])).toBe(false);
        expect(raw).toEqual(original);
        at(raw.support.boxes, 0).deviceBoxId = "caller-mutated";
        expect(input.support.boxes[0]?.deviceBoxId).toBe("native-corrected-1");

        const pending = { ...transformationStage, revision: 1, receipt: null };
        expect(() =>
          makeUsDatasetCorrectedCasesInput(references, amendmentStage, pending, support),
        ).toThrow("us_dataset_corrected_cases_prerequisite_incomplete");
        for (const mutation of [
          "row unit",
          "row stage",
          "row revision",
          "row extra",
          "revision receipt",
          "completed null",
          "intent unit",
          "intent stage",
          "intent operation",
          "input digest",
          "result digest",
          "record order",
          "missing record",
          "additional record",
          "input reference",
          "input amendment",
          "input origin",
          "result upstream",
          "reference identity",
          "amendment receipt",
          "support document shift",
          "support document box",
          "support sequence",
          "pending mismatched input",
          "pending bad digest",
        ] as const) {
          const changed = structuredClone(original);
          const stage = changed.transformationStage;
          switch (mutation) {
            case "row unit":
              stage.unitKey = "orphan_0001";
              break;
            case "row stage":
              stage.stage = "receiving";
              break;
            case "row revision":
              stage.revision = 3;
              break;
            case "row extra":
              Object.assign(stage, { extra: true });
              break;
            case "revision receipt":
              stage.revision = 1;
              break;
            case "completed null":
              Object.assign(stage, { receipt: null });
              break;
            case "intent unit":
              stage.intent = { ...stage.intent, unitKey: "orphan_0001" };
              break;
            case "intent stage":
              stage.intent = { ...stage.intent, stage: "receiving" };
              break;
            case "intent operation":
              stage.intent = { ...stage.intent, operationKey: randomUUID() };
              break;
            case "input digest":
              stage.intent = { ...stage.intent, inputDigest: "e".repeat(64) };
              break;
            case "result digest":
              stage.receipt = { ...stage.receipt, resultDigest: "e".repeat(64) };
              break;
            case "record order":
              stage.receipt = {
                ...stage.receipt,
                recordIds: [...stage.receipt.recordIds].reverse(),
              };
              break;
            case "missing record":
              stage.receipt = { ...stage.receipt, recordIds: stage.receipt.recordIds.slice(1) };
              break;
            case "additional record":
              stage.receipt = {
                ...stage.receipt,
                recordIds: [...stage.receipt.recordIds, randomUUID()],
              };
              break;
            case "input reference":
            case "input amendment":
            case "input origin":
            case "pending mismatched input": {
              const upstream = { ...structuredClone(native.input) };
              if (mutation === "input reference")
                upstream.references = { ...upstream.references, resultDigest: "a".repeat(64) };
              else if (mutation === "input amendment")
                upstream.amendment = { ...upstream.amendment, resultDigest: "a".repeat(64) };
              else
                upstream.receivingOrigin = { ...upstream.receivingOrigin, eventId: randomUUID() };
              stage.intent = {
                ...stage.intent,
                input: upstream,
                inputDigest: canonicalExportDigest(upstream),
              };
              if (mutation === "pending mismatched input") {
                stage.revision = 1;
                Object.assign(stage, { receipt: null });
              }
              break;
            }
            case "result upstream": {
              const result = structuredClone(native);
              Object.assign(result.input, {
                amendment: { ...result.input.amendment, resultDigest: "a".repeat(64) },
              });
              stage.receipt = {
                ...stage.receipt,
                result,
                resultDigest: canonicalExportDigest(result),
              };
              break;
            }
            case "reference identity":
              changed.references = { ...changed.references, resultDigest: "a".repeat(64) };
              break;
            case "amendment receipt":
              changed.amendmentStage.receipt = {
                ...changed.amendmentStage.receipt,
                resultDigest: "e".repeat(64),
              };
              break;
            case "support document shift":
              changed.support.shiftId = at(native.documents, 0).record.id;
              break;
            case "support document box":
              at(changed.support.boxes, 0).id = at(native.documents, 1).record.id;
              break;
            case "support sequence":
              changed.support.numberSeq = 260;
              break;
            case "pending bad digest":
              stage.revision = 1;
              Object.assign(stage, { receipt: null });
              stage.intent = { ...stage.intent, inputDigest: "e".repeat(64) };
              break;
          }
          expect(
            () =>
              makeUsDatasetCorrectedCasesInput(
                changed.references,
                changed.amendmentStage,
                stage,
                changed.support,
              ),
            mutation,
          ).toThrowError(
            expect.objectContaining({
              message: "us_dataset_corrected_cases_dependency_conflict",
              unitKey: "correction_0001",
              stage: "cases",
              cause: expect.anything(),
            }),
          );
        }
        expect(await h.f.snapshot()).toEqual(before);
        expect(
          await journal.readStage(h.context, header.id, "correction_0001", "cases"),
        ).toBeNull();
        const empty = await h.f.pool.query<{
          shifts: number;
          boxes: number;
          markers: number;
          links: number;
        }>(
          "SELECT (SELECT count(*)::int FROM shifts) AS shifts, (SELECT count(*)::int FROM boxes) AS boxes, (SELECT count(*)::int FROM traceability_synthetic_case_origins) AS markers, (SELECT count(*)::int FROM trace_lot_boxes) AS links",
        );
        expect(empty.rows).toEqual([{ shifts: 0, boxes: 0, markers: 0, links: 0 }]);
        console.info(
          "Corrected Cases input bound to real completed Transformation journal receipt; no support, markers, links or Cases receipt created",
        );
      }),
      60_000,
    );
  });
});

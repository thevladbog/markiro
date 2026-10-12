import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import {
  receivingAmendmentDraftSchema,
  type ReceivingLiveRecord,
  type ReceivingDraft,
} from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { makeUsDatasetReferenceIdentity } from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import {
  makeUsSixMonthSpecialExamples,
  usSixMonthDefinition,
} from "../src/modules/traceability/demo/us-six-month-definition";
import {
  makeUsDatasetCorrectedTransformationInput,
  parseUsDatasetCorrectedTransformationInput,
} from "../src/modules/traceability/demo/us-dataset-corrected-transformation-contract";
import { UsReferenceDocumentStore } from "../src/modules/traceability/documents/us-reference-document-store";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import type { UsMasterDataTransaction } from "../src/modules/traceability/master-data/us-master-data-support";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  datasetSpecialError,
  makeUsDatasetSpecialInput,
  makeUsDatasetSpecialStageIdentity,
  parseUsDatasetSpecialInput,
  parseUsDatasetSpecialResult,
  usDatasetSpecialRecordIds,
  type UsDatasetSpecialKind,
  type UsDatasetSpecialReceivingResult,
} from "../src/modules/traceability/demo/us-dataset-special-contract";

const datasetId = "00000000-0000-4000-8000-000000000001";
const refs = {
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
  unitKey: "correction_0001" as const,
  stage: "receiving" as const,
  revision: 2 as const,
  operationKey: "00000000-0000-4000-8000-000000000003",
  inputDigest: "c".repeat(64),
  resultDigest: "d".repeat(64),
};

describe("special Receiving input codec", () => {
  it("pins correction initial quantities and corrected recipe independently", () => {
    const input = makeUsDatasetSpecialInput("correction", "receiving", refs, null);
    expect(input.kind).toBe("correction");
    expect(input.stage).toBe("receiving");
    expect(input.receiving).toBeNull();
    if (!("initialReceiving" in input.recipe)) throw new Error("Expected correction recipe");
    expect(input.recipe.initialReceiving.eventDate).toBe("2026-06-10");
    expect(input.recipe.initialReceiving.lines.map((line) => line.quantity)).toEqual([
      "250",
      "400",
    ]);
    expect(input.recipe.correctedChain.receiving.lines.map((line) => line.quantity)).toEqual([
      "300",
      "400",
    ]);
    expect(input.recipe.correctedChain.unitKey).toBe("correction_0001");
    expect(input.recipe.amendmentReason).toBe(
      "Correct synthetic receiving quantity before downstream use.",
    );
  });

  it("pins orphan dates, lots and exact void reason", () => {
    const input = makeUsDatasetSpecialInput("orphan", "receiving", refs, null);
    if (!("voidReason" in input.recipe)) throw new Error("Expected orphan recipe");
    expect(input.recipe.unitKey).toBe("orphan_0001");
    expect(input.recipe.receiving.eventDate).toBe("2026-08-10");
    expect(
      input.recipe.receiving.lines.map((line) => [line.tlc, line.quantity, line.unitOfMeasure]),
    ).toEqual([
      ["MUS-IN-20260810-orphan_0001-A1", "200", "lb"],
      ["MUS-IN-20260810-orphan_0001-A2", "200", "lb"],
    ]);
    expect(input.recipe.voidReason).toBe("Void synthetic receipt before downstream use.");
  });

  it("returns an owned deeply frozen copy without freezing callers", () => {
    const raw = structuredClone(makeUsDatasetSpecialInput("correction", "receiving", refs, null));
    const input = parseUsDatasetSpecialInput(raw);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.references)).toBe(true);
    expect(Object.isFrozen(input.recipe)).toBe(true);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Object.isFrozen(raw.references)).toBe(false);
    expect(input).not.toBe(raw);
    expect(input.references).not.toBe(raw.references);
  });

  it("binds correction amendment and orphan void to their own original stage", () => {
    expect(
      makeUsDatasetSpecialInput("correction", "amend_receiving", refs, receiving).receiving,
    ).toEqual(receiving);
    expect(
      makeUsDatasetSpecialInput("orphan", "void_receiving", refs, {
        ...receiving,
        unitKey: "orphan_0001",
      }).stage,
    ).toBe("void_receiving");
  });

  it.each([
    ["correction", "void_receiving", receiving],
    ["orphan", "amend_receiving", { ...receiving, unitKey: "orphan_0001" }],
    ["correction", "receiving", receiving],
    ["correction", "amend_receiving", null],
  ] as const)("rejects incompatible kind/stage/predecessor %s/%s", (kind, stage, predecessor) => {
    expect(() => makeUsDatasetSpecialInput(kind, stage, refs, predecessor)).toThrow(
      "us_dataset_special_input_invalid",
    );
  });

  it("rejects a kind alias even when the recipe remains unchanged", () => {
    const input = makeUsDatasetSpecialInput("correction", "receiving", refs, null);
    expect(() => parseUsDatasetSpecialInput({ ...input, kind: "orphan" })).toThrow(
      "us_dataset_special_input_invalid",
    );
    expect(() => parseUsDatasetSpecialInput({ ...input, kind: "corrected" })).toThrow(
      "us_dataset_special_input_invalid",
    );
  });

  it("rejects any changed recipe quantity, date, reason or added field", () => {
    const original = makeUsDatasetSpecialInput("correction", "receiving", refs, null);
    if (!("initialReceiving" in original.recipe)) throw new Error("Expected correction recipe");
    const recipe = original.recipe;
    for (const changed of [
      { ...recipe, initialReceiving: { ...recipe.initialReceiving, eventDate: "2026-06-11" } },
      { ...recipe, amendmentReason: "Another reason" },
      {
        ...recipe,
        initialReceiving: {
          ...recipe.initialReceiving,
          lines: recipe.initialReceiving.lines.map((line) => ({ ...line, quantity: "999" })),
        },
      },
      { ...recipe, extra: true },
    ])
      expect(() => parseUsDatasetSpecialInput({ ...original, recipe: changed })).toThrow(
        "us_dataset_special_input_invalid",
      );
    expect(() => parseUsDatasetSpecialInput({ ...original, extra: true })).toThrow(
      "us_dataset_special_input_invalid",
    );
  });

  it("rejects foreign dataset/unit/stage and reused reference operation keys", () => {
    for (const changed of [
      { ...receiving, datasetId: "00000000-0000-4000-8000-000000000009" },
      { ...receiving, unitKey: "orphan_0001" },
      { ...receiving, stage: "amend_receiving" },
      { ...receiving, revision: 1 },
      { ...receiving, operationKey: refs.operationKey },
    ]) {
      const input = makeUsDatasetSpecialInput("correction", "amend_receiving", refs, receiving);
      expect(() => parseUsDatasetSpecialInput({ ...input, receiving: changed })).toThrow(
        "us_dataset_special_input_invalid",
      );
    }
  });

  it("rejects noncanonical UUIDs and digests", () => {
    const input = makeUsDatasetSpecialInput("correction", "receiving", refs, null);
    for (const references of [
      { ...refs, datasetId: "ABCDEF00-0000-4000-8000-000000000001" },
      { ...refs, operationKey: "unsafe" },
      { ...refs, inputDigest: "A".repeat(64) },
      { ...refs, resultDigest: "short" },
      { ...refs, extra: true },
    ])
      expect(() => parseUsDatasetSpecialInput({ ...input, references })).toThrow(
        "us_dataset_special_input_invalid",
      );
  });

  it("rejects accessors before calling them", () => {
    let calls = 0;
    const raw = { ...makeUsDatasetSpecialInput("correction", "receiving", refs, null) };
    Object.defineProperty(raw, "recipe", {
      enumerable: true,
      get() {
        calls++;
        throw new Error("getter ran");
      },
    });
    expect(() => parseUsDatasetSpecialInput(raw)).toThrow("us_dataset_special_input_invalid");
    expect(calls).toBe(0);
  });

  it("rejects cycles, symbols, exotic prototypes, nonfinite and oversized JSON", () => {
    const input = makeUsDatasetSpecialInput("correction", "receiving", refs, null);
    const cycle: Record<string, unknown> = { ...input };
    cycle["cycle"] = cycle;
    const exotic = Object.assign(Object.create({ inherited: true }), input) as unknown;
    for (const raw of [
      cycle,
      { ...input, [Symbol("hidden")]: true },
      exotic,
      { ...input, count: Infinity },
      { ...input, padding: "x".repeat(256 * 1024) },
    ])
      expect(() => parseUsDatasetSpecialInput(raw)).toThrow("us_dataset_special_input_invalid");
  });
});

describe("special Receiving evidence boundaries", () => {
  it("reports incomplete original stages without pretending an intent is completed", () => {
    const stage = {
      unitKey: "correction_0001",
      stage: "receiving" as const,
      revision: 1,
      intent: {
        unitKey: "correction_0001",
        stage: "receiving" as const,
        operationKey: receiving.operationKey,
        inputDigest: receiving.inputDigest,
        input: {},
      },
      receipt: null,
    };
    expect(() => makeUsDatasetSpecialStageIdentity(datasetId, stage)).toThrow(
      "us_dataset_special_prerequisite_incomplete",
    );
  });

  it("rejects a noncanonical dataset UUID before accepting a prerequisite", () => {
    const stage = {
      unitKey: "correction_0001",
      stage: "receiving" as const,
      revision: 1,
      intent: {
        unitKey: "correction_0001",
        stage: "receiving" as const,
        operationKey: receiving.operationKey,
        inputDigest: receiving.inputDigest,
        input: {},
      },
      receipt: null,
    };
    expect(() =>
      makeUsDatasetSpecialStageIdentity("ABCDEF00-0000-4000-8000-000000000001", stage),
    ).toThrow("us_dataset_special_dependency_conflict");
  });

  it("rejects result shape and unrelated lifecycle fields before accepting evidence", () => {
    const input = makeUsDatasetSpecialInput("correction", "receiving", refs, null);
    for (const raw of [
      null,
      {},
      { stage: "void_receiving", input },
      { stage: "receiving", input, voided: {} },
      { stage: "receiving", input, documents: [], created: {}, finalized: {}, lots: [] },
    ])
      expect(() => parseUsDatasetSpecialResult(raw)).toThrow("us_dataset_special_result_invalid");
  });

  it("rejects unsafe result getters without evaluating nested contracts", () => {
    let calls = 0;
    const raw = {
      stage: "receiving",
      input: makeUsDatasetSpecialInput("orphan", "receiving", refs, null),
    };
    Object.defineProperty(raw, "created", {
      enumerable: true,
      get() {
        calls++;
        return {};
      },
    });
    expect(() => parseUsDatasetSpecialResult(raw)).toThrow("us_dataset_special_result_invalid");
    expect(calls).toBe(0);
  });

  it("attaches only safe unit/stage context to errors", () => {
    const error = datasetSpecialError(
      "us_dataset_special_mismatch",
      "correction_0001",
      "amend_receiving",
    );
    expect(error).toMatchObject({
      message: "us_dataset_special_mismatch",
      unitKey: "correction_0001",
      stage: "amend_receiving",
    });
    expect(
      datasetSpecialError("us_dataset_special_mismatch", "private credential!", "receiving"),
    ).toMatchObject({ unitKey: "unknown" });
    expect(
      Reflect.apply(datasetSpecialError, undefined, [
        "us_dataset_special_mismatch",
        "correction_0001",
        "private credential!",
      ]),
    ).toMatchObject({ stage: "receiving" });
  });
});

function correctedInputFixture() {
  return structuredClone({
    codec: "us-dataset-corrected-transformation-input-v1",
    version: "us-processor-six-month-v1",
    definitionDigest: usSixMonthDefinition.digest,
    references: refs,
    amendment: { ...receiving, stage: "amend_receiving" },
    receivingOrigin: {
      rootId: "abcdef00-0000-4000-8000-000000000004",
      eventId: "abcdef00-0000-4000-8000-000000000005",
      revision: 2,
      lifecycleVersion: 4,
      inputLots: [
        { lineNo: 1, lotId: "abcdef00-0000-4000-8000-000000000006" },
        { lineNo: 2, lotId: "abcdef00-0000-4000-8000-000000000007" },
      ],
    },
    chain: makeUsSixMonthSpecialExamples().correction.correctedChain,
  });
}

function pendingCorrectedFixture() {
  const input = makeUsDatasetSpecialInput("correction", "amend_receiving", refs, receiving);
  return structuredClone({
    unitKey: "correction_0001",
    stage: "amend_receiving",
    revision: 1,
    intent: {
      unitKey: "correction_0001",
      stage: "amend_receiving",
      operationKey: "00000000-0000-4000-8000-000000000008",
      input,
      inputDigest: canonicalExportDigest(input),
    },
    receipt: null,
  });
}

describe("corrected Transformation input foundation", () => {
  it("accepts corrected quantities and the ordered current origin as an owned frozen copy", () => {
    const raw = correctedInputFixture();
    const before = structuredClone(raw);
    const input = parseUsDatasetCorrectedTransformationInput(raw);
    expect(input.chain.transformation.eventDate).toBe("2026-06-11");
    expect(
      input.chain.transformation.inputs.map(({ quantity, unitOfMeasure }) => ({
        quantity,
        unitOfMeasure,
      })),
    ).toEqual([
      { quantity: "300", unitOfMeasure: "lb" },
      { quantity: "400", unitOfMeasure: "lb" },
    ]);
    expect(input.chain.transformation.output).toMatchObject({
      quantity: "60",
      unitOfMeasure: "case",
    });
    expect(input.chain.cases).toHaveLength(60);
    expect(input.receivingOrigin).toEqual({
      rootId: "abcdef00-0000-4000-8000-000000000004",
      eventId: "abcdef00-0000-4000-8000-000000000005",
      revision: 2,
      lifecycleVersion: 4,
      inputLots: [
        { lineNo: 1, lotId: "abcdef00-0000-4000-8000-000000000006" },
        { lineNo: 2, lotId: "abcdef00-0000-4000-8000-000000000007" },
      ],
    });
    expect(input.amendment).toMatchObject({
      unitKey: "correction_0001",
      stage: "amend_receiving",
      revision: 2,
    });
    expect(input).not.toBe(raw);
    expect(Object.isFrozen(input.references)).toBe(true);
    expect(Object.isFrozen(input.receivingOrigin.inputLots[0])).toBe(true);
    expect(Object.isFrozen(input.chain.transformation.inputs[0])).toBe(true);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Object.isFrozen(raw.receivingOrigin.inputLots)).toBe(false);
    expect(Object.isFrozen(raw.chain.transformation.inputs[0])).toBe(false);
    raw.receivingOrigin.eventId = "abcdef00-0000-4000-8000-000000000009";
    expect(input.receivingOrigin.eventId).toBe("abcdef00-0000-4000-8000-000000000005");
    raw.receivingOrigin.eventId = before.receivingOrigin.eventId;
    expect(raw).toEqual(before);
  });

  it("rejects altered recipes including historical quantities, UOM, date and unknown fields", () => {
    const raw = correctedInputFixture();
    const chain = raw.chain;
    const transformation = chain.transformation;
    for (const changed of [
      { ...chain, unitKey: "chain_0001" },
      { ...chain, transformation: { ...transformation, eventDate: "2026-06-12" } },
      {
        ...chain,
        transformation: {
          ...transformation,
          inputs: transformation.inputs.map((line, i) => ({
            ...line,
            quantity: i === 0 ? "250" : line.quantity,
          })),
        },
      },
      {
        ...chain,
        transformation: {
          ...transformation,
          inputs: transformation.inputs.map((line) => ({ ...line, unitOfMeasure: "kg" })),
        },
      },
      {
        ...chain,
        transformation: { ...transformation, output: { ...transformation.output, quantity: "50" } },
      },
      {
        ...chain,
        transformation: {
          ...transformation,
          output: { ...transformation.output, unitOfMeasure: "lb" },
        },
      },
      { ...chain, extra: true },
    ])
      expect(() => parseUsDatasetCorrectedTransformationInput({ ...raw, chain: changed })).toThrow(
        "us_dataset_corrected_transformation_input_invalid",
      );
    for (const changed of [
      { ...raw, codec: "us-dataset-transformation-v1" },
      { ...raw, version: "v2" },
      { ...raw, definitionDigest: "a".repeat(64) },
      { ...raw, extra: true },
    ])
      expect(() => parseUsDatasetCorrectedTransformationInput(changed)).toThrow(
        "us_dataset_corrected_transformation_input_invalid",
      );
  });

  it("rejects contradictory identity, aliases, malformed digests and incomplete or duplicate mappings", () => {
    const raw = correctedInputFixture();
    for (const amendment of [
      { ...raw.amendment, datasetId: "00000000-0000-4000-8000-000000000009" },
      { ...raw.amendment, unitKey: "orphan_0001" },
      { ...raw.amendment, stage: "receiving" },
      { ...raw.amendment, revision: 1 },
      { ...raw.amendment, operationKey: refs.operationKey },
      { ...raw.amendment, operationKey: "ABCDEF00-0000-4000-8000-000000000003" },
      { ...raw.amendment, inputDigest: "A".repeat(64) },
      { ...raw.amendment, resultDigest: "short" },
      { ...raw.amendment, extra: true },
    ])
      expect(() => parseUsDatasetCorrectedTransformationInput({ ...raw, amendment })).toThrow(
        "us_dataset_corrected_transformation_input_invalid",
      );
    for (const references of [
      { ...refs, datasetId: "ABCDEF00-0000-4000-8000-000000000001" },
      { ...refs, stage: "amend_receiving" },
      { ...refs, revision: 1 },
      { ...refs, operationKey: "unsafe" },
      { ...refs, inputDigest: "short" },
      { ...refs, resultDigest: "B".repeat(64) },
      { ...refs, extra: true },
    ])
      expect(() => parseUsDatasetCorrectedTransformationInput({ ...raw, references })).toThrow(
        "us_dataset_corrected_transformation_input_invalid",
      );
    const origin = raw.receivingOrigin;
    for (const receivingOrigin of [
      { ...origin, revision: 1 },
      { ...origin, lifecycleVersion: 3 },
      { ...origin, extra: true },
      { ...origin, rootId: origin.eventId },
      { ...origin, eventId: origin.rootId.toUpperCase() },
      { ...origin, rootId: "unsafe" },
      { ...origin, inputLots: [] },
      {
        ...origin,
        inputLots: [
          { lineNo: 1, lotId: origin.rootId },
          { lineNo: 2, lotId: origin.eventId },
        ],
      },
      {
        ...origin,
        inputLots: [
          { lineNo: 1, lotId: "abcdef00-0000-4000-8000-000000000006" },
          { lineNo: 2, lotId: "abcdef00-0000-4000-8000-000000000006" },
        ],
      },
      { ...origin, inputLots: origin.inputLots.map((line) => ({ ...line, lineNo: 1 })) },
      { ...origin, inputLots: [...origin.inputLots].reverse() },
      {
        ...origin,
        inputLots: origin.inputLots.map((line) => ({ ...line, lotId: line.lotId.toUpperCase() })),
      },
      { ...origin, inputLots: origin.inputLots.map((line) => ({ ...line, extra: true })) },
    ])
      expect(() => parseUsDatasetCorrectedTransformationInput({ ...raw, receivingOrigin })).toThrow(
        "us_dataset_corrected_transformation_input_invalid",
      );
  });

  it("rejects hostile JSON without reading getters and retains safe error context and cause", () => {
    const raw = correctedInputFixture();
    let calls = 0;
    const accessor = { ...raw };
    Object.defineProperty(accessor.receivingOrigin, "eventId", {
      enumerable: true,
      get() {
        calls++;
        throw new Error("private input");
      },
    });
    const cycle: Record<string, unknown> = correctedInputFixture();
    cycle["cycle"] = cycle;
    for (const hostile of [
      accessor,
      cycle,
      { ...correctedInputFixture(), [Symbol("hidden")]: true },
      Object.assign(Object.create({ inherited: true }), correctedInputFixture()) as unknown,
      { ...correctedInputFixture(), count: Infinity },
      { ...correctedInputFixture(), padding: "x".repeat(256 * 1024) },
    ]) {
      expect(() => parseUsDatasetCorrectedTransformationInput(hostile)).toThrow(
        "us_dataset_corrected_transformation_input_invalid",
      );
    }
    expect(calls).toBe(0);
    try {
      parseUsDatasetCorrectedTransformationInput(accessor);
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toMatchObject({
        message: "us_dataset_corrected_transformation_input_invalid",
        unitKey: "correction_0001",
        stage: "transformation",
        cause: expect.any(Error),
      });
    }
  });

  it("rejects an exotic nested array before its inherited iterator getter runs in the parser", () => {
    const raw = correctedInputFixture();
    const cases = raw.chain.cases;
    const firstCase = Object.getOwnPropertyDescriptor(cases, "0")?.value as unknown;
    let calls = 0;
    const prototype: object = Object.create(Array.prototype) as object;
    Object.defineProperty(prototype, Symbol.iterator, {
      get() {
        calls++;
        return Array.prototype[Symbol.iterator];
      },
    });
    Object.setPrototypeOf(cases, prototype);
    expect
      .soft(() => parseUsDatasetCorrectedTransformationInput(raw))
      .toThrow("us_dataset_corrected_transformation_input_invalid");
    expect(calls).toBe(0);
    expect(Object.getPrototypeOf(cases)).toBe(prototype);
    expect(Object.getOwnPropertyDescriptor(cases, "0")?.value).toBe(firstCase);
    expect(Object.isFrozen(cases)).toBe(false);
    const valid = correctedInputFixture();
    const before = structuredClone(valid);
    const parsed = parseUsDatasetCorrectedTransformationInput(valid);
    expect(parsed.chain.cases).toHaveLength(60);
    expect(Object.getPrototypeOf(valid.chain.cases)).toBe(Array.prototype);
    expect(Object.isFrozen(valid.chain.cases)).toBe(false);
    expect(valid).toEqual(before);
  });

  it("rejects an exotic nested array before its inherited iterator getter runs in the factory", () => {
    const pending = pendingCorrectedFixture();
    const recipe = pending.intent.input.recipe;
    if (!("correctedChain" in recipe)) throw new Error("Expected correction recipe");
    const cases = recipe.correctedChain.cases;
    const firstCase = Object.getOwnPropertyDescriptor(cases, "0")?.value as unknown;
    let calls = 0;
    const prototype: object = Object.create(Array.prototype) as object;
    Object.defineProperty(prototype, Symbol.iterator, {
      get() {
        calls++;
        return Array.prototype[Symbol.iterator];
      },
    });
    Object.setPrototypeOf(cases, prototype);
    expect
      .soft(() => makeUsDatasetCorrectedTransformationInput(refs, pending))
      .toThrow("us_dataset_corrected_transformation_dependency_conflict");
    expect(calls).toBe(0);
    expect(Object.getPrototypeOf(cases)).toBe(prototype);
    expect(Object.getOwnPropertyDescriptor(cases, "0")?.value).toBe(firstCase);
    expect(Object.isFrozen(cases)).toBe(false);
    const valid = pendingCorrectedFixture();
    const before = structuredClone(valid);
    expect(() => makeUsDatasetCorrectedTransformationInput(refs, valid)).toThrow(
      "us_dataset_corrected_transformation_prerequisite_incomplete",
    );
    expect(valid).toEqual(before);
    expect(Object.isFrozen(valid.intent.input)).toBe(false);
  });

  it("distinguishes a valid pending amendment from incompatible or forged prerequisites", () => {
    const pending = pendingCorrectedFixture();
    const before = structuredClone(pending);
    expect(() => makeUsDatasetCorrectedTransformationInput(refs, pending)).toThrow(
      "us_dataset_corrected_transformation_prerequisite_incomplete",
    );
    expect(pending).toEqual(before);
    expect(Object.isFrozen(pending.intent.input)).toBe(false);
    for (const changed of [
      { ...pending, unitKey: "orphan_0001" },
      { ...pending, stage: "receiving" },
      { ...pending, revision: 3 },
      { ...pending, revision: 2 },
      { ...pending, extra: true },
      { ...pending, intent: { ...pending.intent, inputDigest: "a".repeat(64) } },
      { ...pending, intent: { ...pending.intent, operationKey: refs.operationKey } },
      { ...pending, intent: { ...pending.intent, stage: "receiving" } },
      { ...pending, intent: { ...pending.intent, unitKey: "orphan_0001" } },
      { ...pending, intent: { ...pending.intent, input: {} } },
    ])
      expect(() => makeUsDatasetCorrectedTransformationInput(refs, changed)).toThrow(
        "us_dataset_corrected_transformation_dependency_conflict",
      );
    expect(() =>
      makeUsDatasetCorrectedTransformationInput({ ...refs, resultDigest: "c".repeat(64) }, pending),
    ).toThrow("us_dataset_corrected_transformation_dependency_conflict");
    let calls = 0;
    Object.defineProperty(pending.intent, "input", {
      enumerable: true,
      get() {
        calls++;
        return {};
      },
    });
    expect(() => makeUsDatasetCorrectedTransformationInput(refs, pending)).toThrow(
      "us_dataset_corrected_transformation_dependency_conflict",
    );
    expect(calls).toBe(0);
    // Neither half exceeds 256 KiB, but the combined evidence envelope does.
    expect(() =>
      makeUsDatasetCorrectedTransformationInput(
        { ...refs, padding: "x".repeat(140 * 1024) },
        { ...before, padding: "x".repeat(140 * 1024) },
      ),
    ).toThrow("us_dataset_corrected_transformation_dependency_conflict");
  });
});

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("special Receiving codec with actual native service facts", () => {
  let fixture: Awaited<ReturnType<typeof createUsDatasetJournalFixture>> | undefined;
  let acquisition: Promise<void> | undefined;
  const work = new Set<Promise<unknown>>();
  function track<T>(pending: Promise<T>): Promise<T> {
    work.add(pending);
    void pending.then(
      () => work.delete(pending),
      () => work.delete(pending),
    );
    return pending;
  }
  beforeAll(() => {
    if (work.size || acquisition) throw new Error("special_codec_prior_work_live");
    if (!base || process.env.DATABASE_URL)
      throw new Error("Special codec requires isolated US database only");
    acquisition = createUsDatasetJournalFixture(base).then((owned) => {
      fixture = owned;
      console.info(`Owned special codec database: ${owned.databaseName}`);
    });
    return acquisition;
  }, 60_000);
  afterAll(async () => {
    if (acquisition) await Promise.allSettled([acquisition]);
    while (work.size) await Promise.allSettled([...work]);
    if (fixture) {
      console.info(`Special codec work drained: ${fixture.databaseName}`);
      await fixture.close();
    }
  }, 60_000);

  it("accepts actual original/amendment/void facts and rejects embedded UUID aliases", () => {
    if (work.size) throw new Error("special_codec_prior_work_live");
    // The full async phase is registered before provision or any service work can start.
    return track(
      Promise.resolve().then(async () => {
        const f = fixture;
        if (!f) throw new Error("Missing owned special codec fixture");
        const context = await f.provision();
        const journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
        const references = await new UsDatasetReferenceSeedStore(f.db).initialize(context);
        const header = await journal.read(context);
        if (!header) throw new Error("Missing actual dataset header");
        const actualDatasetId = header.id;
        const shared = await journal.readStage(context, header.id, "references", "references");
        if (!shared) throw new Error("Missing actual reference stage");
        const identity = makeUsDatasetReferenceIdentity(header.id, shared);
        const receivingStore = new UsReceivingStore(f.db);
        const documentStore = new UsReferenceDocumentStore(f.db);
        const lotStore = new UsLotStore(f.db);
        const { tenantId, actorUserId } = context;
        const bound = (rows: readonly { key: string; id: string }[], key: string): string => {
          const row = rows.find((item) => item.key === key);
          if (!row) throw new Error("Missing actual reference binding");
          return row.id;
        };
        async function finalize(
          tx: UsMasterDataTransaction,
          eventId: string,
          draftVersion: number,
          operationKey: string,
        ) {
          const ready = await receivingStore.checkRevisionReadinessInTransaction(
            tx,
            tenantId,
            actorUserId,
            eventId,
            { expectedDraftVersion: draftVersion },
          );
          if (ready.state !== "complete" || ready.exemptReviewRequiredLines.length)
            throw new Error("Actual special Receiving incomplete");
          const receipt = await receivingStore.finalizeCommandInTransaction(
            tx,
            tenantId,
            actorUserId,
            eventId,
            {
              commandVersion: 2,
              operationKey,
              expectedDraftVersion: ready.draftVersion,
              expectedLifecycleVersion: ready.expectedLifecycleVersion,
              previousRevisionId: ready.previousRevisionId,
              expectedInputDigest: ready.inputDigest,
              reviewedExemptLines: [],
            },
            operationKey,
          );
          if (!("receiptVersion" in receipt)) throw new Error("Expected actual V2 finalization");
          return receipt;
        }
        async function readLots(tx: UsMasterDataTransaction, record: ReceivingLiveRecord) {
          if (record.content.kind !== "finalized") throw new Error("Expected actual frozen record");
          const lots = [];
          for (const line of record.content.snapshot.items)
            lots.push(await lotStore.getLotInTransaction(tx, tenantId, actorUserId, line.lotId));
          return lots;
        }
        async function original(kind: UsDatasetSpecialKind) {
          const input = makeUsDatasetSpecialInput(kind, "receiving", identity, null);
          const recipe = input.recipe;
          const receivingRecipe =
            "initialReceiving" in recipe ? recipe.initialReceiving : recipe.receiving;
          const definitions =
            "correctedChain" in recipe ? recipe.correctedChain.documents : recipe.documents;
          const operationKey = randomUUID();
          const unitKey = kind === "correction" ? "correction_0001" : "orphan_0001";
          const captured = await journal.captureIntent(context, actualDatasetId, {
            unitKey,
            stage: "receiving",
            operationKey,
            input,
            inputDigest: canonicalExportDigest(input),
          });
          const completed = await journal.runAtomicStage(
            context,
            actualDatasetId,
            captured.revision,
            captured.intent,
            {
              apply: async (tx) => {
                const documents = [];
                for (const number of receivingRecipe.references) {
                  const definition = definitions.find((item) => item.input.number === number);
                  if (!definition) throw new Error("Missing owned document recipe");
                  documents.push({
                    key: definition.key,
                    record: await documentStore.createDocumentInTransaction(
                      tx,
                      tenantId,
                      actorUserId,
                      {
                        ...definition.input,
                        partyId: bound(references.bindings.parties, definition.partyKey),
                      },
                      operationKey,
                    ),
                  });
                }
                const sourceId = bound(
                  references.bindings.locations,
                  receivingRecipe.previousSourceLocationKey,
                );
                const draft: ReceivingDraft = {
                  dateReceived: receivingRecipe.eventDate,
                  locationId: bound(
                    references.bindings.locations,
                    receivingRecipe.receivingLocationKey,
                  ),
                  previousSourceLocationId: sourceId,
                  receivedAtNote: null,
                  notes: null,
                  documentIds: documents.map(({ record }) => record.id),
                  items: receivingRecipe.lines.map((line) => ({
                    productId: bound(references.bindings.products, line.productKey),
                    lotLinkMode: "create_on_finalize",
                    lotId: null,
                    tlc: line.tlc,
                    source: { kind: "location", locationId: sourceId },
                    quantity: line.quantity,
                    unitOfMeasure: line.unitOfMeasure,
                    exemptSupplier: false,
                    exemptReason: null,
                    exemptReceipt: null,
                    supplierLotReference: null,
                    notes: null,
                  })),
                };
                const created = await receivingStore.createDraftCommandInTransaction(
                  tx,
                  tenantId,
                  actorUserId,
                  { operationKey, draft },
                  operationKey,
                );
                if (!("receiptVersion" in created)) throw new Error("Expected actual V2 creation");
                const finalized = await finalize(
                  tx,
                  created.eventId,
                  created.record.draftVersion,
                  operationKey,
                );
                const raw = {
                  stage: "receiving" as const,
                  input,
                  documents,
                  created,
                  finalized,
                  lots: await readLots(tx, finalized.record),
                };
                const result = parseUsDatasetSpecialResult(raw);
                if (result.stage !== "receiving") throw new Error("Expected original stage result");
                expect(result).toEqual(raw);
                expect(Object.isFrozen(result.created.record.lifecycle)).toBe(true);
                return {
                  result,
                  resultDigest: canonicalExportDigest(result),
                  recordIds: usDatasetSpecialRecordIds(result),
                };
              },
              // Codec witness only; canonical native-row/history verification belongs to Task 2.
              verify: async (_tx, _context, _intent, receipt) => {
                parseUsDatasetSpecialResult(receipt.result);
              },
            },
          );
          if (!completed.receipt) throw new Error("Missing actual original receipt");
          const result = parseUsDatasetSpecialResult(completed.receipt.result);
          if (result.stage !== "receiving") throw new Error("Expected actual original result");
          return {
            result,
            identity: makeUsDatasetSpecialStageIdentity(actualDatasetId, completed),
          };
        }
        const correction = await original("correction");
        const corrected = await f.db.transaction(
          async (tx) => {
            const input = makeUsDatasetSpecialInput(
              "correction",
              "amend_receiving",
              identity,
              correction.identity,
            );
            if (!("amendmentReason" in input.recipe)) throw new Error("Expected correction recipe");
            const operationKey = randomUUID();
            const started = await receivingStore.amendInTransaction(
              tx,
              tenantId,
              actorUserId,
              correction.result.finalized.eventId,
              {
                commandVersion: 2,
                operationKey,
                expectedLifecycleVersion: 2,
                reason: input.recipe.amendmentReason,
              },
              operationKey,
            );
            if (started.record.content.kind !== "draft")
              throw new Error("Expected actual amendment draft");
            const draft = receivingAmendmentDraftSchema.parse(started.record.content.draft);
            const first = draft.items[0];
            if (!first) throw new Error("Expected retained first line");
            first.quantity = "300";
            const saved = await receivingStore.saveAmendmentInTransaction(
              tx,
              tenantId,
              actorUserId,
              started.eventId,
              {
                commandVersion: 2,
                operationKey,
                expectedDraftVersion: 1,
                expectedLifecycleVersion: 3,
                draft,
              },
              operationKey,
            );
            const finalized = await finalize(
              tx,
              saved.eventId,
              saved.record.draftVersion,
              operationKey,
            );
            const predecessor = await receivingStore.getLiveRecordInTransaction(
              tx,
              tenantId,
              actorUserId,
              correction.result.finalized.eventId,
            );
            return {
              stage: "amend_receiving" as const,
              input,
              original: correction.result,
              started,
              saved,
              finalized,
              predecessor,
              lots: await readLots(tx, finalized.record),
            };
          },
          { isolationLevel: "repeatable read" },
        );
        const acceptedCorrection = parseUsDatasetSpecialResult(corrected);
        expect(acceptedCorrection).toEqual(corrected);
        expect(corrected.finalized.record.lifecycle.lifecycleVersion).toBe(4);
        const orphan = await original("orphan");
        const voided = await f.db.transaction(
          async (tx) => {
            const input = makeUsDatasetSpecialInput(
              "orphan",
              "void_receiving",
              identity,
              orphan.identity,
            );
            if (!("voidReason" in input.recipe)) throw new Error("Expected orphan recipe");
            const operationKey = randomUUID();
            const receipt = await receivingStore.voidInTransaction(
              tx,
              tenantId,
              actorUserId,
              orphan.result.finalized.eventId,
              {
                commandVersion: 2,
                operationKey,
                expectedLifecycleVersion: 2,
                expectedDraftVersion: null,
                reason: input.recipe.voidReason,
              },
              operationKey,
            );
            return {
              stage: "void_receiving" as const,
              input,
              original: orphan.result,
              voided: receipt,
              lots: await readLots(tx, receipt.record),
            };
          },
          { isolationLevel: "repeatable read" },
        );
        expect(parseUsDatasetSpecialResult(voided)).toEqual(voided);
        expect(voided.voided.record.lifecycle.lifecycleVersion).toBe(3);
        // Completed-row codec witness only: this test did not publish an amendment journal row.
        const amendmentStage = structuredClone({
          unitKey: "correction_0001" as const,
          stage: "amend_receiving" as const,
          revision: 2,
          intent: {
            unitKey: "correction_0001",
            stage: "amend_receiving" as const,
            operationKey: corrected.started.operationKey,
            input: corrected.input,
            inputDigest: canonicalExportDigest(corrected.input),
          },
          receipt: {
            result: corrected,
            resultDigest: canonicalExportDigest(corrected),
            recordIds: usDatasetSpecialRecordIds(acceptedCorrection),
          },
        });
        const callerReferences = structuredClone(identity);
        const beforeAmendment = structuredClone(amendmentStage);
        const correctedInput = makeUsDatasetCorrectedTransformationInput(
          callerReferences,
          amendmentStage,
        );
        expect(correctedInput.amendment).toEqual({
          datasetId: actualDatasetId,
          unitKey: "correction_0001",
          stage: "amend_receiving",
          revision: 2,
          operationKey: corrected.started.operationKey,
          inputDigest: canonicalExportDigest(corrected.input),
          resultDigest: canonicalExportDigest(corrected),
        });
        expect(correctedInput.receivingOrigin).toEqual({
          rootId: correction.result.finalized.eventId,
          eventId: corrected.finalized.eventId,
          revision: 2,
          lifecycleVersion: 4,
          inputLots: [
            { lineNo: 1, lotId: correction.result.lots[0]?.id },
            { lineNo: 2, lotId: correction.result.lots[1]?.id },
          ],
        });
        expect(correctedInput.receivingOrigin.eventId).not.toBe(
          correction.result.finalized.eventId,
        );
        expect(correctedInput.chain.transformation.inputs.map(({ quantity }) => quantity)).toEqual([
          "300",
          "400",
        ]);
        expect(correctedInput.chain.transformation.output.quantity).toBe("60");
        expect(correctedInput.chain.transformation.eventDate).toBe("2026-06-11");
        expect(Object.isFrozen(correctedInput.amendment)).toBe(true);
        expect(Object.isFrozen(correctedInput.receivingOrigin.inputLots[0])).toBe(true);
        expect(Object.isFrozen(amendmentStage.intent.input)).toBe(false);
        expect(Object.isFrozen(amendmentStage.receipt.result)).toBe(false);
        expect(Object.isFrozen(callerReferences)).toBe(false);
        expect(amendmentStage).toEqual(beforeAmendment);
        expect(callerReferences).toEqual(identity);
        const conflictingInput = {
          ...corrected.input,
          references: { ...identity, resultDigest: "f".repeat(64) },
        };
        for (const forged of [
          { ...amendmentStage, unitKey: "orphan_0001" },
          { ...amendmentStage, stage: "receiving" },
          { ...amendmentStage, stage: "void_receiving" },
          { ...amendmentStage, revision: 1 },
          { ...amendmentStage, revision: 3 },
          { ...amendmentStage, extra: true },
          { ...amendmentStage, intent: { ...amendmentStage.intent, operationKey: randomUUID() } },
          {
            ...amendmentStage,
            intent: {
              ...amendmentStage.intent,
              input: conflictingInput,
              inputDigest: canonicalExportDigest(conflictingInput),
            },
          },
          {
            ...amendmentStage,
            receipt: {
              ...amendmentStage.receipt,
              recordIds: [...amendmentStage.receipt.recordIds].reverse(),
            },
          },
          { ...amendmentStage, receipt: { ...amendmentStage.receipt, recordIds: [] } },
          {
            ...amendmentStage,
            receipt: { ...amendmentStage.receipt, resultDigest: "f".repeat(64) },
          },
          ...[correction.result, voided].map((result) => ({
            ...amendmentStage,
            receipt: {
              result,
              resultDigest: canonicalExportDigest(result),
              recordIds: usDatasetSpecialRecordIds(result),
            },
          })),
        ])
          expect(() => makeUsDatasetCorrectedTransformationInput(identity, forged)).toThrow(
            "us_dataset_corrected_transformation_dependency_conflict",
          );
        expect(() =>
          makeUsDatasetCorrectedTransformationInput(
            { ...identity, datasetId: randomUUID() },
            amendmentStage,
          ),
        ).toThrow("us_dataset_corrected_transformation_dependency_conflict");
        expect(() =>
          makeUsDatasetCorrectedTransformationInput(
            { ...identity, resultDigest: "f".repeat(64) },
            amendmentStage,
          ),
        ).toThrow("us_dataset_corrected_transformation_dependency_conflict");
        console.info(
          "Corrected Transformation completed-row codec witness accepted; amendment journal persistence not claimed",
        );
        console.info("Actual special codec positives accepted: original, correction, orphan");

        function aliasOriginal(raw: UsDatasetSpecialReceivingResult) {
          const copy = structuredClone(raw);
          for (const receipt of [copy.created, copy.finalized]) {
            receipt.record.id = receipt.record.id.toUpperCase();
            receipt.record.lifecycle.rootId = receipt.record.lifecycle.rootId.toUpperCase();
            if (receipt.record.lifecycle.currentEventId)
              receipt.record.lifecycle.currentEventId =
                receipt.record.lifecycle.currentEventId.toUpperCase();
            if (receipt.record.lifecycle.pendingDraftId)
              receipt.record.lifecycle.pendingDraftId =
                receipt.record.lifecycle.pendingDraftId.toUpperCase();
          }
          return copy;
        }
        for (const result of [correction.result, orphan.result]) {
          const alias = aliasOriginal(result);
          // A numeric-only UUID has no uppercase alias to reject.
          if (alias.created.record.id === result.created.record.id) continue;
          expect
            .soft(() => parseUsDatasetSpecialResult(alias), "embedded original identity aliases")
            .toThrow("us_dataset_special_result_invalid");
        }
        const aliasCorrection = structuredClone(corrected);
        for (const receipt of [
          aliasCorrection.started,
          aliasCorrection.saved,
          aliasCorrection.finalized,
        ]) {
          const record = receipt.record;
          record.id = record.id.toUpperCase();
          if (record.lifecycle.pendingDraftId === receipt.eventId)
            record.lifecycle.pendingDraftId = record.lifecycle.pendingDraftId.toUpperCase();
          if (record.lifecycle.currentEventId === receipt.eventId)
            record.lifecycle.currentEventId = record.lifecycle.currentEventId.toUpperCase();
        }
        aliasCorrection.predecessor.lifecycle.currentEventId = aliasCorrection.finalized.record.id;
        aliasCorrection.predecessor.lifecycle.supersededByEventId =
          aliasCorrection.finalized.record.id;
        if (aliasCorrection.started.record.id !== corrected.started.record.id)
          expect
            .soft(
              () => parseUsDatasetSpecialResult(aliasCorrection),
              "embedded amendment identity aliases",
            )
            .toThrow("us_dataset_special_result_invalid");
        // Independently mutate every non-null UUID on all other live-record identity fields.
        const records: ReceivingLiveRecord[] = [
          corrected.started.record,
          corrected.saved.record,
          corrected.finalized.record,
          corrected.predecessor,
          voided.voided.record,
        ];
        for (const record of records) {
          for (const field of [
            "rootId",
            "previousRevisionId",
            "supersededByEventId",
            "currentEventId",
            "pendingDraftId",
          ] as const) {
            const value = record.lifecycle[field];
            if (value === null || value.toUpperCase() === value) continue;
            const copy = structuredClone(record);
            copy.lifecycle[field] = value.toUpperCase();
            const result =
              record === voided.voided.record
                ? { ...voided, voided: { ...voided.voided, record: copy } }
                : record === corrected.predecessor
                  ? { ...corrected, predecessor: copy }
                  : record === corrected.started.record
                    ? { ...corrected, started: { ...corrected.started, record: copy } }
                    : record === corrected.saved.record
                      ? { ...corrected, saved: { ...corrected.saved, record: copy } }
                      : { ...corrected, finalized: { ...corrected.finalized, record: copy } };
            expect
              .soft(() => parseUsDatasetSpecialResult(result), `embedded lifecycle ${field} alias`)
              .toThrow("us_dataset_special_result_invalid");
          }
        }
      }),
    );
  }, 60_000);
});

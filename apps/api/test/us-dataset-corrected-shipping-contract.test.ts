import { canonicalExportDigest } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import {
  makeUsDatasetCorrectedShippingPlan,
  makeUsDatasetCorrectedShippingInput,
  parseUsDatasetCorrectedShippingInput,
  type UsDatasetCorrectedShippingInput,
} from "../src/modules/traceability/demo/us-dataset-corrected-shipping-contract";
import {
  makeUsSixMonthSpecialExamples,
  usSixMonthDefinition,
} from "../src/modules/traceability/demo/us-six-month-definition";

const uuid = (n: number) => `abcdefab-1234-4234-8234-${String(n).padStart(12, "0")}`;
function fixture(): UsDatasetCorrectedShippingInput {
  const casesInput: UsDatasetCorrectedShippingInput["casesInput"] = {
    codec: "us-dataset-corrected-cases-input-v1",
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
    transformation: {
      datasetId: uuid(1),
      unitKey: "correction_0001",
      stage: "transformation",
      revision: 2,
      operationKey: uuid(70),
      inputDigest: "e".repeat(64),
      resultDigest: "f".repeat(64),
    },
    transformationOrigin: { rootId: uuid(60), eventId: uuid(60), revision: 1, lifecycleVersion: 2 },
    outputLotId: uuid(61),
    outputProductId: uuid(51),
    support: {
      capturedAt: "2026-10-09T12:00:00.000Z",
      shiftId: uuid(100),
      numberMonthKey: "OCT26",
      numberSeq: 261,
      boxes: makeUsSixMonthSpecialExamples().correction.correctedChain.cases.map((sscc, index) => ({
        id: uuid(101 + index),
        deviceBoxId: `corrected-case-${index + 1}`,
        sscc,
      })),
    },
  };
  return {
    codec: "us-dataset-corrected-shipping-input-v1",
    version: "us-processor-six-month-v1",
    definitionDigest: usSixMonthDefinition.digest,
    casesInput,
    cases: {
      datasetId: uuid(1),
      unitKey: "correction_0001",
      stage: "cases",
      revision: 2,
      operationKey: uuid(80),
      inputDigest: canonicalExportDigest(casesInput),
      resultDigest: "a".repeat(64),
    },
    chain: makeUsSixMonthSpecialExamples().correction.correctedChain,
  };
}

describe("corrected Shipping input contract", () => {
  // Break caught: omitting the corrected shipment or treating lot quantity as SSCC allocation.
  it("plans one corrected lot shipment leaving ten forecast cases", () => {
    const plan = makeUsDatasetCorrectedShippingPlan(fixture());
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      shipmentNo: 1,
      eventDate: "2026-06-12",
      quantity: "50",
      unitOfMeasure: "case",
      shippingLocationKey: "processor",
      recipientLocationKey: "recipient_02",
      outputLotId: uuid(61),
      outputProductId: uuid(51),
      plannedAvailableBefore: "60",
      plannedRemainingAfter: "10",
    });
    expect(plan[0]?.references).toEqual([
      "MUS-correction_0001-shipping_01-bol",
      "MUS-correction_0001-shipping_01-invoice",
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan[0])).toBe(true);
    expect(Object.isFrozen(plan[0]?.references)).toBe(true);
  });
  // Break caught: retained caller references or freezing caller evidence as a side effect.
  it("owns and deeply freezes parsed evidence and each independent plan", () => {
    const raw = structuredClone(fixture());
    const parsed = parseUsDatasetCorrectedShippingInput(raw);
    expect(parsed).toEqual(raw);
    function frozen(value: unknown): void {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) frozen(child);
    }
    frozen(parsed);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Object.isFrozen(raw.casesInput.support.boxes[0])).toBe(false);
    const a = makeUsDatasetCorrectedShippingPlan(parsed),
      b = makeUsDatasetCorrectedShippingPlan(parsed);
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    expect(a[0]?.references).not.toBe(b[0]?.references);
    Object.assign(raw.casesInput, { outputLotId: uuid(999) });
    expect(parsed.casesInput.outputLotId).toBe(uuid(61));
  });
  // Break caught: accepting regular aliases, forged binding, recipe drift or normalized saved values.
  it.each([
    "extra",
    "codec",
    "version",
    "definition",
    "index",
    "cases extra",
    "dataset",
    "unit",
    "stage",
    "revision",
    "operation uuid",
    "digest uppercase",
    "digest mismatch",
    "result digest",
    "input extra",
    "input codec",
    "input dataset",
    "input quantity",
    "input uuid",
    "support whitespace",
    "chain extra",
    "shipping date",
    "shipping quantity",
    "shipping recipient",
    "document order",
    "case order",
    "output quantity",
  ])("rejects %s without diagnostic evidence leakage", (kind) => {
    const raw = structuredClone(fixture());
    const shipment = raw.chain.shipping[0];
    if (!shipment) throw new Error("Missing handchecked shipment");
    switch (kind) {
      case "extra":
        Object.assign(raw, { extra: true });
        break;
      case "codec":
        Object.assign(raw, { codec: "us-dataset-shipping-v1" });
        break;
      case "version":
        Object.assign(raw, { version: "other" });
        break;
      case "definition":
        Object.assign(raw, { definitionDigest: "0".repeat(64) });
        break;
      case "index":
        Object.assign(raw, { index: 0 });
        break;
      case "cases extra":
        Object.assign(raw.cases, { extra: true });
        break;
      case "dataset":
        Object.assign(raw.cases, { datasetId: uuid(999) });
        break;
      case "unit":
        Object.assign(raw.cases, { unitKey: "chain_0001" });
        break;
      case "stage":
        Object.assign(raw.cases, { stage: "shipping" });
        break;
      case "revision":
        Object.assign(raw.cases, { revision: 1 });
        break;
      case "operation uuid":
        Object.assign(raw.cases, { operationKey: uuid(80).toUpperCase() });
        break;
      case "digest uppercase":
        Object.assign(raw.cases, { inputDigest: "A".repeat(64) });
        break;
      case "digest mismatch":
        Object.assign(raw.cases, { inputDigest: "0".repeat(64) });
        break;
      case "result digest":
        Object.assign(raw.cases, { resultDigest: "bad" });
        break;
      case "input extra":
        Object.assign(raw.casesInput, { extra: true });
        break;
      case "input codec":
        Object.assign(raw.casesInput, { codec: "us-dataset-cases-v1" });
        break;
      case "input dataset":
        Object.assign(raw.casesInput.references, { datasetId: uuid(999) });
        break;
      case "input quantity":
        Object.assign(raw.casesInput.support, { numberSeq: 260 });
        break;
      case "input uuid":
        Object.assign(raw.casesInput, { outputLotId: uuid(61).toUpperCase() });
        break;
      case "support whitespace":
        Object.assign(raw.casesInput.support.boxes[0] ?? {}, { deviceBoxId: " drift " });
        break;
      case "chain extra":
        Object.assign(raw.chain, { extra: true });
        break;
      case "shipping date":
        Object.assign(shipment, { eventDate: "2026-06-13" });
        break;
      case "shipping quantity":
        Object.assign(shipment, { quantity: "050" });
        break;
      case "shipping recipient":
        Object.assign(shipment, { recipientLocationKey: "recipient_01" });
        break;
      case "document order":
        Object.assign(shipment, { references: [...shipment.references].reverse() });
        break;
      case "case order":
        Object.assign(raw.chain, { cases: [...raw.chain.cases].reverse() });
        break;
      case "output quantity":
        Object.assign(raw.chain.transformation.output, { quantity: "61" });
        break;
    }
    for (const read of [
      () => parseUsDatasetCorrectedShippingInput(raw),
      () => makeUsDatasetCorrectedShippingPlan(raw),
    ]) {
      expect(read).toThrow("us_dataset_corrected_shipping_input_invalid");
      try {
        read();
      } catch (error) {
        expect(error).toMatchObject({
          message: "us_dataset_corrected_shipping_input_invalid",
          unitKey: "correction_0001",
          stage: "shipping",
        });
        expect(error instanceof Error && error.cause).toBeTruthy();
      }
    }
  });
  // Break caught: caller accessors/iterators execute before the complete guarded envelope is checked.
  it.each([
    "getter",
    "inherited getter",
    "symbol",
    "cycle",
    "date",
    "nan",
    "infinity",
    "array prototype",
    "array getter",
    "oversize",
  ])("rejects JSON hazard %s before reading caller properties", (kind) => {
    const raw = structuredClone(fixture());
    let reads = 0;
    const getter = () => {
      reads++;
      throw new Error("caller data must not execute");
    };
    switch (kind) {
      case "getter":
        Object.defineProperty(raw, "cases", { enumerable: true, get: getter });
        break;
      case "inherited getter":
        Object.setPrototypeOf(raw, {
          get extra() {
            return getter();
          },
        });
        break;
      case "symbol":
        Object.assign(raw, { [Symbol("bad")]: true });
        break;
      case "cycle":
        Object.assign(raw, { self: raw });
        break;
      case "date":
        Object.assign(raw, { extra: new Date() });
        break;
      case "nan":
        Object.assign(raw, { extra: Number.NaN });
        break;
      case "infinity":
        Object.assign(raw, { extra: Infinity });
        break;
      case "array prototype":
        Object.setPrototypeOf(raw.casesInput.support.boxes, {
          get [Symbol.iterator]() {
            return getter();
          },
        });
        break;
      case "array getter":
        Object.defineProperty(raw.casesInput.support.boxes, "0", { enumerable: true, get: getter });
        break;
      case "oversize":
        Object.assign(raw, { extra: "x".repeat(256 * 1024) });
        break;
    }
    expect(() => parseUsDatasetCorrectedShippingInput(raw)).toThrow(
      "us_dataset_corrected_shipping_input_invalid",
    );
    for (let position = 0; position < 4; position++) {
      const parts: unknown[] = [null, null, null, null];
      parts[position] = raw;
      expect(() =>
        makeUsDatasetCorrectedShippingInput(parts[0], parts[1], parts[2], parts[3]),
      ).toThrow("us_dataset_corrected_shipping_dependency_conflict");
    }
    expect(reads).toBe(0);
    expect(Object.isFrozen(raw)).toBe(false);
  });
  // Break caught: individually bounded pieces accepted although their combined envelope exceeds 256 KiB.
  it("bounds combined factory evidence before any individual codec reads", () => {
    let reads = 0;
    const cases = Object.defineProperty({}, "intent", {
      enumerable: true,
      get() {
        reads++;
        return null;
      },
    });
    expect(() =>
      makeUsDatasetCorrectedShippingInput(
        { padding: "a".repeat(140000) },
        { padding: "b".repeat(140000) },
        {},
        cases,
      ),
    ).toThrow("us_dataset_corrected_shipping_dependency_conflict");
    expect(reads).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import {
  makeUsDatasetShippingInput,
  makeUsDatasetShippingPlan,
  parseUsDatasetShippingInput,
  type UsDatasetShippingInput,
} from "../src/modules/traceability/demo/us-dataset-shipping-contract.js";

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
  ...references,
  unitKey: "chain_0259",
  stage: "receiving" as const,
};
const transformation = { ...receiving, stage: "transformation" as const };
const outputLotId = "00000000-0000-4000-8000-000000000005";
const outputProductId = "00000000-0000-4000-8000-000000000006";

// Missing shipping projection, wrong quantities, or current-stock semantics break this assertion.
it("forecasts Scenario A's single 100-case shipment from recipe output", () => {
  expect(makeUsDatasetShippingPlan(inputFor(259))).toEqual([
    {
      shipmentNo: 1,
      eventDate: "2026-09-16",
      quantity: "100",
      unitOfMeasure: "case",
      shippingLocationKey: "processor",
      recipientLocationKey: "recipient",
      references: ["BOL-0916-H", "INV-2026-0916-047"],
      outputLotId,
      outputProductId,
      plannedAvailableBefore: "100",
      plannedRemainingAfter: "0",
    },
  ]);
});

function inputFor(index: number): UsDatasetShippingInput {
  const unitKey = `chain_${String(index).padStart(4, "0")}`;
  return makeUsDatasetShippingInput(
    index,
    references,
    { ...receiving, unitKey },
    { ...transformation, unitKey },
    outputLotId,
    outputProductId,
  );
}
function mutableInput(index = 0) {
  return structuredClone(inputFor(index));
}
function checkFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) checkFrozen(child);
}
function errorFor(run: () => unknown): Error & { unitKey?: string; stage?: string } {
  try {
    run();
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw cause;
  }
  throw new Error("expected Shipping rejection");
}

describe("fixed Shipping recipe forecasts", () => {
  it.each([
    [0, ["22", "23"], ["55", "33"], ["33", "10"]],
    [1, ["26", "39"], ["65", "39"], ["39", "0"]],
    [179, ["28", "42"], ["70", "42"], ["42", "0"]],
    [180, ["45"], ["45"], ["0"]],
    [181, ["57"], ["75"], ["18"]],
    [258, ["60"], ["60"], ["0"]],
  ])("preserves hand-derived balances for chain %i", (index, quantities, before, after) => {
    const plan = makeUsDatasetShippingPlan(inputFor(index));
    expect(plan.map((row) => row.quantity)).toEqual(quantities);
    expect(plan.map((row) => row.plannedAvailableBefore)).toEqual(before);
    expect(plan.map((row) => row.plannedRemainingAfter)).toEqual(after);
  });

  it("censuses all 260 chains and 440 shipments with independent literal totals", () => {
    // Output counts repeat these eight hand-enumerated values, then 60 and 100.
    const counts = [55, 65, 50, 70, 45, 75, 40, 80];
    let shipments = 0,
      produced = 0,
      shipped = 0,
      retained = 0,
      full = 0,
      partial = 0;
    const months = new Map<string, number>();
    for (let index = 0; index < 260; index++) {
      const input = inputFor(index);
      const plan = makeUsDatasetShippingPlan(input);
      const count = index === 259 ? 100 : index === 258 ? 60 : counts[index % 8];
      if (count === undefined) throw new Error("missing literal output count");
      expect(input.chain.transformation.output.quantity).toBe(String(count));
      expect(plan).toHaveLength(index < 180 ? 2 : 1);
      let available = count;
      for (const [position, row] of plan.entries()) {
        expect(row.shipmentNo).toBe(position + 1);
        expect(row.plannedAvailableBefore).toBe(String(available));
        expect(row.unitOfMeasure).toBe("case");
        expect(row.outputLotId).toBe(outputLotId);
        expect(row.outputProductId).toBe(outputProductId);
        expect(row.shippingLocationKey).toBe("processor");
        const amount = Number(row.quantity);
        expect(Number.isSafeInteger(amount) && amount > 0).toBe(true);
        available -= amount;
        expect(available).toBeGreaterThanOrEqual(0);
        expect(row.plannedRemainingAfter).toBe(String(available));
        expect(row.references).toHaveLength(2);
        const month = row.eventDate.slice(0, 7);
        months.set(month, (months.get(month) ?? 0) + 1);
        shipped += amount;
      }
      shipments += plan.length;
      produced += count;
      retained += available;
      if (available === 0) full++;
      else partial++;
    }
    expect({ shipments, produced, shipped, retained, full, partial }).toEqual({
      shipments: 440,
      produced: 15640,
      shipped: 14347,
      retained: 1293,
      full: 161,
      partial: 99,
    });
    expect([...months]).toEqual([
      ["2026-04", 68],
      ["2026-05", 76],
      ["2026-06", 84],
      ["2026-07", 92],
      ["2026-08", 68],
      ["2026-09", 52],
    ]);
  });

  it("retains recipe dates, recipient order and document numbers on a split shipment", () => {
    const plan = makeUsDatasetShippingPlan(inputFor(0));
    expect(plan.map((row) => [row.eventDate, row.recipientLocationKey, row.references])).toEqual([
      [
        "2026-04-03",
        "recipient",
        ["MUS-chain_0000-shipping_01-bol", "MUS-chain_0000-shipping_01-invoice"],
      ],
      [
        "2026-04-06",
        "recipient_02",
        ["MUS-chain_0000-shipping_02-bol", "MUS-chain_0000-shipping_02-invoice"],
      ],
    ]);
  });
});

describe("Shipping validation and ownership", () => {
  it.each([-1, 260, 0.5, NaN, Infinity, -Infinity, -0])("rejects index %s", (index) => {
    expect(errorFor(() => inputFor(index))).toMatchObject({
      message: "us_dataset_shipping_input_invalid",
      stage: "shipping",
      unitKey: "unknown",
    });
  });

  it.each(["references", "receiving", "transformation"] as const)(
    "rejects cross-dataset %s",
    (key) => {
      const input = mutableInput();
      Reflect.set(input[key], "datasetId", outputLotId);
      expect(errorFor(() => parseUsDatasetShippingInput(input))).toMatchObject({
        message: "us_dataset_shipping_dependency_conflict",
        stage: "shipping",
        unitKey: "chain_0000",
      });
    },
  );
  it.each(["receiving", "transformation"] as const)("rejects cross-chain %s", (key) => {
    const input = mutableInput();
    Reflect.set(input[key], "unitKey", "chain_0001");
    expect(errorFor(() => parseUsDatasetShippingInput(input)).message).toBe(
      "us_dataset_shipping_dependency_conflict",
    );
  });
  it("uses the same dependency-conflict classification in the builder", () => {
    const error = errorFor(() =>
      makeUsDatasetShippingInput(
        259,
        references,
        { ...receiving, unitKey: "chain_0258" },
        transformation,
        outputLotId,
        outputProductId,
      ),
    );
    expect(error).toMatchObject({
      message: "us_dataset_shipping_dependency_conflict",
      unitKey: "chain_0259",
      stage: "shipping",
    });
    expect(error.cause).toBeInstanceOf(Error);
  });
  it.each([
    ["stage", "cases"],
    ["revision", 1],
    ["inputDigest", "bad"],
    ["resultDigest", "A".repeat(64)],
    ["operationKey", "not-uuid"],
    ["datasetId", "not-uuid"],
  ] as const)("rejects malformed identity %s", (field, value) => {
    for (const key of ["references", "receiving", "transformation"] as const) {
      const input = mutableInput();
      Reflect.set(input[key], field, value);
      expect(errorFor(() => parseUsDatasetShippingInput(input)).message).toBe(
        "us_dataset_shipping_input_invalid",
      );
    }
  });
  it.each(["outputLotId", "outputProductId"] as const)(
    "rejects invalid or normalized %s",
    (key) => {
      for (const value of [
        "bad",
        " 00000000-0000-4000-8000-000000000005",
        "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      ]) {
        const input = mutableInput();
        Reflect.set(input, key, value);
        expect(() => parseUsDatasetShippingInput(input)).toThrow(
          "us_dataset_shipping_input_invalid",
        );
      }
    },
  );
  it.each(["codec", "version", "definitionDigest"] as const)("rejects changed %s", (key) => {
    const input = mutableInput();
    Reflect.set(input, key, "drift");
    expect(() => parseUsDatasetShippingInput(input)).toThrow("us_dataset_shipping_input_invalid");
  });
  it("rejects extra fields at the root and every nested identity", () => {
    for (const location of ["root", "references", "receiving", "transformation"] as const) {
      const input = mutableInput();
      Reflect.set(location === "root" ? input : input[location], "extra", true);
      expect(() => parseUsDatasetShippingInput(input)).toThrow("us_dataset_shipping_input_invalid");
    }
  });
  it.each([
    "quantity",
    "eventDate",
    "unitOfMeasure",
    "recipientLocationKey",
    "references",
    "tlc",
  ] as const)("rejects shipment %s drift", (key) => {
    const input = mutableInput();
    const row = input.chain.shipping[0];
    if (!row) throw new Error("missing shipment");
    Reflect.set(
      row,
      key,
      key === "references" ? ["other-document"] : key === "quantity" ? "22.0" : "changed",
    );
    expect(() => parseUsDatasetShippingInput(input)).toThrow("us_dataset_shipping_input_invalid");
  });
  it("rejects document, output quantity and index/chain drift", () => {
    const mutations = [
      (input: UsDatasetShippingInput) =>
        Reflect.set(input.chain.documents[0]?.input ?? {}, "number", "other"),
      (input: UsDatasetShippingInput) =>
        Reflect.set(input.chain.transformation.output, "quantity", "999"),
      (input: UsDatasetShippingInput) => Reflect.set(input, "index", 1),
      (input: UsDatasetShippingInput) => Reflect.set(input.chain, "extra", true),
      (input: UsDatasetShippingInput) =>
        Reflect.set(input.chain, "shipping", [...input.chain.shipping].reverse()),
    ];
    for (const mutate of mutations) {
      const input = mutableInput();
      mutate(input);
      expect(() => parseUsDatasetShippingInput(input)).toThrow("us_dataset_shipping_input_invalid");
    }
  });
  it("copies and freezes input and plan without freezing or aliasing caller objects", () => {
    const raw = mutableInput();
    const before = structuredClone(raw);
    const parsed = parseUsDatasetShippingInput(raw);
    const plan = makeUsDatasetShippingPlan(raw);
    checkFrozen(parsed);
    checkFrozen(plan);
    expect(raw).toEqual(before);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Object.isFrozen(raw.chain.shipping)).toBe(false);
    expect(parsed.chain).not.toBe(raw.chain);
    expect(parsed.references).not.toBe(raw.references);
    expect(parsed.chain.shipping[0]?.references).not.toBe(raw.chain.shipping[0]?.references);
    expect(plan[0]?.references).not.toBe(raw.chain.shipping[0]?.references);
    Reflect.set(raw.references, "resultDigest", "c".repeat(64));
    Reflect.set(raw.chain.shipping[0] ?? {}, "quantity", "999");
    expect(parsed.references.resultDigest).toBe("b".repeat(64));
    expect(plan[0]?.quantity).toBe("22");
    expect(Reflect.set(plan[0] ?? {}, "quantity", "1")).toBe(false);
    expect(() => makeUsDatasetShippingPlan(raw)).toThrow("us_dataset_shipping_input_invalid");
  });
});

describe("descriptor-safe bounded Shipping input", () => {
  it.each(["root", "chain", "identity", "shipment", "array", "toJSON"])(
    "never evaluates a raw %s getter",
    (location) => {
      const input = mutableInput();
      let reads = 0;
      const owner =
        location === "root" || location === "toJSON"
          ? input
          : location === "chain"
            ? input.chain
            : location === "identity"
              ? input.receiving
              : location === "shipment"
                ? input.chain.shipping[0]
                : input.chain.shipping;
      if (!owner) throw new Error("missing getter owner");
      const key =
        location === "root"
          ? "index"
          : location === "chain"
            ? "unitKey"
            : location === "identity"
              ? "unitKey"
              : location === "shipment"
                ? "quantity"
                : location === "array"
                  ? "0"
                  : "toJSON";
      Object.defineProperty(owner, key, {
        enumerable: true,
        get() {
          reads++;
          throw new Error("must not evaluate");
        },
      });
      const error = errorFor(() => parseUsDatasetShippingInput(input));
      expect(reads).toBe(0);
      expect(error).toMatchObject({
        message: "us_dataset_shipping_input_invalid",
        unitKey: "unknown",
        stage: "shipping",
      });
      expect(error.cause).toBeInstanceOf(Error);
    },
  );
  it("never evaluates upstream identity accessors in the builder", () => {
    let reads = 0;
    const upstream = { ...receiving };
    Object.defineProperty(upstream, "unitKey", {
      get() {
        reads++;
        throw new Error("unsafe");
      },
      enumerable: true,
    });
    expect(() =>
      makeUsDatasetShippingInput(
        259,
        references,
        upstream,
        transformation,
        outputLotId,
        outputProductId,
      ),
    ).toThrow("us_dataset_shipping_input_invalid");
    expect(reads).toBe(0);
  });
  it.each([
    "prototype",
    "arrayPrototype",
    "hidden",
    "arrayHidden",
    "symbol",
    "cycle",
    "nonfinite",
    "sparseArray",
    "arrayProperty",
  ])("rejects non-JSON %s", (fault) => {
    const input = mutableInput();
    if (fault === "prototype") Object.setPrototypeOf(input.chain, { inherited: true });
    if (fault === "arrayPrototype")
      Object.setPrototypeOf(input.chain.shipping, Object.create(Array.prototype));
    if (fault === "hidden") Object.defineProperty(input.chain, "hidden", { value: 1 });
    if (fault === "arrayHidden")
      Object.defineProperty(input.chain.shipping, "hidden", { value: 1 });
    if (fault === "symbol") Reflect.set(input.chain, Symbol("hidden"), 1);
    if (fault === "cycle") Reflect.set(input.chain, "cycle", input);
    if (fault === "nonfinite") Reflect.set(input.chain, "value", Infinity);
    if (fault === "sparseArray") Reflect.deleteProperty(input.chain.shipping, "0");
    if (fault === "arrayProperty") Reflect.set(input.chain.shipping, "extra", 1);
    const error = errorFor(() => parseUsDatasetShippingInput(input));
    expect(error.message).toBe("us_dataset_shipping_input_invalid");
    expect(error.cause).toBeInstanceOf(Error);
  });
  it("retains size and depth rejection causes before schema validation", () => {
    const oversized = mutableInput();
    Reflect.set(oversized.chain, "large", "x".repeat(256 * 1024));
    expect(errorFor(() => parseUsDatasetShippingInput(oversized)).cause).toMatchObject({
      message: "us_demo_json_too_large",
    });
    const escaped = mutableInput();
    Reflect.set(escaped.chain, "large", "\n".repeat(132000));
    expect(errorFor(() => parseUsDatasetShippingInput(escaped)).cause).toMatchObject({
      message: "us_demo_json_too_large",
    });
    let nested: unknown = {};
    for (let i = 0; i < 17; i++) nested = { child: nested };
    const deep = mutableInput();
    Reflect.set(deep.chain, "deep", nested);
    expect(errorFor(() => parseUsDatasetShippingInput(deep)).cause).toMatchObject({
      message: "us_demo_json_too_deep",
    });
  });
  it.each([null, [], "json", 1, undefined])(
    "rejects invalid root %s with safe diagnostics",
    (raw) => {
      expect(errorFor(() => parseUsDatasetShippingInput(raw))).toMatchObject({
        message: "us_dataset_shipping_input_invalid",
        unitKey: "unknown",
        stage: "shipping",
      });
    },
  );
});

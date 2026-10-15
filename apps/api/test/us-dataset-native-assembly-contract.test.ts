import { createHash } from "node:crypto";
import { createDb } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";
import { makeUsDatasetNativeAssemblyInput } from "../src/modules/traceability/demo/us-dataset-native-assembly-contract";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import type { UsDatasetContext } from "../src/modules/traceability/demo/us-dataset-contract";
import { UsDatasetNativeSeedStore } from "../src/modules/traceability/demo/us-dataset-native-seed";
import { UsDatasetTraceReadinessStageStore } from "../src/modules/traceability/demo/us-dataset-trace-readiness-stage";
import { UsDatasetTraceReadinessSeedStore } from "../src/modules/traceability/demo/us-dataset-trace-readiness-seed";
import {
  UsDatasetUnitCompositionStore,
  type UsDatasetUnitCompositionResult,
} from "../src/modules/traceability/demo/us-dataset-unit-composition";
import type {
  UsDatasetTraceReadinessResult,
  UsDatasetTraceReadinessUnit,
} from "../src/modules/traceability/demo/us-dataset-trace-readiness";

const invalid = new Error("us_dataset_native_assembly_input_invalid");
const datasetId = "11111111-1111-4111-8111-111111111111";
const syntheticDigest = (label: string): string =>
  createHash("sha256").update(`structural synthetic summary only: ${label}`).digest("hex");

// Hand-derived row keys/counts; these summaries claim no native or database proof.
function syntheticSummaries() {
  const regular = {
    datasetId,
    version: "us-processor-six-month-v1",
    definitionDigest: usSixMonthDefinition.digest,
    range: { startIndex: 0, count: 260 },
    state: "selected_regular_shipping_verified",
    datasetComplete: false,
    chains: Array.from({ length: 260 }, (_, index) => ({
      index,
      unitKey: `chain_${String(index).padStart(4, "0")}`,
      shipmentCount: index < 180 ? 2 : 1,
      shippingResultDigest: syntheticDigest(`regular shipping row ${index}`),
    })),
  };
  const special = {
    datasetId,
    version: "us-processor-six-month-v1",
    definitionDigest: usSixMonthDefinition.digest,
    state: "special_chains_shipping_verified",
    datasetComplete: false,
    correction: {
      unitKey: "correction_0001",
      lifecycleResultDigest: syntheticDigest("correction lifecycle"),
      transformationResultDigest: syntheticDigest("correction transformation"),
      casesResultDigest: syntheticDigest("correction cases"),
      shippingResultDigest: syntheticDigest("correction shipping"),
      shipmentCount: 1,
    },
    orphan: { unitKey: "orphan_0001", lifecycleResultDigest: syntheticDigest("orphan lifecycle") },
  };
  return { regular, special };
}
type Summaries = ReturnType<typeof syntheticSummaries>;
type Mutation = (input: Summaries) => void;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing structural test evidence");
  return value;
}

function evidenceObjects(input: Summaries): object[] {
  return [
    input.regular,
    input.regular.range,
    input.regular.chains,
    required(input.regular.chains[0]),
    input.special,
    input.special.correction,
    input.special.orphan,
  ];
}

function assertFrozenOwned(output: unknown, source: unknown): void {
  if (output === null || typeof output !== "object") return;
  expect(Object.isFrozen(output)).toBe(true);
  expect(output).not.toBe(source);
  const originals = source !== null && typeof source === "object" ? Object.values(source) : [];
  Object.values(output).forEach((child, index) => assertFrozenOwned(child, originals[index]));
}

describe("pure full-native assembly input", () => {
  // Rejecting valid evidence or returning partial/completed evidence breaks this boundary.
  it("accepts the complete structural summaries with their exact owned evidence", () => {
    const { regular, special } = syntheticSummaries();
    expect(() => makeUsDatasetNativeAssemblyInput(regular, special)).not.toThrow();
    const input = makeUsDatasetNativeAssemblyInput(regular, special);
    expect(input.datasetId).toBe("11111111-1111-4111-8111-111111111111");
    expect(input.version).toBe("us-processor-six-month-v1");
    expect(input.definitionDigest).toBe(usSixMonthDefinition.digest);
    expect(input.state).toBe("native_assembly_input_validated");
    expect(input.datasetComplete).toBe(false);
    expect(input.regular.chains).toHaveLength(260);
    expect(input.regular.chains[0]?.unitKey).toBe("chain_0000");
    expect(input.regular.chains[259]?.unitKey).toBe("chain_0259");
    expect(input.regular.chains.reduce((n, row) => n + row.shipmentCount, 0)).toBe(440);
    expect(input.special.correction.shipmentCount).toBe(1);
    expect(input.regular).toEqual(regular);
    expect(input.special).toEqual(special);
    expect(Object.keys(input).sort()).toEqual([
      "datasetComplete",
      "datasetId",
      "definitionDigest",
      "regular",
      "special",
      "state",
      "version",
    ]);
    assertFrozenOwned(input.regular, regular);
    assertFrozenOwned(input.special, special);
    expect(Object.isFrozen(input)).toBe(true);
    evidenceObjects({ regular, special }).forEach((value) =>
      expect(Object.isFrozen(value)).toBe(false),
    );
    required(regular.chains[0]).shippingResultDigest = syntheticDigest("later mutation");
    regular.chains.pop();
    regular.range.count = 1;
    special.correction.shipmentCount = 2;
    special.orphan.lifecycleResultDigest = syntheticDigest("later orphan mutation");
    expect(input.regular.chains).toHaveLength(260);
    expect(input.regular.range.count).toBe(260);
    expect(input.regular.chains[0]?.shippingResultDigest).toBe(
      syntheticDigest("regular shipping row 0"),
    );
    expect(input.special.correction.shipmentCount).toBe(1);
    expect(input.special.orphan.lifecycleResultDigest).toBe(syntheticDigest("orphan lifecycle"));
    expect(() => Reflect.set(input.regular.chains, "0", input.regular.chains[259])).not.toThrow();
    expect(Reflect.set(input.regular.chains, "length", 0)).toBe(false);
    expect(Reflect.set(input.regular.chains[0] ?? {}, "shipmentCount", 99)).toBe(false);
    expect(input.regular.chains[0]?.unitKey).toBe("chain_0000");
    expect(input.regular.chains[0]?.shipmentCount).toBe(2);
    expect(input.regular.chains).toHaveLength(260);
    const next = syntheticSummaries();
    expect(makeUsDatasetNativeAssemblyInput(next.regular, next.special).regular).not.toBe(
      input.regular,
    );
  });

  const mutations: [string, Mutation][] = [
    [
      "partial range",
      ({ regular }) => {
        regular.range.count = 259;
      },
    ],
    [
      "partial range padded to 260 rows",
      ({ regular }) => {
        regular.range = { startIndex: 258, count: 2 };
      },
    ],
    [
      "shifted range",
      ({ regular }) => {
        regular.range.startIndex = 1;
      },
    ],
    [
      "missing row",
      ({ regular }) => {
        regular.chains.pop();
      },
    ],
    [
      "extra row",
      ({ regular }) => {
        regular.chains.push({ ...required(regular.chains[259]) });
      },
    ],
    [
      "reordered rows",
      ({ regular }) => {
        regular.chains.reverse();
      },
    ],
    [
      "duplicate row",
      ({ regular }) => {
        regular.chains[1] = { ...required(regular.chains[0]) };
      },
    ],
    [
      "wrong index",
      ({ regular }) => {
        required(regular.chains[1]).index = 260;
      },
    ],
    [
      "wrong key",
      ({ regular }) => {
        required(regular.chains[259]).unitKey = "chain_259";
      },
    ],
    [
      "recipe count drift with total retained",
      ({ regular }) => {
        required(regular.chains[179]).shipmentCount = 1;
        required(regular.chains[180]).shipmentCount = 2;
      },
    ],
    [
      "duplicate regular digest",
      ({ regular }) => {
        required(regular.chains[1]).shippingResultDigest = required(
          regular.chains[0],
        ).shippingResultDigest;
      },
    ],
    [
      "special shipping reuses regular digest",
      ({ regular, special }) => {
        special.correction.shippingResultDigest = required(
          regular.chains[259],
        ).shippingResultDigest;
      },
    ],
    [
      "wrong correction key",
      ({ special }) => {
        special.correction.unitKey = "correction_0002";
      },
    ],
    [
      "wrong orphan key",
      ({ special }) => {
        special.orphan.unitKey = "orphan_0002";
      },
    ],
    [
      "correction count zero",
      ({ special }) => {
        special.correction.shipmentCount = 0;
      },
    ],
    [
      "correction count two",
      ({ special }) => {
        special.correction.shipmentCount = 2;
      },
    ],
    [
      "sparse chains",
      ({ regular }) => {
        delete regular.chains[0];
      },
    ],
    [
      "negative zero range start",
      ({ regular }) => {
        regular.range.startIndex = -0;
      },
    ],
    [
      "negative zero range count",
      ({ regular }) => {
        regular.range.count = -0;
      },
    ],
    [
      "negative zero row index",
      ({ regular }) => {
        required(regular.chains[0]).index = -0;
      },
    ],
    [
      "negative zero regular shipment count",
      ({ regular }) => {
        required(regular.chains[0]).shipmentCount = -0;
      },
    ],
    [
      "negative zero correction shipment count",
      ({ special }) => {
        special.correction.shipmentCount = -0;
      },
    ],
  ];
  for (const side of ["regular", "special"] as const) {
    for (const [field, value] of [
      ["datasetId", "22222222-2222-4222-8222-222222222222"],
      ["datasetId", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
      ["datasetId", "invalid"],
      ["version", "us-processor-six-month-v2"],
      ["definitionDigest", syntheticDigest("different recipe")],
      ["definitionDigest", "a".repeat(63)],
      ["state", "native_assembly_input_validated"],
      ["datasetComplete", true],
    ] as const)
      mutations.push([
        `${side} ${field} drift ${value}`,
        (input) => {
          Object.assign(input[side], { [field]: value });
        },
      ]);
  }
  for (const malformed of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)]) {
    mutations.push([
      `regular malformed digest ${malformed.length}`,
      ({ regular }) => {
        required(regular.chains[0]).shippingResultDigest = malformed;
      },
    ]);
    for (const field of [
      "lifecycleResultDigest",
      "transformationResultDigest",
      "casesResultDigest",
      "shippingResultDigest",
    ] as const)
      mutations.push([
        `correction ${field} malformed ${malformed.length}`,
        ({ special }) => {
          special.correction[field] = malformed;
        },
      ]);
    mutations.push([
      `orphan malformed digest ${malformed.length}`,
      ({ special }) => {
        special.orphan.lifecycleResultDigest = malformed;
      },
    ]);
  }
  for (let level = 0; level < 7; level++) {
    for (const kind of ["unknown", "symbol", "non-enumerable"] as const)
      mutations.push([
        `${kind} evidence at level ${level}`,
        (input) => {
          const target = required(evidenceObjects(input)[level]);
          Object.defineProperty(target, kind === "symbol" ? Symbol("unexpected") : "unexpected", {
            value: true,
            enumerable: kind !== "non-enumerable",
          });
        },
      ]);
    mutations.push([
      `missing required field at level ${level}`,
      (input) => {
        const target = required(evidenceObjects(input)[level]);
        Reflect.deleteProperty(target, required(Object.keys(target)[0]));
      },
    ]);
  }
  for (const [label, select, field] of [
    ["range start", (x: Summaries) => x.regular.range, "startIndex"],
    ["range count", (x: Summaries) => x.regular.range, "count"],
    ["row index", (x: Summaries) => required(x.regular.chains[0]), "index"],
    ["row count", (x: Summaries) => required(x.regular.chains[0]), "shipmentCount"],
    ["special count", (x: Summaries) => x.special.correction, "shipmentCount"],
  ] as const) {
    for (const value of ["1", null, true, NaN, Infinity, 1.5])
      mutations.push([
        `${label} refuses ${String(value)}`,
        (input) => {
          Object.assign(select(input), { [field]: value });
        },
      ]);
  }
  it.each(mutations)("rejects %s with only the literal invalid code", (_label, mutate) => {
    const input = syntheticSummaries();
    mutate(input);
    expect(() => makeUsDatasetNativeAssemblyInput(input.regular, input.special)).toThrowError(
      invalid,
    );
  });

  it.each([undefined, null, true, 1, "summary", []])("rejects non-object summary (%#)", (value) => {
    const { regular, special } = syntheticSummaries();
    expect(() => makeUsDatasetNativeAssemblyInput(value, special)).toThrowError(invalid);
    expect(() => makeUsDatasetNativeAssemblyInput(regular, value)).toThrowError(invalid);
  });

  it("rejects a mutually matching but unpinned identity", () => {
    for (const value of ["us-processor-six-month-v2", syntheticDigest("another recipe")]) {
      const { regular, special } = syntheticSummaries();
      const field = value.startsWith("us-") ? "version" : "definitionDigest";
      Object.assign(regular, { [field]: value });
      Object.assign(special, { [field]: value });
      expect(() => makeUsDatasetNativeAssemblyInput(regular, special)).toThrowError(invalid);
    }
  });

  it("rejects own accessors throughout both summaries without evaluating getters", () => {
    let reads = 0;
    for (let level = 0; level < 7; level++) {
      const input = syntheticSummaries();
      const target = required(evidenceObjects(input)[level]);
      Object.defineProperty(target, required(Object.keys(target)[0]), {
        enumerable: true,
        get() {
          reads++;
          throw new Error("caller payload must not escape");
        },
      });
      expect(() => makeUsDatasetNativeAssemblyInput(input.regular, input.special)).toThrowError(
        invalid,
      );
    }
    expect(reads).toBe(0);
  });

  it("rejects custom array prototypes before inherited methods or getters execute", () => {
    let reads = 0;
    for (const method of ["map", "values", "entries", "forEach", Symbol.iterator]) {
      const input = syntheticSummaries();
      const prototype = Object.create(Array.prototype);
      Object.defineProperty(prototype, method, {
        get() {
          reads++;
          throw new Error("inherited caller method");
        },
      });
      Object.setPrototypeOf(input.regular.chains, prototype);
      expect(() => makeUsDatasetNativeAssemblyInput(input.regular, input.special)).toThrowError(
        invalid,
      );
    }
    const subclass = syntheticSummaries();
    class CallerArray<T> extends Array<T> {}
    Object.setPrototypeOf(subclass.regular.chains, CallerArray.prototype);
    expect(() => makeUsDatasetNativeAssemblyInput(subclass.regular, subclass.special)).toThrowError(
      invalid,
    );
    expect(reads).toBe(0);
  });

  it("rejects inherited evidence and cycles without reading inherited getters", () => {
    let reads = 0;
    const input = syntheticSummaries();
    Object.setPrototypeOf(input.special.orphan, {
      get lifecycleResultDigest() {
        reads++;
        return syntheticDigest("inherited");
      },
    });
    expect(() => makeUsDatasetNativeAssemblyInput(input.regular, input.special)).toThrowError(
      invalid,
    );
    expect(reads).toBe(0);
    const cyclic = syntheticSummaries();
    Object.assign(cyclic.special.orphan, { cycle: cyclic.regular });
    Object.assign(cyclic.regular.range, { cycle: cyclic.special });
    expect(() => makeUsDatasetNativeAssemblyInput(cyclic.regular, cyclic.special)).toThrowError(
      invalid,
    );
  });

  it("applies the byte limit to the combined envelope before schema reads", () => {
    const input = syntheticSummaries();
    let reads = 0;
    Object.assign(input.regular, { padding: "r".repeat(110 * 1024) });
    Object.assign(input.special, { padding: "s".repeat(130 * 1024) });
    expect(Buffer.byteLength(JSON.stringify(input.regular))).toBeLessThan(256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(input.special))).toBeLessThan(256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(256 * 1024);
    Object.defineProperty(input.special, "unread", {
      enumerable: true,
      get() {
        reads++;
        return 1;
      },
    });
    expect(() => makeUsDatasetNativeAssemblyInput(input.regular, input.special)).toThrowError(
      invalid,
    );
    expect(reads).toBe(0);
  });
});

// These full262 vectors prove only adapter structure and ownership, never native proof.
function syntheticAdapterVector() {
  const summaries = syntheticSummaries();
  const trace = (unitKey: string, index: number): UsDatasetTraceReadinessResult => ({
    datasetId,
    version: "us-processor-six-month-v1",
    definitionDigest: usSixMonthDefinition.digest,
    unitKey,
    state: "trace_readiness_verified",
    datasetComplete: false,
    lotIds: [`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`],
    currentEventIds: [`11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`],
    evidence: [
      {
        lotId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        traceDigest: syntheticDigest(`trace ${unitKey}`),
        readinessDigest: syntheticDigest(`readiness ${unitKey}`),
        historyDigest: syntheticDigest(`history ${unitKey}`),
        originGap: unitKey === "orphan_0001",
      },
    ],
  });
  const outputs: UsDatasetUnitCompositionResult[] = summaries.regular.chains.map((native) => ({
    kind: "regular",
    native,
    trace: trace(native.unitKey, native.index),
  }));
  outputs.push(
    {
      kind: "correction",
      native: { ...summaries.special.correction, unitKey: "correction_0001", shipmentCount: 1 },
      trace: trace("correction_0001", 260),
    },
    {
      kind: "orphan",
      native: { ...summaries.special.orphan, unitKey: "orphan_0001" },
      trace: trace("orphan_0001", 261),
    },
  );
  const selectors: UsDatasetTraceReadinessUnit[] = Array.from({ length: 260 }, (_, index) => ({
    kind: "regular",
    index,
  }));
  selectors.push({ kind: "correction" }, { kind: "orphan" });
  return { summaries, outputs, selectors };
}

describe("pure full262 unit coordinator adapter", () => {
  const context: UsDatasetContext = {
    tenantId: "structural-tenant",
    actorUserId: "structural-owner",
    expectedDatabaseName: "structural_no_io",
    expectedDatabaseUser: "markiro_us",
  };
  async function adapterCase(
    mode: "initialize" | "verify",
    run: (
      input: ReturnType<typeof syntheticAdapterVector> & {
        coordinator: UsDatasetTraceReadinessSeedStore;
        calls: UsDatasetTraceReadinessUnit[];
        contexts: UsDatasetContext[];
      },
    ) => Promise<void>,
    failure?: { index: number; error: Error },
  ) {
    const vector = syntheticAdapterVector();
    expect(vector.outputs).toHaveLength(262);
    const connection = createDb("postgres://structural:unused@127.0.0.1:1/structural_no_io");
    let acquired = 0;
    connection.pool.on("acquire", () => acquired++);
    const connect = vi.spyOn(connection.pool, "connect").mockImplementation(() => {
      throw new Error("Pure structural adapter must not acquire a client");
    });
    const oldNativeI = vi
      .spyOn(UsDatasetNativeSeedStore.prototype, "initialize")
      .mockImplementation(() => {
        throw new Error("Unexpected old native path");
      });
    const oldNativeV = vi
      .spyOn(UsDatasetNativeSeedStore.prototype, "verify")
      .mockImplementation(() => {
        throw new Error("Unexpected old native path");
      });
    const oldStageI = vi
      .spyOn(UsDatasetTraceReadinessStageStore.prototype, "initialize")
      .mockImplementation(() => {
        throw new Error("Unexpected standalone stage path");
      });
    const oldStageV = vi
      .spyOn(UsDatasetTraceReadinessStageStore.prototype, "verify")
      .mockImplementation(() => {
        throw new Error("Unexpected standalone stage path");
      });
    const otherMode = mode === "initialize" ? "verify" : "initialize";
    const opposite = vi
      .spyOn(UsDatasetUnitCompositionStore.prototype, otherMode)
      .mockImplementation(() => {
        throw new Error("Unexpected opposite owner mode");
      });
    const calls: UsDatasetTraceReadinessUnit[] = [];
    const contexts: UsDatasetContext[] = [];
    const selected = vi
      .spyOn(UsDatasetUnitCompositionStore.prototype, mode)
      .mockImplementation(async (actualContext, unit) => {
        calls.push(unit);
        contexts.push(actualContext);
        const index = unit.kind === "regular" ? unit.index : unit.kind === "correction" ? 260 : 261;
        if (index === failure?.index) throw failure.error;
        return required(vector.outputs[index]);
      });
    try {
      await run({
        ...vector,
        coordinator: new UsDatasetTraceReadinessSeedStore(connection.db),
        calls,
        contexts,
      });
      expect(opposite).not.toHaveBeenCalled();
      for (const spy of [oldNativeI, oldNativeV, oldStageI, oldStageV])
        expect(spy).not.toHaveBeenCalled();
    } finally {
      selected.mockRestore();
      opposite.mockRestore();
      oldNativeI.mockRestore();
      oldNativeV.mockRestore();
      oldStageI.mockRestore();
      oldStageV.mockRestore();
      try {
        expect(acquired).toBe(0);
        expect(connect).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
        await connection.pool.end();
      }
    }
  }

  for (const mode of ["initialize", "verify"] as const)
    it(`adapter-${mode}-all262`, async () => {
      await adapterCase(
        mode,
        async ({ coordinator, calls, contexts, outputs, selectors, summaries }) => {
          const expected = makeUsDatasetNativeAssemblyInput(summaries.regular, summaries.special);
          const first = await coordinator[mode](context);
          expect(calls).toEqual(selectors);
          expect(contexts.every((actual) => actual === context)).toBe(true);
          expect(first).toEqual({
            datasetId,
            version: "us-processor-six-month-v1",
            definitionDigest: usSixMonthDefinition.digest,
            state: "native_chains_trace_readiness_verified",
            datasetComplete: false,
            native: { ...expected, state: "native_chains_shipping_verified" },
            units: outputs.map((output) => ({
              unitKey: output.trace.unitKey,
              resultDigest: canonicalExportDigest(output.trace),
            })),
          });
          expect(Object.keys(first).sort()).toEqual([
            "datasetComplete",
            "datasetId",
            "definitionDigest",
            "native",
            "state",
            "units",
            "version",
          ]);
          expect(
            first.native.regular.chains.reduce((count, row) => count + row.shipmentCount, 0),
          ).toBe(440);
          expect(first.native.special.correction.shipmentCount).toBe(1);
          expect(first.units[0]?.resultDigest).not.toBe(
            canonicalExportDigest(required(outputs[0])),
          );
          assertFrozenOwned(first.native.regular, summaries.regular);
          assertFrozenOwned(first.native.special, summaries.special);
          assertFrozenOwned(first.units, outputs);
          expect(Object.isFrozen(first)).toBe(true);
          expect(Object.isFrozen(first.native)).toBe(true);
          expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(256 * 1024);
          const second = await coordinator[mode](context);
          expect(calls).toEqual([...selectors, ...selectors]);
          expect(second).toEqual(first);
          assertFrozenOwned(second, first);
          expect(contexts.every((actual) => actual === context)).toBe(true);
          const saved = JSON.stringify(first);
          expect(Object.isFrozen(outputs)).toBe(false);
          expect(Object.isFrozen(summaries.regular.chains)).toBe(false);
          Object.assign(required(outputs[0]).native, {
            shippingResultDigest: syntheticDigest("later source mutation"),
          });
          Object.assign(required(outputs[0]).trace, { unitKey: "later_source_mutation" });
          summaries.regular.chains.pop();
          expect(JSON.stringify(first)).toBe(saved);
          expect(JSON.stringify(second)).toBe(saved);
        },
      );
    });

  for (const [name, corrupt] of [
    [
      "adapter-rejects-regular-kind-mismatch",
      (outputs: UsDatasetUnitCompositionResult[]) =>
        Object.assign(required(outputs[1]), { kind: "orphan" }),
    ],
    [
      "adapter-rejects-trace-identity-mismatch",
      (outputs: UsDatasetUnitCompositionResult[]) =>
        Object.assign(required(outputs[1]).trace, {
          datasetId: "22222222-2222-4222-8222-222222222222",
        }),
    ],
    [
      "adapter-rejects-trace-unit-key-mismatch",
      (outputs: UsDatasetUnitCompositionResult[]) =>
        Object.assign(required(outputs[1]).trace, { unitKey: "chain_0002" }),
    ],
    [
      "adapter-rejects-regular-native-row-order-mismatch",
      (outputs: UsDatasetUnitCompositionResult[]) =>
        Object.assign(required(outputs[0]), { native: required(outputs[1]).native }),
    ],
  ] as const)
    it(name, async () => {
      await adapterCase("initialize", async ({ coordinator, outputs }) => {
        corrupt(outputs);
        const failed = await coordinator.initialize(context).then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        expect(failed.value).toBeUndefined();
        expect(failed.error).toEqual(invalid);
      });
    });

  for (const [name, index] of [
    ["adapter-propagates-regular259-rejection", 259],
    ["adapter-propagates-correction-rejection-before-orphan", 260],
  ] as const)
    it(name, async () => {
      const error = new Error("Saved structural boundary rejection");
      await adapterCase(
        "initialize",
        async ({ coordinator, calls, selectors }) => {
          const failed = await coordinator.initialize(context).then(
            (value) => ({ value, error: undefined }),
            (caught: unknown) => ({ value: undefined, error: caught }),
          );
          expect(failed.value).toBeUndefined();
          expect(failed.error).toBe(error);
          expect(calls).toEqual(selectors.slice(0, index + 1));
        },
        { index, error },
      );
    });
});

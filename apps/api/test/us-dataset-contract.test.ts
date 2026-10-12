import { canonicalExportDigest } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import {
  parseUsDatasetDefinition,
  parseUsDatasetIntent,
} from "../src/modules/traceability/demo/us-dataset-contract.js";

const chain = ["receiving", "transformation", "cases", "shipping", "trace_readiness"];
const body = () => ({
  version: "us-processor-six-month-v1",
  manifest: { recipe: { quantity: "0500.00" } },
  units: [
    { key: "chain_001", kind: "chain", stages: [...chain] },
    { key: "chain_002", kind: "chain", stages: [...chain] },
    {
      key: "orphan_001",
      kind: "orphan",
      stages: ["receiving", "void_receiving", "trace_readiness"],
    },
  ],
});
const definition = (value = body()) => ({ ...value, digest: canonicalExportDigest(value) });
const intent = (input: Record<string, unknown> = {}) => ({
  unitKey: "chain_001",
  stage: "receiving",
  operationKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  inputDigest: canonicalExportDigest(input),
  input,
});

describe("US dataset strict contracts", () => {
  it("owns and recursively freezes parsed definitions without freezing callers", () => {
    const raw = definition();
    const parsed = parseUsDatasetDefinition(raw);
    expect(parsed.units.map((unit) => unit.key)).toEqual(["chain_001", "chain_002", "orphan_001"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.units[0]?.stages)).toBe(true);
    expect(Object.isFrozen(parsed.manifest["recipe"])).toBe(true);
    expect(Object.isFrozen(raw.manifest.recipe)).toBe(false);
    raw.manifest.recipe.quantity = "changed";
    expect(parsed.manifest["recipe"]).toEqual({ quantity: "0500.00" });
  });
  it.each([
    ["references", ["references"]],
    ["chain", chain],
    [
      "correction",
      ["receiving", "amend_receiving", "transformation", "cases", "shipping", "trace_readiness"],
    ],
    ["orphan", ["receiving", "void_receiving", "trace_readiness"]],
    ["plan", ["plan"]],
    ["request", ["request", "package"]],
  ])("accepts exact stage sequence for %s", (kind, stages) => {
    const value = { ...body(), units: [{ key: "unit_001", kind, stages }] };
    expect(
      parseUsDatasetDefinition({ ...value, digest: canonicalExportDigest(value) }).units,
    ).toEqual(value.units);
  });
  it("rejects unknown root fields and mismatched identity", () => {
    expect(() => parseUsDatasetDefinition({ ...definition(), extra: true })).toThrow(
      "us_dataset_definition_invalid",
    );
    expect(() => parseUsDatasetDefinition({ ...definition(), digest: "0".repeat(64) })).toThrow(
      "us_dataset_definition_digest_mismatch",
    );
  });
  it.each(
    [["receiving", "receiving"], [...chain].reverse(), ["receiving"], []].map((stages) => [stages]),
  )("rejects incomplete, duplicate or reordered stages", (stages) => {
    const value = { ...body(), units: [{ key: "chain_001", kind: "chain", stages }] };
    expect(() =>
      parseUsDatasetDefinition({ ...value, digest: canonicalExportDigest(value) }),
    ).toThrow("us_dataset_definition_invalid");
  });
  it("rejects duplicate and invalid unit keys", () => {
    const value = body();
    const second = value.units[1];
    if (!second) throw new Error("fixture missing second unit");
    second.key = "chain_001";
    expect(() => parseUsDatasetDefinition(definition(value))).toThrow(
      "us_dataset_definition_invalid",
    );
    for (const key of ["", "Upper", "a".repeat(65), "has space"]) {
      expect(() => parseUsDatasetIntent({ ...intent(), unitKey: key })).toThrow(
        "us_dataset_intent_invalid",
      );
    }
  });
  it("validates intent metadata and digest and freezes its owned evidence", () => {
    for (const change of [
      { operationKey: "bad" },
      { operationKey: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      { inputDigest: "A".repeat(64) },
      { stage: "bad" },
      { extra: true },
    ]) {
      expect(() => parseUsDatasetIntent({ ...intent(), ...change })).toThrow(
        "us_dataset_intent_invalid",
      );
    }
    expect(() => parseUsDatasetIntent({ ...intent(), inputDigest: "0".repeat(64) })).toThrow(
      "us_dataset_intent_digest_mismatch",
    );
    const input = { nested: { values: [null, "😀", "\u001d"] } };
    const parsed = parseUsDatasetIntent(intent(input));
    expect(Object.isFrozen(parsed.input["nested"])).toBe(true);
    input.nested.values.push("later");
    expect(parsed.input).toEqual({ nested: { values: [null, "😀", "\u001d"] } });
    expect(Object.isFrozen(input)).toBe(false);
  });
  it("rejects root and nested accessors without evaluating them", () => {
    let evaluated = false;
    const malicious = Object.defineProperty({}, "hidden", {
      enumerable: true,
      get() {
        evaluated = true;
        return "secret";
      },
    });
    expect(() => parseUsDatasetIntent(malicious)).toThrow("us_dataset_intent_invalid");
    expect(() => parseUsDatasetDefinition({ ...definition(), units: [malicious] })).toThrow();
    expect(() => parseUsDatasetIntent({ ...intent(), input: { child: malicious } })).toThrow(
      "us_demo_json_invalid",
    );
    expect(() =>
      parseUsDatasetDefinition({ ...definition(), manifest: { child: malicious } }),
    ).toThrow("us_demo_json_invalid");
    expect(evaluated).toBe(false);
  });
  it("rejects hidden properties and symbol keys at root and nested boundaries", () => {
    const hidden = Object.defineProperty({}, "hidden", { value: "synthetic" });
    const symbol = { [Symbol("hidden")]: true };
    for (const value of [hidden, symbol]) {
      expect(() => parseUsDatasetIntent(value)).toThrow("us_dataset_intent_invalid");
      expect(() => parseUsDatasetDefinition(value)).toThrow("us_dataset_definition_invalid");
      expect(() => parseUsDatasetIntent({ ...intent(), input: { child: value } })).toThrow(
        "us_demo_json_invalid",
      );
      expect(() =>
        parseUsDatasetDefinition({ ...definition(), manifest: { child: value } }),
      ).toThrow("us_demo_json_invalid");
    }
  });
  it("clones and freezes shared evidence references while leaving caller aliases mutable", () => {
    const shared = { values: ["original"] };
    const input = { left: shared, right: shared };
    const parsed = parseUsDatasetIntent(intent(input));
    expect(parsed.input["left"]).toBe(parsed.input["right"]);
    expect(parsed.input["left"]).not.toBe(shared);
    expect(Object.isFrozen(parsed.input["left"])).toBe(true);
    shared.values.push("caller mutation");
    expect(parsed.input["left"]).toEqual({ values: ["original"] });
    const value = { ...body(), manifest: input };
    const owned = parseUsDatasetDefinition({ ...value, digest: canonicalExportDigest(value) });
    expect(owned.manifest["left"]).toBe(owned.manifest["right"]);
    expect(owned.manifest["left"]).not.toBe(shared);
    expect(Object.isFrozen(shared.values)).toBe(false);
  });
  it.each(["", "a".repeat(63), "A".repeat(64)])("rejects malformed definition digest", (digest) => {
    expect(() => parseUsDatasetDefinition({ ...definition(), digest })).toThrow(
      "us_dataset_definition_invalid",
    );
  });
  it.each([
    { value: NaN },
    { value: new Array<unknown>(2) },
    { value: "\0" },
    { value: "\ud800" },
    { value: "\udc00" },
    { [Symbol("hidden")]: true },
  ])("rejects unsafe JSON evidence", (input) => {
    expect(() => parseUsDatasetIntent({ ...intent(), input })).toThrow("us_demo_json_invalid");
    expect(() => parseUsDatasetDefinition({ ...definition(), manifest: input })).toThrow(
      "us_demo_json_invalid",
    );
  });
  it("rejects cycles, nested secrets and depth 17 using the shared walker", () => {
    const cycle: Record<string, unknown> = {};
    cycle["child"] = cycle;
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 16; i++) deep = { child: deep };
    for (const [input, error] of [
      [cycle, "us_demo_json_invalid"],
      [{ rows: [{ access_token: "synthetic" }] }, "us_demo_json_secret_key"],
      [deep, "us_demo_json_too_deep"],
    ] as const) {
      expect(() => parseUsDatasetIntent({ ...intent(), input })).toThrow(error);
    }
  });
  it("accepts exactly 256 KiB UTF-8 evidence and rejects one byte over", () => {
    const input = { tlc: "😀".repeat(65533) + "aa" };
    expect(Buffer.byteLength(JSON.stringify(input))).toBe(256 * 1024);
    expect(parseUsDatasetIntent(intent(input)).input).toEqual(input);
    expect(() => parseUsDatasetIntent(intent({ tlc: input.tlc + "a" }))).toThrow(
      "us_demo_json_too_large",
    );
    const value = body();
    const overhead = Buffer.byteLength(JSON.stringify({ ...value, manifest: { padding: "" } }));
    const exact = { ...value, manifest: { padding: "a".repeat(256 * 1024 - overhead) } };
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(256 * 1024);
    expect(
      parseUsDatasetDefinition({ ...exact, digest: canonicalExportDigest(exact) }).manifest,
    ).toEqual(exact.manifest);
    const over = { ...exact, manifest: { padding: exact.manifest.padding + "a" } };
    expect(() =>
      parseUsDatasetDefinition({ ...over, digest: canonicalExportDigest(over) }),
    ).toThrow("us_demo_json_too_large");
  });
});

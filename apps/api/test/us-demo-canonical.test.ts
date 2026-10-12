import { createHash } from "node:crypto";
import { canonicalExportDigest as browserDigest } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { assertBoundedSyntheticJson } from "../src/modules/traceability/demo/us-demo-journal-contract.js";
import { canonicalExportDigest as nativeDigest } from "../src/modules/traceability/demo/us-demo-canonical.js";

// Frozen pre-optimization walker: test-only differential oracle.
const MAX_JSON_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDataObject(
  value: unknown,
  errorCode: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(errorCode);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== Object.keys(value).length ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    throw new Error(errorCode);
}

function baselineBoundedSyntheticJson(value: unknown): void {
  if (!isPlainObject(value)) throw new Error("us_demo_json_invalid");
  let bytes = 0;
  const ancestors = new Set<object>();
  const addBytes = (amount: number): void => {
    bytes += amount;
    if (bytes > MAX_JSON_BYTES) throw new Error("us_demo_json_too_large");
  };
  const stringBytes = (text: string): void => {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 0) throw new Error("us_demo_json_invalid");
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("us_demo_json_invalid");
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("us_demo_json_invalid");
    }
    addBytes(Buffer.byteLength(JSON.stringify(text), "utf8"));
  };
  const walk = (item: unknown, depth: number): void => {
    if (item === null || typeof item === "boolean") {
      addBytes(item === null ? 4 : item ? 4 : 5);
      return;
    }
    if (typeof item === "string") {
      stringBytes(item);
      return;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      addBytes(JSON.stringify(item).length);
      return;
    }
    if (typeof item !== "object" || item === null || ancestors.has(item))
      throw new Error("us_demo_json_invalid");
    if (depth > MAX_JSON_DEPTH) throw new Error("us_demo_json_too_deep");
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Object.keys(item);
      const array = Array.isArray(item);
      if (array) {
        if (
          keys.length !== item.length ||
          Reflect.ownKeys(item).length !== item.length + 1 ||
          keys.some((key, index) => key !== String(index))
        )
          throw new Error("us_demo_json_invalid");
      } else assertDataObject(item, "us_demo_json_invalid");
      addBytes(2);
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        if (key === undefined) throw new Error("us_demo_json_invalid");
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor)) throw new Error("us_demo_json_invalid");
        if (index > 0) addBytes(1);
        if (!array) {
          stringBytes(key);
          const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (
            /password|passwd|token|cookie|mfa|twofactor|totp|backupcode|credential|secret|authorization|privatekey|accesskey|apikey|storagekey|objectkey|signedurl/.test(
              normalized,
            )
          )
            throw new Error("us_demo_json_secret_key");
          addBytes(1);
        }
        walk(descriptor.value, depth + 1);
      }
    } finally {
      ancestors.delete(item);
    }
  };
  walk(value, 1);
}

describe("US native canonical digest", () => {
  it("hashes validated canonical JSON with identical SHA-256 bytes", () => {
    expect(nativeDigest({ b: 2, a: 1 })).toBe(
      createHash("sha256").update('{"a":1,"b":2}').digest("hex"),
    );
    expect(nativeDigest({ a: 1, b: 2 })).toBe(browserDigest({ b: 2, a: 1 }));
  });
  it("retains browser output and exact errors on fresh values and post-validation mutation", () => {
    const shared = { x: "ok" };
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    const values: unknown[] = [
      null,
      true,
      -0,
      1e30,
      "é😀\u0000\ud800",
      { 2: 1, 10: 2 },
      { events: [2, 1], findings: ["b", "a"], nested: { events: [2, 1] } },
      { a: shared, b: shared },
      Object.assign(Object.create(null), { x: 1 }),
      undefined,
      NaN,
      Infinity,
      -Infinity,
      1n,
      Symbol("x"),
      () => 1,
      new Date(0),
      cycle,
      new Array(2),
      Object.assign([1], { extra: 2 }),
      Object.create({ x: 1 }),
      { [Symbol("hidden")]: 1 },
      Object.defineProperty({}, "hidden", { value: 1 }),
    ];
    let reads = 0;
    values.push(
      Object.defineProperty({ a: undefined }, "z", {
        enumerable: true,
        get() {
          reads++;
          return 1;
        },
      }),
    );
    values.push(
      Object.defineProperty({}, "a", {
        enumerable: true,
        get() {
          reads++;
          return 1;
        },
      }),
    );
    for (const value of values)
      expect(outcome(nativeDigest, value)).toEqual(outcome(browserDigest, value));
    expect(reads).toBe(0);
    const before = nativeDigest(shared);
    shared.x = "changed";
    expect(nativeDigest(shared)).not.toBe(before);
    expect(nativeDigest(shared)).toBe(browserDigest(shared));
    Object.defineProperty(shared, "bad", {
      enumerable: true,
      get() {
        reads++;
        return 1;
      },
    });
    expect(outcome(nativeDigest, shared)).toEqual({
      name: "TypeError",
      message: "Export digest cannot evaluate getters",
    });
    expect(reads).toBe(0);
  });
  it("characterizes legacy array getters and hidden properties identically", () => {
    let reads = 0;
    const array = Object.defineProperty([1], "0", {
      get() {
        reads++;
        return 2;
      },
    });
    Object.defineProperty(array, "hidden", { value: 1 });
    Object.defineProperty(array, Symbol("hidden"), { value: 1 });
    Object.setPrototypeOf(array, Object.create(Array.prototype));
    expect(nativeDigest(array)).toBe(browserDigest(array));
    expect(reads).toBe(2);
  });
});

function outcome(check: (input: unknown) => unknown, input: unknown): unknown {
  try {
    return { value: check(input) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { name: error.name, message: error.message };
  }
}
function nested(levels: number): unknown {
  let value: unknown = {};
  for (let depth = 1; depth < levels; depth++) value = { child: value };
  return value;
}
describe("bounded synthetic JSON differential parity", () => {
  const secrets = [
    "password",
    "passwd",
    "token",
    "cookie",
    "mfa",
    "twofactor",
    "totp",
    "backupcode",
    "credential",
    "secret",
    "authorization",
    "privatekey",
    "accesskey",
    "apikey",
    "storagekey",
    "objectkey",
    "signedurl",
  ];
  it.each(secrets)("rejects normalized secret alias %s on every invocation", (key) => {
    const value: Record<string, unknown> = { safe: 1 };
    assertBoundedSyntheticJson(value);
    value[key.toUpperCase().split("").join("_")] = 1;
    expect(outcome(assertBoundedSyntheticJson, value)).toEqual({
      name: "Error",
      message: "us_demo_json_secret_key",
    });
    expect(outcome(assertBoundedSyntheticJson, value)).toEqual(
      outcome(baselineBoundedSyntheticJson, value),
    );
  });
  it.each([
    [{ x: "a".repeat(262136) }, undefined],
    [{ x: "a".repeat(262137) }, "us_demo_json_too_large"],
    [{ x: "😀".repeat(65534) }, undefined],
    [{ x: "😀".repeat(65534) + "a" }, "us_demo_json_too_large"],
    [{ x: "\n".repeat(131068) }, undefined],
    [{ x: "\n".repeat(131068) + "a" }, "us_demo_json_too_large"],
    [{ x: "\u001f".repeat(43689) + "aa" }, undefined],
    [{ x: "\u001f".repeat(43689) + "aaa" }, "us_demo_json_too_large"],
    [nested(16), undefined],
    [nested(17), "us_demo_json_too_deep"],
    [{ x: "\u0000" }, "us_demo_json_invalid"],
    [{ x: "\ud800" }, "us_demo_json_invalid"],
    [{ x: "\udfff" }, "us_demo_json_invalid"],
    [{ x: 'é😀\n\t"\\' }, undefined],
    [{ x: [null, true, false, -0, 1.5, 1e30] }, undefined],
    [{ x: new Array(2) }, "us_demo_json_invalid"],
    [{ x: undefined }, "us_demo_json_invalid"],
    [{ x: NaN }, "us_demo_json_invalid"],
    [{ x: 1n }, "us_demo_json_invalid"],
    [{ x: new Date(0) }, "us_demo_json_invalid"],
    [{ password: "a".repeat(262145) }, "us_demo_json_secret_key"],
    [{ safe: "a".repeat(262145), password: "x" }, "us_demo_json_too_large"],
  ])("preserves exact byte/depth/value precedence %#", (value, error) => {
    const actual = outcome(assertBoundedSyntheticJson, value);
    expect(actual).toEqual(error ? { name: "Error", message: error } : { value: undefined });
    expect(actual).toEqual(outcome(baselineBoundedSyntheticJson, value));
  });
  it("preserves descriptor safety and combined-defect precedence without executing getters", () => {
    let reads = 0;
    const accessor = Object.defineProperty({ password: 1 }, "x", {
      enumerable: true,
      get() {
        reads++;
        return 1;
      },
    });
    const hidden = Object.defineProperty({ password: 1 }, "hidden", { value: 1 });
    const symbol = { password: 1, [Symbol("x")]: 1 };
    const custom: unknown = Object.assign(Object.create({ parent: 1 }), { password: 1 });
    const array = Object.defineProperty([1], "0", {
      get() {
        reads++;
        return 1;
      },
    });
    for (const value of [accessor, hidden, symbol, custom, { x: array }]) {
      expect(outcome(assertBoundedSyntheticJson, value)).toEqual({
        name: "Error",
        message: "us_demo_json_invalid",
      });
      expect(outcome(assertBoundedSyntheticJson, value)).toEqual(
        outcome(baselineBoundedSyntheticJson, value),
      );
    }
    expect(reads).toBe(0);
  });
  it("walks aliased objects afresh and distinguishes cycles and legacy custom arrays", () => {
    const shared = { x: "ok" };
    const aliases = { a: shared, b: shared };
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    const array = [1, 2];
    Object.setPrototypeOf(array, Object.create(Array.prototype));
    for (const value of [aliases, Object.assign(Object.create(null), { x: 1 }), { array }]) {
      expect(outcome(assertBoundedSyntheticJson, value)).toEqual({ value: undefined });
      expect(outcome(assertBoundedSyntheticJson, value)).toEqual(
        outcome(baselineBoundedSyntheticJson, value),
      );
    }
    expect(outcome(assertBoundedSyntheticJson, cycle)).toEqual({
      name: "Error",
      message: "us_demo_json_invalid",
    });
    shared.x = "\u0000";
    expect(outcome(assertBoundedSyntheticJson, aliases)).toEqual(
      outcome(baselineBoundedSyntheticJson, aliases),
    );
    expect(() => assertBoundedSyntheticJson(aliases)).toThrow("us_demo_json_invalid");
  });
  it("retains byte accounting on deterministic escaped Unicode and dense-array corpus", () => {
    const alphabet = ["a", "é", "😀", "\n", "\t", '"', "\\", "\u001f"];
    for (let index = 1; index <= 128; index++) {
      const text = alphabet
        .map((letter, position) => letter.repeat((index * (position + 1)) % 41))
        .join("");
      const value = {
        text,
        values: Array.from({ length: index % 23 }, (_, i) => ({ n: i, text })),
      };
      expect(outcome(assertBoundedSyntheticJson, value)).toEqual(
        outcome(baselineBoundedSyntheticJson, value),
      );
    }
  });
});

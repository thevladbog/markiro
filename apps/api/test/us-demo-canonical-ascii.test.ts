import { createHash } from "node:crypto";
import { canonicalExportJson } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";
import { canonicalExportDigest } from "../src/modules/traceability/demo/us-demo-canonical.js";
import {
  assertBoundedSyntheticJson,
  parseUsDemoReceipt,
} from "../src/modules/traceability/demo/us-demo-journal-contract.js";

// Frozen immediately before Task 9, including the exact descriptor/traversal behavior.
// No import from another test suite or changed production oracle.
const MAX_JSON_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 16;
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function originalBoundedJson(value: unknown): void {
  if (!isPlainObject(value)) throw new Error("us_demo_json_invalid");
  let bytes = 0;
  const ancestors = new Set<object>();
  const addBytes = (amount: number): void => {
    bytes += amount;
    if (bytes > MAX_JSON_BYTES) throw new Error("us_demo_json_too_large");
  };
  const stringBytes = (text: string): void => {
    if (text.includes("\u0000") || /[\ud800-\udfff]/.test(text)) {
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code === 0) throw new Error("us_demo_json_invalid");
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = text.charCodeAt(++index);
          if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("us_demo_json_invalid");
        } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("us_demo_json_invalid");
      }
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
      } else if (
        !isPlainObject(item) ||
        Reflect.ownKeys(item).length !== keys.length ||
        Object.values(descriptors).some((descriptor) => !("value" in descriptor))
      )
        throw new Error("us_demo_json_invalid");
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

function outcome(run: (value: unknown) => unknown, value: unknown): unknown {
  try {
    return { value: run(value) };
  } catch (error) {
    if (error instanceof Error) return { name: error.name, message: error.message };
    return { thrown: error };
  }
}

type Witness = { value: unknown; effects: string[] };
function observed(kind: string): Witness {
  const effects: string[] = [];
  let value: unknown;
  if (kind === "proxy") {
    value = new Proxy(
      { z: { b: 2, a: 1 }, a: "printable" },
      {
        getPrototypeOf(target) {
          effects.push("prototype");
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          effects.push("keys");
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          effects.push("descriptor:" + String(key));
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key, receiver) {
          effects.push("get:" + String(key));
          return Reflect.get(target, key, receiver);
        },
      },
    );
  } else if (kind === "array getter") {
    value = Object.defineProperty(["original"], "0", {
      enumerable: true,
      get() {
        effects.push("getter");
        return "changed";
      },
    });
    Object.defineProperty(value, "hidden", { value: 1 });
    Object.defineProperty(value, Symbol("hidden"), { value: 1 });
    Object.setPrototypeOf(value, Object.create(Array.prototype));
  } else if (kind === "iterator") {
    value = ["original", "second"];
    Object.defineProperty(value, Symbol.iterator, {
      value: function* () {
        effects.push("iterator");
        yield "changed";
        yield "first";
      },
    });
  } else if (kind === "throwing iterator") {
    value = ["original"];
    Object.defineProperty(value, Symbol.iterator, {
      value() {
        effects.push("iterator");
        throw new RangeError("caller iterator");
      },
    });
  } else if (kind === "accessor before invalid") {
    value = Object.defineProperty({ z: undefined }, "a", {
      enumerable: true,
      get() {
        effects.push("getter");
        return 1;
      },
    });
  } else if (kind === "invalid before accessor") {
    value = Object.defineProperty({ a: undefined }, "z", {
      enumerable: true,
      get() {
        effects.push("getter");
        return 1;
      },
    });
  } else if (kind === "hidden before invalid") {
    value = Object.defineProperty({ a: undefined }, "hidden", { value: 1 });
  } else {
    value = new Proxy(
      { a: "ok" },
      {
        ownKeys() {
          effects.push("keys");
          throw new RangeError("caller keys");
        },
      },
    );
  }
  return { value, effects };
}

describe("bounded JSON printable ASCII specialization", () => {
  it("validates and hashes real ASCII receipt bytes without generic ASCII stringification", () => {
    const result = { b: "hello", a: "world" };
    const literal = '{"a":"world","b":"hello"}';
    const digest = createHash("sha256").update(literal, "utf8").digest("hex");
    const parsed = parseUsDemoReceipt({ recordIds: [], resultDigest: digest, result });
    let calls = 0;
    const original = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(
      new Proxy(original, {
        apply(target, receiver, args: Parameters<typeof JSON.stringify>) {
          if (typeof args[0] === "string") calls++;
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    let bytes: string, hash: string;
    try {
      assertBoundedSyntheticJson(result);
      bytes = canonicalExportJson(parsed.result);
      hash = canonicalExportDigest(parsed.result);
    } finally {
      spy.mockRestore();
    }
    expect(parsed).toEqual({ recordIds: [], resultDigest: digest, result });
    expect(parsed.result).not.toBe(result);
    expect(bytes).toBe(literal);
    expect(hash).toBe(digest);
    expect(hash).toBe("85063cb971cf3f8beddd4e34a5652816ce7b5eedd8ead6835c4f4cc50899b5ed");
    expect(calls).toBe(0);
  });

  it.each(Array.from({ length: 16 }, (_, index) => index))(
    "matches frozen validation for UTF16 shard %i",
    (shard) => {
      for (let code = shard * 4096; code < (shard + 1) * 4096; code++) {
        const text = String.fromCharCode(code);
        for (const value of [{ value: text }, { [text]: "ok" }])
          expect(outcome(assertBoundedSyntheticJson, value)).toEqual(
            outcome(originalBoundedJson, value),
          );
      }
    },
  );

  it.each([
    "proxy",
    "array getter",
    "iterator",
    "throwing iterator",
    "accessor before invalid",
    "invalid before accessor",
    "hidden before invalid",
    "throwing proxy",
  ])("preserves caller observations: %s", (kind) => {
    const original = observed(kind),
      current = observed(kind);
    // Root validation requires objects; nested array behavior remains independently exercised.
    expect(outcome(assertBoundedSyntheticJson, { value: current.value })).toEqual(
      outcome(originalBoundedJson, { value: original.value }),
    );
    expect(current.effects).toEqual(original.effects);
  });

  it("preserves exact byte boundaries for ASCII, escaped and multibyte strings", () => {
    for (const unit of ["x", "\n", "é", "😀"]) {
      const unitBytes = Buffer.byteLength(JSON.stringify(unit), "utf8") - 2;
      const count = Math.floor((MAX_JSON_BYTES - 12) / unitBytes);
      const remainder = MAX_JSON_BYTES - 12 - count * unitBytes;
      const text = unit.repeat(count) + "x".repeat(remainder);
      expect(Buffer.byteLength(JSON.stringify({ value: text }))).toBe(MAX_JSON_BYTES);
      expect(() => assertBoundedSyntheticJson({ value: text })).not.toThrow();
      expect(() => assertBoundedSyntheticJson({ value: text + "x" })).toThrow(
        "us_demo_json_too_large",
      );
      for (const value of [{ value: text }, { value: text + "x" }])
        expect(outcome(assertBoundedSyntheticJson, value)).toEqual(
          outcome(originalBoundedJson, value),
        );
    }
  });

  it("preserves depth, secret keys, malformed Unicode and size error precedence", () => {
    const nest = (depth: number): Record<string, unknown> => {
      let value: Record<string, unknown> = {};
      for (let index = 1; index < depth; index++) value = { child: value };
      return value;
    };
    const large = "x".repeat(MAX_JSON_BYTES);
    const cases: [unknown, string | undefined][] = [
      [nest(16), undefined],
      [nest(17), "us_demo_json_too_deep"],
      [{ a: large, password: "x" }, "us_demo_json_too_large"],
      [{ password: large }, "us_demo_json_secret_key"],
      [{ safe: { next: "\u0000" }, password: "x" }, "us_demo_json_invalid"],
      [{ a: large + "\u0000" }, "us_demo_json_invalid"],
      [{ a: "\ud800" + large }, "us_demo_json_invalid"],
      [{ ["password" + large]: "x" }, "us_demo_json_too_large"],
      [{ ["password\u0000"]: "x" }, "us_demo_json_invalid"],
      [{ "P-R-I-V-A-T-E_key": "x" }, "us_demo_json_secret_key"],
      [{ value: '😀\u007f\u0080\u2028\u2029\\"\t\r\n' }, undefined],
    ];
    for (const [value, error] of cases) {
      const actual = outcome(assertBoundedSyntheticJson, value);
      expect(actual).toEqual(error ? { name: "Error", message: error } : { value: undefined });
      expect(actual).toEqual(outcome(originalBoundedJson, value));
    }
  });

  it("rechecks mutated data and returns an independently owned receipt", () => {
    const result = { nested: { value: "first" } };
    const parsed = parseUsDemoReceipt({
      recordIds: [],
      resultDigest: canonicalExportDigest(result),
      result,
    });
    result.nested.value = "second";
    expect(parsed.result).toEqual({ nested: { value: "first" } });
    expect(() => assertBoundedSyntheticJson(result)).not.toThrow();
    Object.defineProperty(result.nested, "password", { value: "forbidden", enumerable: true });
    expect(() => assertBoundedSyntheticJson(result)).toThrow("us_demo_json_secret_key");
    expect(outcome(assertBoundedSyntheticJson, result)).toEqual(
      outcome(originalBoundedJson, result),
    );
  });
});

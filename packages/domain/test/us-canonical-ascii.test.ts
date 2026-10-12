import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalExportDigest,
  canonicalExportJson,
} from "../src/traceability/export/canonical.js";

// Frozen pre-Task 9 serializer, independent of the production helper and its fast path.
// This intentional test-only oracle guards exact bytes, errors and caller observations.
function originalCanonicalJson(input: unknown): string {
  const ancestors = new Set<object>();
  const serialize = (value: unknown, root = false, unordered = false): string => {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== "object") throw new TypeError("Export digest requires finite JSON values");
    if (ancestors.has(value)) throw new TypeError("Export digest cannot contain cycles");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length)
          throw new TypeError("Export digest requires dense JSON arrays");
        const parts = Array.from(value, (item: unknown) => serialize(item));
        if (unordered) parts.sort();
        return `[${parts.join(",")}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError("Export digest requires plain JSON objects");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(value).length !== Object.keys(value).length)
        throw new TypeError("Export digest cannot discard hidden or symbol properties");
      return `{${Object.keys(descriptors)
        .sort()
        .map((key) => {
          const descriptor = descriptors[key];
          if (!descriptor || !("value" in descriptor))
            throw new TypeError("Export digest cannot evaluate getters");
          return `${JSON.stringify(key)}:${serialize(descriptor.value, false, root && (key === "events" || key === "findings"))}`;
        })
        .join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  };
  return serialize(input, true);
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

describe("canonical printable ASCII specialization", () => {
  it("retains literal bytes and SHA while avoiding generic stringification of ASCII", () => {
    const value = { b: "hello", a: "world" };
    const literal = '{"a":"world","b":"hello"}';
    const digest = createHash("sha256").update(literal, "utf8").digest("hex");
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
      bytes = canonicalExportJson(value);
      hash = canonicalExportDigest(value);
    } finally {
      spy.mockRestore();
    }
    expect(bytes).toBe(literal);
    expect(hash).toBe(digest);
    expect(hash).toBe("85063cb971cf3f8beddd4e34a5652816ce7b5eedd8ead6835c4f4cc50899b5ed");
    expect(calls).toBe(0);
  });

  it.each(Array.from({ length: 16 }, (_, index) => index))(
    "matches frozen bytes for UTF16 shard %i",
    (shard) => {
      for (let code = shard * 4096; code < (shard + 1) * 4096; code++) {
        const text = String.fromCharCode(code);
        expect(canonicalExportJson(text)).toBe(originalCanonicalJson(text));
        expect(canonicalExportJson({ [text]: text })).toBe(originalCanonicalJson({ [text]: text }));
      }
    },
  );

  it("preserves literal Unicode, escapes, numeric lexicographic keys and root-only sorting", () => {
    const value = {
      2: -0,
      10: "é😀",
      events: [2, 1],
      findings: ["b", "a"],
      nested: { events: [2, 1] },
      text: '\u0000\ud800"\\\n',
    };
    const literal =
      '{"10":"é😀","2":0,"events":[1,2],"findings":["a","b"],"nested":{"events":[2,1]},"text":"\\u0000\\ud800\\"\\\\\\n"}';
    expect(canonicalExportJson(value)).toBe(literal);
    expect(Buffer.from(canonicalExportJson(value))).toEqual(Buffer.from(literal, "utf8"));
    expect(canonicalExportDigest(value)).toBe(
      createHash("sha256").update(literal, "utf8").digest("hex"),
    );
  });

  it.each([
    "proxy",
    "array getter",
    "iterator",
    "throwing iterator",
    "accessor before invalid",
    "invalid before accessor",
    "hidden before invalid",
    "throwing proxy",
  ])("preserves errors and observations: %s", (kind) => {
    const original = observed(kind),
      current = observed(kind);
    expect(outcome(canonicalExportJson, current.value)).toEqual(
      outcome(originalCanonicalJson, original.value),
    );
    expect(current.effects).toEqual(original.effects);
  });

  it("preserves rejection precedence, aliases, null prototypes and fresh mutations", () => {
    const alias = { value: "before" };
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    const values: unknown[] = [
      null,
      true,
      false,
      -0,
      1e30,
      NaN,
      Infinity,
      -Infinity,
      undefined,
      1n,
      Symbol("x"),
      () => 1,
      new Date(0),
      cycle,
      new Array(2),
      Object.assign([1], { extra: 2 }),
      { [Symbol("hidden")]: 1 },
      Object.create({ inherited: 1 }),
      Object.assign(Object.create(null), { b: "B", a: "A" }),
      { a: alias, b: alias },
      { a: undefined, z: cycle },
      { a: cycle, z: undefined },
      " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~\u007f\u0080\u2028\u2029😀",
    ];
    for (const value of values)
      expect(outcome(canonicalExportJson, value)).toEqual(outcome(originalCanonicalJson, value));
    const before = canonicalExportDigest(alias);
    alias.value = "after";
    expect(canonicalExportDigest(alias)).not.toBe(before);
    expect(canonicalExportJson(alias)).toBe(originalCanonicalJson(alias));
    Object.defineProperty(alias, "unsafe", {
      enumerable: true,
      get() {
        throw new Error("must not read");
      },
    });
    expect(outcome(canonicalExportJson, alias)).toEqual(outcome(originalCanonicalJson, alias));
  });
});

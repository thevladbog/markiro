import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";
import * as canonical from "../src/traceability/export/canonical.js";

function equal(left: unknown, right: unknown): unknown {
  const compare: unknown = Reflect.get(canonical, "canonicalExportEqual");
  expect(compare).toBeTypeOf("function");
  if (typeof compare !== "function") throw new Error("Missing canonicalExportEqual");
  return compare(left, right);
}

describe("canonical export equality", () => {
  it("exports the same helper through the public domain entry point", () => {
    expect(Reflect.get(domain, "canonicalExportEqual")).toBeTypeOf("function");
    expect(Reflect.get(domain, "canonicalExportEqual")).toBe(
      Reflect.get(canonical, "canonicalExportEqual"),
    );
  });

  const pairs: readonly [string, unknown, unknown, boolean][] = [
    ["null", null, null, true],
    ["boolean", true, true, true],
    ["different boolean", true, false, false],
    ["signed zero", 0, -0, true],
    ["finite number", 1.25, 1.25, true],
    ["different number", 1, 2, false],
    ["number versus text", 1, "1", false],
    ["null versus text", null, "null", false],
    ["boolean versus number", false, 0, false],
    ["Unicode", "Кириллица 😀 \ud800", "Кириллица 😀 \ud800", true],
    ["no Unicode normalization", "é", "e\u0301", false],
    ["escaping", '\u0000\n"\\', '\u0000\n"\\', true],
    ["object key order", { b: 2, a: 1 }, { a: 1, b: 2 }, true],
    ["dense nested arrays", [null, [0, "x"], {}], [null, [-0, "x"], {}], true],
    ["root array order", [1, 2], [2, 1], false],
    ["nested array order", { rows: [1, 2] }, { rows: [2, 1] }, false],
    [
      "root events unordered",
      { events: [{ id: 2 }, { id: 1 }] },
      { events: [{ id: 1 }, { id: 2 }] },
      true,
    ],
    ["root findings unordered", { findings: [2, 1] }, { findings: [1, 2] }, true],
    ["nested events ordered", { data: { events: [1, 2] } }, { data: { events: [2, 1] } }, false],
    ["selection multiplicity", { events: [1, 1] }, { events: [1] }, false],
    ["primitive versus object", "{}", {}, false],
    ["null prototype", Object.assign(Object.create(null), { a: 1 }), { a: 1 }, true],
  ];
  it.each(pairs)("matches canonical bytes and digests: %s", (_name, left, right, expected) => {
    expect(equal(left, right)).toBe(expected);
    expect(equal(left, right)).toBe(
      canonical.canonicalExportJson(left) === canonical.canonicalExportJson(right),
    );
    expect(equal(left, right)).toBe(
      canonical.canonicalExportDigest(left) === canonical.canonicalExportDigest(right),
    );
  });

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const invalid: readonly [string, unknown, string][] = [
    ["undefined", undefined, "finite JSON values"],
    ["NaN", NaN, "finite JSON values"],
    ["infinity", Infinity, "finite JSON values"],
    ["negative infinity", -Infinity, "finite JSON values"],
    ["bigint", 1n, "finite JSON values"],
    ["symbol", Symbol("x"), "finite JSON values"],
    ["function", () => 1, "finite JSON values"],
    ["sparse array", new Array(1), "dense JSON arrays"],
    ["prototype", new Date(0), "plain JSON objects"],
    ["symbol property", { [Symbol("x")]: 1 }, "hidden or symbol properties"],
    [
      "hidden property",
      Object.defineProperty({}, "x", { value: 1 }),
      "hidden or symbol properties",
    ],
    ["cycle", cycle, "cycles"],
  ];
  it.each(invalid)(
    "validates either side and same-reference input: %s",
    (_name, value, message) => {
      expect(() => equal(value, null)).toThrow(message);
      expect(() => equal(null, value)).toThrow(message);
      expect(() => equal(value, value)).toThrow(message);
      expect(() => canonical.canonicalExportJson(value)).toThrow(message);
      expect(() => canonical.canonicalExportDigest(value)).toThrow(message);
    },
  );

  it("rejects object getters without evaluating them, on either side", () => {
    let reads = 0;
    const value = Object.defineProperty({}, "a", {
      enumerable: true,
      get() {
        reads++;
        return 1;
      },
    });
    expect(() => equal(value, {})).toThrow("cannot evaluate getters");
    expect(() => equal({}, value)).toThrow("cannot evaluate getters");
    expect(() => equal(value, value)).toThrow("cannot evaluate getters");
    expect(reads).toBe(0);
  });

  it("preserves left-before-right validation when both sides are invalid", () => {
    expect(() => equal(new Date(0), undefined)).toThrow("plain JSON objects");
    expect(() => equal(undefined, new Date(0))).toThrow("finite JSON values");
    let touched = false;
    const right = new Proxy(
      {},
      {
        getPrototypeOf(target) {
          touched = true;
          return Reflect.getPrototypeOf(target);
        },
      },
    );
    expect(() => equal(cycle, right)).toThrow("cycles");
    expect(touched).toBe(false);
  });

  it("preserves canonicalizer observations and array getter order", () => {
    const observe = (compare: (left: unknown, right: unknown) => unknown) => {
      const effects: string[] = [];
      const value = (side: string) =>
        Object.defineProperty([0], "0", {
          enumerable: true,
          get() {
            effects.push(side);
            return 1;
          },
        });
      const result = compare(value("left"), value("right"));
      return { result, effects };
    };
    expect(observe(equal)).toEqual({ result: true, effects: ["left", "right"] });
    expect(observe(equal)).toEqual(
      observe(
        (left, right) =>
          canonical.canonicalExportJson(left) === canonical.canonicalExportJson(right),
      ),
    );
  });

  it("revalidates aliases and mutations without retaining prior equality", () => {
    const shared = { n: 1 };
    const left = { a: shared, b: shared };
    const right = { a: { n: 1 }, b: { n: 1 } };
    expect(equal(left, right)).toBe(true);
    shared.n = 2;
    expect(equal(left, right)).toBe(false);
    expect(canonical.canonicalExportDigest(left)).not.toBe(canonical.canonicalExportDigest(right));
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "@markiro/db";
import { canonicalExportJson as referenceJson } from "@markiro/domain";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const demoDirectory = join(__dirname, "../src/modules/traceability/demo");

describe("server-only US demo digest routing", () => {
  it("routes actual definition and journal construction hashes through the native helper without connecting", async () => {
    vi.resetModules();
    const native = await import("../src/modules/traceability/demo/us-demo-canonical.js");
    const digest = vi.spyOn(native, "canonicalExportDigest");
    const { db, pool } = createDb(
      "postgres://synthetic:synthetic@127.0.0.1:1/us_digest_routing_synthetic",
    );
    const connect = vi.spyOn(pool, "connect").mockImplementation(() => {
      throw new Error("Digest routing witness must never connect");
    });
    try {
      const { usDemoDefinition } =
        await import("../src/modules/traceability/demo/us-demo-definition.js");
      const { usSixMonthDefinition } =
        await import("../src/modules/traceability/demo/us-six-month-definition.js");
      const { UsDatasetJournalStore } =
        await import("../src/modules/traceability/demo/us-dataset-journal.js");
      const before = digest.mock.calls.length;
      expect(new UsDatasetJournalStore(db, usSixMonthDefinition)).toBeInstanceOf(
        UsDatasetJournalStore,
      );
      expect(digest.mock.calls.length).toBeGreaterThan(before);
      expect(digest.mock.calls.some(([input]) => input === usDemoDefinition)).toBe(true);
      expect(connect).not.toHaveBeenCalled();
      expect(pool.totalCount).toBe(0);
    } finally {
      connect.mockRestore();
      digest.mockRestore();
      await pool.end();
    }
  });

  it("owns every demo digest import at the existing native helper, including aliased imports", () => {
    const violations: string[] = [];
    let nativeImports = 0;
    for (const name of readdirSync(demoDirectory).filter((entry) => entry.endsWith(".ts"))) {
      const file = join(demoDirectory, name);
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
        const bindings = node.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const binding of bindings.elements) {
          if ((binding.propertyName ?? binding.name).text !== "canonicalExportDigest") continue;
          if (node.moduleSpecifier.text === "./us-demo-canonical.js") nativeImports++;
          else violations.push(`${name}: ${node.moduleSpecifier.text}`);
        }
      }
    }
    expect(nativeImports).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});

async function loadOwnedCanonical() {
  const module = await import("../src/modules/traceability/demo/us-demo-canonical.js");
  const copy: unknown = Reflect.get(module, "ownedUsDemoJsonCopy");
  const json: unknown = Reflect.get(module, "canonicalExportJson");
  expect(copy).toBeTypeOf("function");
  expect(json).toBeTypeOf("function");
  if (typeof copy !== "function" || typeof json !== "function")
    throw new Error("Missing owned canonical helpers");
  return {
    copy: (value: unknown): unknown => copy(value),
    json: (value: unknown): string => {
      const result: unknown = json(value);
      if (typeof result !== "string") throw new Error("Expected canonical bytes");
      return result;
    },
  };
}

describe("owned server canonical bytes", () => {
  it("reuses successful owned bytes but traverses frozen callers and proxies", async () => {
    vi.resetModules();
    const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
    try {
      const { copy, json } = await loadOwnedCanonical();
      const raw = { value: "x".repeat(1200) };
      const owned = copy(raw);
      expect(owned).not.toBe(raw);
      expect(Object.isFrozen(owned)).toBe(true);
      expect(Object.isFrozen(raw)).toBe(false);
      expect(json(owned)).toBe(referenceJson(raw));
      descriptors.mockClear();
      expect(json(owned)).toBe(referenceJson(raw));
      // The reference comparison above traverses raw once; isolate the actual hit.
      descriptors.mockClear();
      json(owned);
      const hitReflections = descriptors.mock.calls.length;
      expect(hitReflections).toBe(0);
      json(Object.freeze({ value: raw.value }));
      const callerReflections = descriptors.mock.calls.length;
      expect(callerReflections).toBeGreaterThan(0);
      descriptors.mockClear();
      let reflected = 0;
      const proxy = new Proxy(Object(owned), {
        ownKeys(target) {
          reflected++;
          return Reflect.ownKeys(target);
        },
      });
      expect(json(proxy)).toBe(referenceJson(raw));
      expect(reflected).toBeGreaterThan(0);
      raw.value = "changed";
      expect(json(raw)).toBe(referenceJson(raw));
      expect(json(owned)).not.toBe(json(raw));
    } finally {
      descriptors.mockRestore();
    }
  });

  it("keeps root, nested and unordered array contexts separate", async () => {
    vi.resetModules();
    const { copy, json } = await loadOwnedCanonical();
    const selection = [
      { id: 2, payload: "b".repeat(1100) },
      { id: 1, payload: "a".repeat(1100) },
    ];
    const owned = copy({ events: selection, findings: selection, nested: { events: selection } });
    if (owned === null || typeof owned !== "object") throw new Error("Expected object");
    const events: unknown = Reflect.get(owned, "events");
    const nested: unknown = Reflect.get(owned, "nested");
    for (const value of [
      owned,
      nested,
      events,
      { nested: owned },
      { events },
      { findings: events },
    ]) {
      expect(json(value)).toBe(referenceJson(value));
      expect(json(value)).toBe(referenceJson(value));
    }
  });

  it("preserves clone aliases, fresh identities, deep freezing and invalid-value errors", async () => {
    vi.resetModules();
    const { copy, json } = await loadOwnedCanonical();
    const shared = { value: "x".repeat(1200) };
    const first = copy({ a: shared, b: shared });
    const second = copy(first);
    expect(second).not.toBe(first);
    if (first === null || typeof first !== "object") throw new Error("Expected object");
    expect(Reflect.get(first, "a")).toBe(Reflect.get(first, "b"));
    expect(Reflect.get(first, "a")).not.toBe(shared);
    expect(Object.isFrozen(Reflect.get(first, "a"))).toBe(true);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [undefined, NaN, Infinity, 1n, new Date(0), cycle, new Array(2)]) {
      const outcome = (run: () => unknown) => {
        try {
          return { value: run() };
        } catch (error) {
          return error instanceof Error ? { name: error.name, message: error.message } : { error };
        }
      };
      expect(outcome(() => json(value))).toEqual(outcome(() => referenceJson(value)));
      expect(outcome(() => json(value))).toEqual(outcome(() => referenceJson(value)));
    }
  });

  it("disables warmed entries when intrinsics change, including inside a proxy ancestor", async () => {
    vi.resetModules();
    const { copy, json } = await loadOwnedCanonical();
    const owned = copy({ text: "é\n" + "x".repeat(1200) });
    const standard = json(owned);
    const stringify = JSON.stringify;
    const replacement: typeof JSON.stringify = ((value: unknown) =>
      typeof value === "string"
        ? stringify("replaced")
        : stringify(value)) as typeof JSON.stringify;
    try {
      JSON.stringify = replacement;
      expect(json(owned)).toBe(referenceJson(owned));
      expect(referenceJson(owned)).not.toBe(standard);
    } finally {
      JSON.stringify = stringify;
    }
    expect(json(owned)).toBe(standard);
    const make = () =>
      new Proxy(
        { owned },
        {
          getPrototypeOf(target) {
            JSON.stringify = replacement;
            return Reflect.getPrototypeOf(target);
          },
        },
      );
    try {
      expect(json(make())).toBe(referenceJson(make()));
    } finally {
      JSON.stringify = stringify;
    }
    let calls = 0;
    const descriptor = Object.getOwnPropertyDescriptor(JSON, "stringify");
    if (!descriptor) throw new Error("Missing stringify");
    try {
      Object.defineProperty(JSON, "stringify", {
        configurable: true,
        get() {
          calls++;
          return stringify;
        },
      });
      const before = calls;
      const actual = json(owned);
      const actualCalls = calls - before;
      expect(actualCalls).toBeGreaterThan(0);
      const baseline = calls;
      expect(actual).toBe(referenceJson(owned));
      expect(actualCalls).toBe(calls - baseline);
    } finally {
      Object.defineProperty(JSON, "stringify", descriptor);
    }
  });

  it("bounds entries and resets retained payload without caching small values or failures", async () => {
    vi.resetModules();
    const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
    try {
      const { copy, json } = await loadOwnedCanonical();
      const small = copy({ value: "tiny" });
      json(small);
      descriptors.mockClear();
      json(small);
      const smallReads = descriptors.mock.calls.length;
      expect(smallReads).toBeGreaterThan(0);
      const large = copy({ value: "x".repeat(256 * 1024) });
      json(large);
      descriptors.mockClear();
      json(large);
      const largeReads = descriptors.mock.calls.length;
      expect(largeReads).toBeGreaterThan(0);
      const first = copy({ value: "x".repeat(64 * 1024) });
      json(first);
      for (let i = 0; i < 70; i++) json(copy({ value: String(i) + "x".repeat(64 * 1024) }));
      descriptors.mockClear();
      json(first);
      const resetReads = descriptors.mock.calls.length;
      expect(resetReads).toBeGreaterThan(0);
    } finally {
      descriptors.mockRestore();
    }
  });

  it("bypasses owned hits for every replaceable traversal intrinsic and namespace", async () => {
    const cases: readonly [object, PropertyKey][] = [
      [JSON, "stringify"],
      [Array, "from"],
      [Array, "isArray"],
      [Array.prototype, Symbol.iterator],
      [Array.prototype, "values"],
      [Array.prototype, "sort"],
      [Array.prototype, "map"],
      [Array.prototype, "join"],
      [Array.prototype, "constructor"],
      [Object, "getPrototypeOf"],
      [Object, "getOwnPropertyDescriptors"],
      [Object, "keys"],
      [Reflect, "ownKeys"],
      [Number, "isFinite"],
      [Set.prototype, "has"],
      [Set.prototype, "add"],
      [Set.prototype, "delete"],
      [RegExp.prototype, "test"],
      [RegExp.prototype, "exec"],
      [Object.getPrototypeOf([][Symbol.iterator]()), "next"],
      ...["JSON", "Array", "Object", "Reflect", "Number", "Set", "RegExp"].map(
        (key): [object, PropertyKey] => [globalThis, key],
      ),
    ];
    for (const [target, key] of cases) {
      vi.resetModules();
      const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("Missing intrinsic");
      try {
        const { copy, json } = await loadOwnedCanonical();
        const value = copy({ text: "x".repeat(1200) });
        json(value);
        descriptors.mockClear();
        const original: unknown = descriptor.value;
        if ((typeof original !== "object" || original === null) && typeof original !== "function")
          throw new Error("Expected intrinsic object");
        Object.defineProperty(target, key, { ...descriptor, value: new Proxy(original, {}) });
        const actual = json(value);
        const traversed = descriptors.mock.calls.some(([node]) => node === value);
        const expected = referenceJson(value);
        Object.defineProperty(target, key, descriptor);
        expect(actual).toBe(expected);
        expect(traversed).toBe(true);
      } finally {
        Object.defineProperty(target, key, descriptor);
        descriptors.mockRestore();
      }
    }
  });

  it("preserves Array species failures and does not invoke a replacement species getter early", async () => {
    vi.resetModules();
    const { copy, json } = await loadOwnedCanonical();
    const value = copy({ text: "x".repeat(1200) });
    json(value);
    const constructor = Object.getOwnPropertyDescriptor(Array.prototype, "constructor");
    const species = Object.getOwnPropertyDescriptor(Array, Symbol.species);
    if (!constructor || !species) throw new Error("Missing Array descriptors");
    function rejectedSpecies(): never {
      throw new Error("species witness");
    }
    const outcome = (run: () => unknown) => {
      try {
        run();
        return "returned";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown";
      }
    };
    try {
      Object.defineProperty(Array.prototype, "constructor", {
        ...constructor,
        value: { [Symbol.species]: rejectedSpecies },
      });
      const actual = outcome(() => json(value));
      const expected = outcome(() => referenceJson(value));
      Object.defineProperty(Array.prototype, "constructor", constructor);
      expect(actual).toBe("species witness");
      expect(actual).toBe(expected);
      let getterCalls = 0;
      Object.defineProperty(Array, Symbol.species, {
        configurable: true,
        get() {
          getterCalls++;
          return rejectedSpecies;
        },
      });
      const actualGetter = outcome(() => json(value));
      const actualCalls = getterCalls;
      getterCalls = 0;
      const expectedGetter = outcome(() => referenceJson(value));
      const expectedCalls = getterCalls;
      Object.defineProperty(Array, Symbol.species, species);
      expect(actualGetter).toBe(expectedGetter);
      expect(actualCalls).toBe(1);
      expect(actualCalls).toBe(expectedCalls);
    } finally {
      Object.defineProperty(Array.prototype, "constructor", constructor);
      Object.defineProperty(Array, Symbol.species, species);
    }
  });

  it("does not mistake an inherited descriptor value for an own data descriptor", async () => {
    vi.resetModules();
    const { copy, json } = await loadOwnedCanonical();
    const value = copy({ text: "é\n" + "x".repeat(1200) });
    json(value);
    const stringify = Object.getOwnPropertyDescriptor(JSON, "stringify");
    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, "value");
    if (!stringify) throw new Error("Missing stringify");
    const outcome = (run: () => unknown) => {
      try {
        run();
        return "returned";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown";
      }
    };
    try {
      Object.defineProperty(JSON, "stringify", {
        configurable: true,
        get() {
          throw new Error("descriptor getter witness");
        },
      });
      Object.defineProperty(Object.prototype, "value", {
        configurable: true,
        value: stringify.value,
      });
      const actual = outcome(() => json(value));
      const expected = outcome(() => referenceJson(value));
      Reflect.deleteProperty(Object.prototype, "value");
      Object.defineProperty(JSON, "stringify", stringify);
      expect(actual).toBe("descriptor getter witness");
      expect(actual).toBe(expected);
    } finally {
      Reflect.deleteProperty(Object.prototype, "value");
      if (inherited) Object.defineProperty(Object.prototype, "value", inherited);
      Object.defineProperty(JSON, "stringify", stringify);
    }
  });
});

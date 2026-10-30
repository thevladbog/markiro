import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

const store = new URL("../../node_modules/.pnpm/", import.meta.url);
// Resolve through real consumers: old, unreachable store directories may remain
// after pnpm applies a patch and must not be mistaken for installed dependencies.
const consumers = readdirSync(store).filter((name) =>
  ["@rollup+plugin-node-resolve@", "fork-ts-checker-webpack-plugin@", "html-to-text@"].some(
    (prefix) => name.startsWith(prefix),
  ),
);
const copies = new Map();
for (const consumer of consumers) {
  const require = createRequire(new URL(`${consumer}/node_modules/_probe.cjs`, store));
  const entry = pathToFileURL(require.resolve("deepmerge"));
  const directory = new URL("../", entry);
  copies.set(directory.href, directory);
}
assert.ok(copies.size > 0, "install dependencies before verifying the deepmerge patch");

for (const [copy, directory] of copies) {
  const require = createRequire(new URL("package.json", directory));
  const modules = {
    cjs: require("./dist/cjs.js"),
    umd: require("./dist/umd.js"),
  };

  for (const [entry, merge] of Object.entries(modules)) {
    test(`${copy} ${entry}: source and target cannot poison result prototypes`, () => {
      const malicious = JSON.parse('{"__proto__":{"isAdmin":true},"safe":"value"}');
      const empty = () => Object.create(null);
      const results = [
        merge(malicious, {}),
        merge(empty(), malicious),
        merge(malicious, malicious),
        merge({ nested: malicious }, {}).nested,
        merge({ nested: empty() }, { nested: malicious }).nested,
        merge([], [malicious])[0],
        merge.all([malicious, { safe: "value" }]),
      ];
      for (const result of results) {
        assert.equal(Object.getPrototypeOf(result), Object.prototype);
        assert.equal(result.isAdmin, undefined);
        assert.equal(result.safe, "value");
      }
      assert.equal({}.isAdmin, undefined);
    });

    test(`${copy} ${entry}: own special keys are data and normal merge behavior survives`, () => {
      const own = JSON.parse('{"__proto__":{"isAdmin":true}}');
      const result = merge(own, { safe: 1 });
      assert.ok(Object.hasOwn(result, "__proto__"));
      assert.deepEqual(Object.getOwnPropertyDescriptor(result, "__proto__"), {
        value: { isAdmin: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const symbol = Symbol("metadata");
      assert.deepEqual(
        merge(
          { list: [1], nested: { a: 1 }, [symbol]: "kept" },
          {
            list: [2],
            nested: { b: 2 },
          },
        ),
        { list: [1, 2], nested: { a: 1, b: 2 }, [symbol]: "kept" },
      );
      assert.deepEqual(
        merge(
          { list: [1] },
          { list: [2] },
          {
            customMerge: (key) => (key === "list" ? (a, b) => [...b, ...a] : undefined),
          },
        ),
        { list: [2, 1] },
      );
    });
  }
}

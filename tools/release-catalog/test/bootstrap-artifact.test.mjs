import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as producer from "../bootstrap-artifact.mjs";
const { assertBootstrapCompatibility } = producer;
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
async function payload() {
  const base = JSON.parse(await readFile(join(root, "tsconfig.base.json")));
  const api = JSON.parse(await readFile(join(root, "apps/api/tsconfig.json")));
  const options = ts.convertCompilerOptionsFromJson(
    { ...base.compilerOptions, ...api.compilerOptions },
    root,
  );
  assert.deepEqual(options.errors, []);
  const source = await readFile(
    join(root, "apps/api/src/modules/release-catalog/catalog-bootstrap.ts"),
  );
  const emitted = ts.transpileModule(source.toString("utf8"), {
    compilerOptions: options.options,
    fileName: "catalog-bootstrap.ts",
    reportDiagnostics: true,
  });
  assert.deepEqual(emitted.diagnostics, []);
  return {
    source,
    compiled: Buffer.from(emitted.outputText),
    runtime: await readFile(join(root, "tools/release-catalog/bootstrap-runtime.mjs")),
  };
}
test("mount-only bootstrap artifact requires byte-identical accepted runtime sources and lockfile", () => {
  assert.doesNotThrow(() =>
    assertBootstrapCompatibility(["apps/api/src/modules/release-catalog/catalog-bootstrap.ts"]),
  );
  for (const path of [
    "apps/api/src/modules/release-catalog/catalog-repository.ts",
    "packages/platform-contracts/src/release-catalog.ts",
    "pnpm-lock.yaml",
  ])
    assert.throws(() =>
      assertBootstrapCompatibility([
        "apps/api/src/modules/release-catalog/catalog-bootstrap.ts",
        path,
      ]),
    );
  assert.throws(() => assertBootstrapCompatibility([]));
});

const awaitedPayload = await payload();

// This exact overlay was reviewed in PR809 and imported in accepted image8ec with network=none.
// The application/DB built from newer main is never mounted into that immutable image.
const advancedPaths = [
  "apps/api/src/modules/release-catalog/catalog-bootstrap.ts",
  "apps/api/src/env.ts",
  "packages/db/src/schema/landing-leads.ts",
];
test("frozen bootstrap payload remains admissible while unrelated main API sources advance", () => {
  assert.throws(() => assertBootstrapCompatibility(advancedPaths));
  assert.doesNotThrow(() =>
    producer.assertBootstrapArtifactCompatibility(advancedPaths, awaitedPayload),
  );
});
for (const member of ["source", "compiled", "runtime"]) {
  test(`frozen bootstrap rejects changed ${member} bytes without accepting unrelated runtime output`, () => {
    const changed = {
      ...awaitedPayload,
      [member]: Buffer.concat([awaitedPayload[member], Buffer.from("\n")]),
    };
    assert.throws(
      () => producer.assertBootstrapArtifactCompatibility(advancedPaths, changed),
      /Frozen bootstrap payload rejected/u,
    );
    const flipped = Buffer.from(awaitedPayload[member]);
    flipped[0] ^= 1;
    assert.throws(
      () =>
        producer.assertBootstrapArtifactCompatibility(advancedPaths, {
          ...awaitedPayload,
          [member]: flipped,
        }),
      /Frozen bootstrap payload rejected/u,
    );
    const truncated = { ...awaitedPayload, [member]: awaitedPayload[member].subarray(1) };
    assert.throws(
      () => producer.assertBootstrapArtifactCompatibility(advancedPaths, truncated),
      /Frozen bootstrap payload rejected/u,
    );
  });
}

test("frozen admission still rejects missing tracked bootstrap source and malformed path evidence", () => {
  for (const paths of [[], null, ["apps/api/src/env.ts"], [...advancedPaths, "../outside"]]) {
    assert.throws(
      () => producer.assertBootstrapArtifactCompatibility(paths, awaitedPayload),
      /Frozen bootstrap payload rejected/u,
    );
  }
});

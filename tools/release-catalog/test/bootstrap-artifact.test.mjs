import test from "node:test";
import assert from "node:assert/strict";
import { assertBootstrapCompatibility } from "../bootstrap-artifact.mjs";
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

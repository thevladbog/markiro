import assert from "node:assert/strict";
import test from "node:test";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chainFixture } from "./configuration-chain-fixture.mjs";
import { verifyCatalogConfigurationSource } from "../catalog-configuration.mjs";

test("catalog source uses accepted replacement and rejects old or substituted API identity", async (t) => {
  const f = await chainFixture(t);
  const after = f.records[0].receipt.after;
  const operation = {
    schema: 2,
    acceptedOperationId: f.baseline.acceptedOperationId,
    containers: { api: after.api },
    configuration: { baseline: f.baseline, head: f.index.head, runtime: after.runtime },
  };
  await verifyCatalogConfigurationSource(operation, f.root);
  const wrong = structuredClone(operation);
  wrong.containers.api = f.baseline.api;
  await assert.rejects(verifyCatalogConfigurationSource(wrong, f.root));
  await assert.rejects(verifyCatalogConfigurationSource({ schema: 1 }, f.root));
  await writeFile(join(f.root, "config-pending.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(verifyCatalogConfigurationSource(operation, f.root));
});

test("legacy catalog source remains available before any successor but refuses pending configuration", async (t) => {
  const f = await chainFixture(t);
  await unlink(join(f.root, "config-index.json"));
  await verifyCatalogConfigurationSource({ schema: 1 }, f.root);
  await writeFile(join(f.root, "config-pending.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(verifyCatalogConfigurationSource({ schema: 1 }, f.root));
});

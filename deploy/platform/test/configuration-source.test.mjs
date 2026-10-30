import assert from "node:assert/strict";
import test from "node:test";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chainFixture } from "./configuration-chain-fixture.mjs";
import { resolveBoundConfigurationRuntime } from "../host/configuration-source.mjs";

test("current source adapter resolves exact head and preserves the base acceptance", async (t) => {
  const f = await chainFixture(t);
  const actual = await resolveBoundConfigurationRuntime({
    root: f.root,
    baseline: f.baseline,
    expectedHead: f.index.head,
  });
  assert.deepEqual(actual, {
    acceptedOperationId: f.baseline.acceptedOperationId,
    ...f.records[0].receipt.after,
  });
});

test("current source adapter denies stale original plans after a successor and pending work", async (t) => {
  const f = await chainFixture(t);
  await assert.rejects(
    resolveBoundConfigurationRuntime({ root: f.root, baseline: f.baseline, expectedHead: null }),
  );
  const stale = { ...f.index.head, receiptSha256: "0".repeat(64) };
  await assert.rejects(
    resolveBoundConfigurationRuntime({ root: f.root, baseline: f.baseline, expectedHead: stale }),
  );
  await writeFile(join(f.root, "config-pending.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(
    resolveBoundConfigurationRuntime({
      root: f.root,
      baseline: f.baseline,
      expectedHead: f.index.head,
    }),
  );
  await unlink(join(f.root, "config-pending.json"));
  assert.equal(
    (
      await resolveBoundConfigurationRuntime({
        root: f.root,
        baseline: f.baseline,
        expectedHead: f.index.head,
      })
    ).api.id,
    f.records[0].receipt.after.api.id,
  );
});

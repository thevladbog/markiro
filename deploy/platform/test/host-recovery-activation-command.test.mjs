// Split from host-recovery-command.test.mjs so it runs on its own worker.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { activationFixture } from "./host-recovery-command-fixture.mjs";

test("activation command uses real adapters/full validator and permits newer dispatch while retaining pinned receipt", async (t) => {
  const f = await activationFixture(t);
  const original = await readFile(join(f.root, "state.json"));
  assert.deepEqual(await f.api.runRecoveryHostCommand(["activate", f.directory], f.options), {
    version: 1,
    kind: "platform-recovery-host-outcome",
    phase: "activate",
    status: "healthy",
  });
  assert.deepEqual(await readFile(join(f.root, "state.json")), original);
  assert.deepEqual(await readFile(join(f.root, "recovery-preparation.json")), f.preparation);
  assert.equal(JSON.parse(await readFile(join(f.root, "recovery-state.json"))).phase, "healthy");
  await assert.rejects(f.api.runRecoveryHostCommand(["activate", f.directory], f.options));
});

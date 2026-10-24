import assert from "node:assert/strict";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { executeUpgradePreparation } from "../host/upgrade-preparation.mjs";
import { withHeldUpgradeState } from "../host/upgrade-state.mjs";
import { upgradeObservationFixture } from "./upgrade-observation-fixture.mjs";
import { upgradeOldRuntime, upgradePreparation } from "./upgrade-fixture.mjs";

async function fixture(t, failure) {
  const f = await upgradeObservationFixture(t);
  const calls = [];
  const old = upgradeOldRuntime(f.input);
  old.containers = f.predecessorContainers;
  const proof = upgradePreparation(f.input, old);
  const statePath = join(f.root, "upgrade-operations", f.input.identity.operationId, "state.json");
  const state = async () => JSON.parse(await readFile(statePath));
  const observation = () => ({
    version: 1,
    kind: "platform-upgrade-observation",
    operationId: f.input.identity.operationId,
    configurationSha256: f.input.oldConfigurationSha256,
    target: f.input.identity.target,
    phase: "admitted",
    containers: f.predecessorContainers,
  });
  const adapters = {};
  for (const name of [
    "verifyAdmission",
    "inspectOld",
    "inspectSchema",
    "stopOldEdge",
    "stopOldApi",
    "inspectStoppedOld",
    "createBackup",
  ])
    adapters[name] = async (context, cap) =>
      withHeldUpgradeState(cap, async (held) => {
        calls.push(name);
        const journal = await state();
        assert.equal(journal.admission.identity.operationId, f.input.identity.operationId);
        assert.ok(await lstat(join(f.root, ".deploy.lock")));
        if (name.startsWith("stop")) {
          assert.equal(journal.phase, "old-stopped");
          assert.equal(journal.status, "entered");
          assert.deepEqual(journal.oldRuntime, old);
        }
        if (failure === name) throw new Error("fixture failure");
        if (name === "verifyAdmission") return held.state.admission.identity;
        if (["inspectOld", "inspectStoppedOld"].includes(name))
          return { ...observation(), phase: journal.phase };
        if (name === "inspectSchema") return old.schema;
        if (name === "createBackup") {
          assert.equal(journal.phase, "backup-verified");
          return { backup: proof.backup, fence: proof.fence };
        }
      });
  return {
    ...f,
    old,
    proof,
    state,
    calls,
    adapters,
    context: { root: f.root, admission: f.input },
  };
}
const run = (f) => executeUpgradePreparation(f.context, f.adapters, { now: () => f.now });
test("preparation durably binds old IDs/schema before exact edge/API stops and fresh backup", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await run(f), f.proof);
  assert.deepEqual(f.calls, [
    "verifyAdmission",
    "inspectOld",
    "inspectSchema",
    "stopOldEdge",
    "inspectOld",
    "stopOldApi",
    "inspectStoppedOld",
    "inspectSchema",
    "createBackup",
    "inspectStoppedOld",
    "inspectSchema",
  ]);
  const state = await f.state();
  assert.equal(state.sequence, 6);
  assert.equal(state.phase, "backup-verified");
  assert.equal(state.status, "completed");
  assert.equal(state.migrationEntered, false);
  assert.deepEqual(state.preparation, f.proof);
});
for (const failure of [
  "verifyAdmission",
  "inspectOld",
  "inspectSchema",
  "stopOldEdge",
  "stopOldApi",
  "inspectStoppedOld",
  "createBackup",
])
  test(`preparation failure ${failure} retains facts without starting candidate`, async (t) => {
    const f = await fixture(t, failure);
    await assert.rejects(run(f));
    const state = await f.state();
    assert.equal(state.status, "recovery-required");
    assert.equal(state.migrationEntered, false);
    if (f.calls.some((name) => name.startsWith("stop"))) assert.deepEqual(state.oldRuntime, f.old);
    assert.equal(
      f.calls.some((name) => /migrate|start|remove/u.test(name)),
      false,
    );
  });
for (const mode of ["schema", "migration", "containers", "backup", "expiry", "unreaped"])
  test(`preparation rejects changed ${mode} at await boundary`, async (t) => {
    const f = await fixture(t);
    let count = 0;
    if (["schema", "migration"].includes(mode)) {
      const original = f.adapters.inspectSchema;
      f.adapters.inspectSchema = async (...args) => {
        const result = await original(...args);
        return ++count === 1
          ? result
          : { ...result, [mode === "schema" ? "schemaSha256" : "migrationSha256"]: "c".repeat(64) };
      };
    }
    if (mode === "containers") {
      const original = f.adapters.inspectStoppedOld;
      f.adapters.inspectStoppedOld = async (...args) => ({
        ...(await original(...args)),
        containers: { ...f.predecessorContainers, api: "7".repeat(64) },
      });
    }
    if (mode === "backup") {
      const original = f.adapters.createBackup;
      f.adapters.createBackup = async (...args) => {
        const value = await original(...args);
        value.backup.operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        return value;
      };
    }
    if (mode === "expiry") {
      const original = f.adapters.stopOldEdge;
      f.adapters.stopOldEdge = async (...args) => {
        await original(...args);
        f.now = Date.parse(f.input.expiresAt);
      };
    }
    if (mode === "unreaped")
      f.adapters.stopOldEdge = async () => {
        throw Object.assign(new Error("fixture"), { terminationConfirmed: false });
      };
    await assert.rejects(run(f));
    if (mode === "unreaped") assert.ok(await lstat(join(f.root, ".deploy.lock")));
    else assert.equal((await f.state()).status, "recovery-required");
  });

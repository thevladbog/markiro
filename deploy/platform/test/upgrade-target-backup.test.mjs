import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHeldUpgradeBackup } from "../host/target-backup.mjs";
import { withUpgradeState } from "../host/upgrade-state.mjs";
import { upgradeObservationFixture } from "./upgrade-observation-fixture.mjs";
import { targetBackupFixture } from "./target-backup-fixture.mjs";
import { upgradeOldRuntime } from "./upgrade-fixture.mjs";

async function fixture(t, mode) {
  const b = await targetBackupFixture(t, mode);
  const f = await upgradeObservationFixture(t, {
    daemonFixture: {
      f: b.f,
      op: b.input.operation,
      policy: b.input.observationPolicy,
      state: b.daemon,
    },
    candidateOperationId: b.input.operation.identity.operationId,
  });
  f.stop();
  await b.publish();
  const runtimeName = `upgrade-backup-runtime-${f.input.identity.operationId}.json`;
  await b.save(runtimeName, b.runtime);
  await b.save(`recovery-backup-runtime-${f.input.predecessor.identity.operationId}.json`, {
    ...b.runtime,
    executorSha: f.input.predecessor.identity.executorSha,
  });
  return { ...f, b, runtimeName };
}
for (const mode of [
  "valid",
  "forged",
  "wrong-phase",
  "changed-stopped-id",
  "wrong-config",
  "wrong-source-runtime",
  "cleanup",
  "restore-cleanup",
  "unreaped",
])
  test(`held actual-source upgrade backup: ${mode}`, async (t) => {
    const f = await fixture(t, mode);
    const before = await readFile(join(f.root, "backup-runtime.json"));
    let succeeded = false;
    if (mode === "changed-stopped-id") {
      f.b.daemon.containers[1].Id = "7".repeat(64);
      await f.b.publish();
    }
    if (mode === "wrong-source-runtime")
      await writeFile(
        join(f.root, "backup-runtime.json"),
        JSON.stringify({ ...f.b.runtime, executorSha: "1".repeat(40) }),
      );
    const execution = withUpgradeState(
      f.root,
      f.input,
      async (store) => {
        await store.complete("admitted", upgradeOldRuntime(f.input));
        await store.enter("old-stopped");
        await store.complete("old-stopped");
        if (mode !== "wrong-phase") await store.enter("backup-verified");
        const input = { ...f.b.input, operation: f.candidateOperation };
        if (mode === "wrong-config")
          input.operation = { ...input.operation, configuration: f.oldOperation.configuration };
        const call = () =>
          store.guard((cap) =>
            createHeldUpgradeBackup(input, mode === "forged" ? {} : cap, f.input, f.b.options),
          );
        if (mode !== "valid") await assert.rejects(call());
        else {
          const result = await call();
          const evidence = JSON.parse(await readFile(result.restoreEvidence.evidencePath));
          const inventory = JSON.parse(await readFile(result.backup.inventoryPath));
          assert.equal(evidence.status, "completed");
          assert.equal(inventory.executorSha, f.input.identity.executorSha);
          assert.equal(result.fence.fenceId, inventory.fence.before.fenceId);
          assert.equal(f.b.docker.containers.size + f.b.docker.volumes.size, 0);
          assert.equal(f.b.boundaries(), 4);
          succeeded = true;
        }
      },
      { now: () => f.now },
    );
    if (["cleanup", "restore-cleanup", "unreaped"].includes(mode)) {
      await assert.rejects(execution, { durabilityUncertain: true });
      assert.ok(await lstat(join(f.root, ".deploy.lock")));
    } else await execution;
    assert.equal(succeeded, mode === "valid");
    if (mode !== "wrong-source-runtime")
      assert.deepEqual(await readFile(join(f.root, "backup-runtime.json")), before);
    if (!["valid", "cleanup", "restore-cleanup", "unreaped"].includes(mode))
      assert.equal(f.b.workerCommands(), 0);
  });

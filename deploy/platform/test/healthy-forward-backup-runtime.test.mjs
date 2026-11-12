import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  readBackupRuntime,
  withForwardBackupRuntime,
  withHealthyForwardBackupRuntime,
  withRecoveryBackupRuntime,
  withUpgradeBackupRuntime,
} from "../backup/local-runtime.mjs";
import { digest } from "../backup/schemas.mjs";
import { withHealthyForwardRollout } from "../host/healthy-forward-rollout-state.mjs";
import { forwardRuntimeDescriptor } from "./forward-backup-fixture.mjs";
import { privateFixture } from "./host-fixtures.mjs";

async function fixture(t, descriptorPatch = {}, approvedHash) {
  const { root } = await privateFixture(t);
  const operationId = "10000000-0000-4000-8000-000000000001";
  const predecessorOperationId = "10000000-0000-4000-8000-000000000002";
  const executorSha = "a".repeat(40);
  const previousIndex = Buffer.from(
    JSON.stringify({
      kind: "platform-forward-recovery-index",
      operationId: predecessorOperationId,
    }),
  );
  await writeFile(join(root, "upgrade-index.json"), previousIndex, { mode: 0o600 });
  const legacy = Buffer.from(JSON.stringify(forwardRuntimeDescriptor("b".repeat(40))));
  const legacyPath = join(root, "backup-runtime.json");
  await writeFile(legacyPath, legacy, { mode: 0o600 });
  const runtimePath = join(root, `healthy-forward-backup-runtime-${operationId}.json`);
  const descriptor = Buffer.from(
    JSON.stringify({ ...forwardRuntimeDescriptor(executorSha), ...descriptorPatch }),
  );
  await writeFile(runtimePath, descriptor, { mode: 0o600 });
  const containers = { api: "c".repeat(64), edge: "d".repeat(64), postgres: "e".repeat(64) };
  const input = {
    root,
    operationId,
    predecessorOperationId,
    predecessorIndexSha256: digest(previousIndex),
    operationSha256: "f".repeat(64),
    postgresId: containers.postgres,
    executorSha,
    backupRuntimeSha256: approvedHash ?? digest(descriptor),
  };
  const stoppedObservations = [];
  const run = (verifyBackup) =>
    withHealthyForwardRollout(input, {
      verifyAuthority: async () => {},
      preflight: async () => {},
      stopSource: async () => {},
      verifySourceStopped: async () => {
        stoppedObservations.push(true);
      },
      verifyBackup,
      activateApi: async () => containers.api,
      activateEdge: async () => containers.edge,
      verifyHealth: async () => containers,
    });
  return {
    root,
    operationId,
    descriptor,
    runtimePath,
    legacy,
    legacyPath,
    run,
    stoppedObservations,
  };
}

test("a stopped rollout mints only the approved live-source runtime and leaves legacy reads intact", async (t) => {
  const f = await fixture(t);
  let expired;
  await assert.rejects(withHealthyForwardBackupRuntime({}, () => assert.fail("forged cap")));
  await f.run(async (capability) => {
    for (const oldMint of [
      withRecoveryBackupRuntime,
      withUpgradeBackupRuntime,
      withForwardBackupRuntime,
    ]) {
      await assert.rejects(
        oldMint(capability, () => assert.fail("healthy capability passed a legacy gate")),
      );
    }
    await withHealthyForwardBackupRuntime(capability, async (held, context) => {
      expired = context;
      assert.equal(held.operation.operationId, f.operationId);
      assert.equal(JSON.stringify(context), "{}");
      const before = f.stoppedObservations.length;
      assert.deepEqual(await readBackupRuntime(f.root, f.operationId, context), f.descriptor);
      // Worker commands can read the descriptor while their own resources exist.
      // The producer observes the stopped source at its explicit fence boundaries.
      assert.equal(f.stoppedObservations.length, before);
      await assert.rejects(readBackupRuntime(f.root, "different-operation", context));
      await assert.rejects(
        readBackupRuntime(f.root, f.operationId, JSON.parse(JSON.stringify(context))),
      );
      assert.deepEqual(await readBackupRuntime(f.root, f.operationId), f.legacy);
    });
    await assert.rejects(
      withHealthyForwardBackupRuntime(capability, () => assert.fail("reused cap")),
    );
    return "f".repeat(64);
  });
  await assert.rejects(readBackupRuntime(f.root, f.operationId, expired));
  assert.deepEqual(await readFile(f.legacyPath), f.legacy);
});

for (const [description, patch, hash] of [
  ["wrong digest", {}, "0".repeat(64)],
  ["unapproved executor", { executorSha: "0".repeat(40) }],
  ["synthetic runtime", { provenance: "local-synthetic" }],
  ["different Docker executable", { dockerExecutable: "/tmp/docker" }],
  ["different Docker endpoint", { endpoint: "unix:///tmp/docker.sock" }],
]) {
  test(`a stopped rollout rejects a descriptor with ${description}`, async (t) => {
    const f = await fixture(t, patch, hash);
    await assert.rejects(
      f.run((capability) =>
        withHealthyForwardBackupRuntime(capability, () =>
          assert.fail("invalid runtime was minted"),
        ),
      ),
      { durabilityUncertain: true },
    );
    assert.deepEqual(await readFile(f.legacyPath), f.legacy);
  });
}

test("changed worker descriptor bytes fail both runtime reads and the exit guard", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run((capability) =>
      withHealthyForwardBackupRuntime(capability, async (_held, context) => {
        await writeFile(f.runtimePath, Buffer.concat([f.descriptor, Buffer.from("\n")]));
        await assert.rejects(readBackupRuntime(f.root, f.operationId, context));
        return "f".repeat(64);
      }),
    ),
    { durabilityUncertain: true },
  );
});

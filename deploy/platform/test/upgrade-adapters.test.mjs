import test from "node:test";
import assert from "node:assert/strict";
import { createUpgradeHostAdapters, hostFenceEnforcementSha256 } from "../host/command.mjs";
import { upgradeObservationFixture } from "./upgrade-observation-fixture.mjs";
test("upgrade host adapters inspect exact stopped old apps under whole old authority", async (t) => {
  const f = await upgradeObservationFixture(t);
  f.stop();
  const files = {
    "deploy/platform/postgres/pg_hba.conf": "a".repeat(64),
    "deploy/platform/postgres/roles.mjs": "b".repeat(64),
  };
  const operation = {
    ...f.candidateOperation,
    preparedTarget: {
      fence: {
        enforcementSha256: hostFenceEnforcementSha256({
          target: f.input.identity.target,
          policy: f.policy,
          hbaSha256: files["deploy/platform/postgres/pg_hba.conf"],
        }),
      },
    },
    preparedPolicy: { rolePolicySha256: files["deploy/platform/postgres/roles.mjs"] },
  };
  const loaded = {
    record: { deployment: operation, observationPolicy: f.policy },
    receipt: { files },
    verified: { evidence: { cleanup: { resources: [] } } },
    verifySources: async () => {},
  };
  const adapters = await createUpgradeHostAdapters(
    loaded,
    f.oldOperation,
    f.predecessorContainers,
    f.dependencies,
  );
  const context = {
    ...operation,
    phase: "activation-admitted",
    boundary: "entry",
    allowedServices: ["postgres"],
    migration: { name: `markiro-platform-migrate-${f.input.identity.operationId}` },
  };
  await adapters.verifyImages(context);
  assert.equal((await adapters.inventory(context)).owned.length, 3);
  f.d.state.containers[1].Config.Env.push("FOREIGN=value");
  await assert.rejects(adapters.inventory(context));
});
test("installed activation adapters require a live phase capability before any Docker call", async (t) => {
  const { createUpgradeActivationAdapters } =
    await import("../host/upgrade-activation-adapters.mjs");
  const f = await upgradeObservationFixture(t);
  let calls = 0;
  const adapters = createUpgradeActivationAdapters(
    {
      record: {
        operation: {
          ...f.candidateOperation,
          admission: f.input,
          predecessorContainers: f.predecessorContainers,
        },
        observationPolicy: f.policy,
      },
      verifySources: async () => {},
    },
    f.oldOperation,
    async () => {},
    { evidence: { cleanup: { resources: [] } } },
    {
      runProcess: async () => {
        calls++;
        assert.fail("No unguarded Docker");
      },
    },
  );
  for (const name of [
    "verifyRelease",
    "verifyImages",
    "verifyRoles",
    "inspectTarget",
    "inspectMigration",
    "smoke",
    "cleanupOwnedWorkloads",
  ])
    await assert.rejects(adapters[name]({}, {}));
  await assert.rejects(adapters.writerFence.observe({}, {}));
  await assert.rejects(adapters.workload.inspect({}, {}));
  assert.equal(calls, 0);
});
test("activation failure cleanup preserves retained old IDs", async (t) => {
  const { createUpgradeActivationAdapters } =
    await import("../host/upgrade-activation-adapters.mjs");
  const { withUpgradeState, withUpgradePhaseState } = await import("../host/upgrade-state.mjs");
  const { upgradeOldRuntime, upgradePreparation, upgradeHash } =
    await import("./upgrade-fixture.mjs");
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const f = await upgradeObservationFixture(t);
  const old = upgradeOldRuntime(f.input);
  old.containers = f.predecessorContainers;
  const proof = upgradePreparation(f.input, old);
  await withUpgradeState(
    f.root,
    f.input,
    async (s) => {
      await s.complete("admitted", old);
      await s.enter("old-stopped");
      f.stop();
      await s.complete("old-stopped");
      await s.enter("backup-verified");
      await s.complete("backup-verified", proof.backup, proof);
    },
    { now: () => f.now },
  );
  const b = await readFile(
    join(f.root, "upgrade-operations", f.input.identity.operationId, "state.json"),
  );
  const decision = {
    version: 1,
    kind: "platform-upgrade-phase",
    phase: "activate",
    identity: f.input.identity,
    prior: { sequence: 6, sha256: upgradeHash(b) },
    executorCi: f.input.executorCi,
    reviewedPlanSha256: f.input.reviewedPlanSha256,
    dispatch: { ...f.input.dispatch, runId: "987654333" },
    expiresAt: f.input.expiresAt,
  };
  let calls = 0;
  const adapters = createUpgradeActivationAdapters(
    {
      record: {
        operation: {
          ...f.candidateOperation,
          admission: f.input,
          decision,
          predecessorContainers: f.predecessorContainers,
        },
        observationPolicy: f.policy,
      },
      verifySources: async () => {},
    },
    f.oldOperation,
    async () => {},
    { evidence: { cleanup: { resources: [] } } },
    {
      ...f.dependencies,
      runProcess: async (request) => {
        if (request.args.includes("stop")) {
          calls++;
          assert.fail("Retained containers cannot be stopped by candidate cleanup");
        }
        return f.dependencies.runProcess(request);
      },
    },
  );
  const context = {
    ...f.candidateOperation,
    phase: "migration-entered",
    boundary: "recovery",
    migration: { name: `markiro-platform-migrate-${f.input.identity.operationId}` },
  };
  await withUpgradePhaseState(
    f.root,
    decision,
    async (s) => {
      await s.complete("activation-admitted");
      await s.enter("migration-entered");
      await s.fail();
      await s.cleanup((cap) => adapters.cleanupOwnedWorkloads(context, cap));
    },
    { now: () => f.now },
  );
  assert.equal(calls, 0);
});
test("live activation capability reaches real image and backup-cleanup adapters with producer identity", async (t) => {
  const { upgradeCommandFixture } = await import("./upgrade-command-fixture.mjs");
  const { createUpgradeActivationAdapters } =
    await import("../host/upgrade-activation-adapters.mjs");
  const { readVerifiedBackup } = await import("../host/backup-gate.mjs");
  const { withUpgradeState, withUpgradePhaseState } = await import("../host/upgrade-state.mjs");
  const { upgradeOldRuntime, upgradePreparation, upgradeHash } =
    await import("./upgrade-fixture.mjs");
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const f = await upgradeCommandFixture(t, { production: true }),
    op = f.record.operation;
  for (const doc of [f.base.document, f.base.evidence]) {
    doc.target = f.input.identity.target;
    for (const value of Object.values(doc.fence)) value.target = f.input.identity.target;
  }
  await f.base.publish();
  op.preparedTarget = f.base.record;
  op.preparedTarget.fence.enforcementSha256 = hostFenceEnforcementSha256({
    target: f.input.identity.target,
    policy: f.policy,
    hbaSha256: f.receipt.files["deploy/platform/postgres/pg_hba.conf"],
  });
  op.preparedPolicy = {
    backup: f.base.backup,
    restoreEvidence: f.base.restoreEvidence,
    rolePolicySha256: f.receipt.files["deploy/platform/postgres/roles.mjs"],
  };
  const verified = await readVerifiedBackup({
    root: f.root,
    identity: f.input.identity,
    ...op.preparedPolicy,
  });
  const old = upgradeOldRuntime(f.input);
  old.containers = f.predecessorContainers;
  const prep = upgradePreparation(f.input, old);
  prep.backup = verified.backupProof;
  prep.fence = op.preparedTarget.fence;
  await withUpgradeState(f.root, f.input, async (s) => {
    await s.complete("admitted", old);
    await s.enter("old-stopped");
    f.stop();
    await s.complete("old-stopped");
    await s.enter("backup-verified");
    await s.complete("backup-verified", prep.backup, prep);
  });
  const b = await readFile(
    join(f.root, "upgrade-operations", f.input.identity.operationId, "state.json"),
  );
  op.decision = {
    version: 1,
    kind: "platform-upgrade-phase",
    phase: "activate",
    identity: f.input.identity,
    prior: { sequence: 6, sha256: upgradeHash(b) },
    executorCi: f.input.executorCi,
    reviewedPlanSha256: f.input.reviewedPlanSha256,
    dispatch: { ...f.input.dispatch, runId: "987654333" },
    expiresAt: f.input.expiresAt,
  };
  const adapters = createUpgradeActivationAdapters(
    {
      record: f.record,
      receipt: f.receipt,
      operationDirectory: f.directory,
      verifySources: async () => {},
    },
    f.oldOperation,
    async () => {},
    verified,
    f.dependencies,
  );
  assert.deepEqual(adapters.workload.identity, { resources: verified.evidence.cleanup.resources });
  assert.equal(adapters.workload.executorSha, f.input.identity.executorSha);
  await withUpgradePhaseState(f.root, op.decision, async (s) => {
    const context = {
      ...f.candidateOperation,
      phase: "activation-admitted",
      boundary: "entry",
      allowedServices: ["postgres"],
    };
    await s.guard((cap) => adapters.verifyImages(context, cap));
    const absent = await s.guard((cap) => adapters.workload.inspect(context, cap));
    assert.equal(absent.status, "absent");
    assert.deepEqual(absent.resources, verified.evidence.cleanup.resources);
  });
});

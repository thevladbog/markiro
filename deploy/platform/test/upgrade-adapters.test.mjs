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
    "cleanupOwnedProbes",
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
async function activationFixture(t, wrap = (dependencies) => dependencies) {
  const { upgradeCommandFixture } = await import("./upgrade-command-fixture.mjs");
  const { createUpgradeActivationAdapters } =
    await import("../host/upgrade-activation-adapters.mjs");
  const { readVerifiedBackup } = await import("../host/backup-gate.mjs");
  const { withUpgradeState } = await import("../host/upgrade-state.mjs");
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
    wrap(f.dependencies, f),
  );
  return { f, op, adapters, verified, old };
}
test("live activation capability reaches real image and backup-cleanup adapters with producer identity", async (t) => {
  const { f, op, adapters, verified } = await activationFixture(t);
  const { withUpgradePhaseState } = await import("../host/upgrade-state.mjs");
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

for (const mode of ["expired", "unreaped", "replaced probe", "changed predecessor"]) {
  test(`actual activation role probe ${mode}: cleanup owns exact probe and fresh return stays guarded`, async (t) => {
    const { readFile, writeFile, lstat } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { runHostProcess } = await import("../host/process.mjs");
    const { withUpgradePhaseState, withHeldUpgradeState } =
      await import("../host/upgrade-state.mjs");
    const { createUpgradeObservers } = await import("../host/upgrade-observation.mjs");
    const { executeUpgradeReturn } = await import("../host/upgrade-return.mjs");
    const { upgradeHash } = await import("./upgrade-fixture.mjs");
    let now = Date.now(),
      started = false,
      cleaned = false;
    const { f, op, adapters, old } = await activationFixture(t, (dependencies, fixture) => ({
      ...dependencies,
      runProcess: async (request, recheck) => {
        const args = request.args.slice(2);
        const probe =
          args[0] === "create" ||
          args[0] === "start" ||
          args.includes("{{.Names}}") ||
          args.some((a) => a.startsWith("markiro-platform-probe-")) ||
          (args[1] === "rm" && args.at(-1) === "7".repeat(64));
        if (!probe) return dependencies.runProcess(request, recheck);
        fixture.d.state.probeResult = {
          postgresVersion: "17.11",
          tls: fixture.base.record.observations.tls.value,
        };
        await fixture.d.publish();
        const result = await runHostProcess({
          ...request,
          executable: process.execPath,
          args: [
            fileURLToPath(new URL("./fixtures/host-docker.mjs", import.meta.url)),
            fixture.d.stateFile,
            JSON.stringify(args),
          ],
        });
        Object.assign(fixture.d.state, JSON.parse(await readFile(fixture.d.stateFile)));
        if (args[0] === "start") {
          started = true;
          now = Date.parse(fixture.input.expiresAt) + 1;
          if (mode === "unreaped")
            throw Object.assign(Error("unknown termination"), { terminationConfirmed: false });
        }
        if (args[1] === "rm") cleaned = true;
        return result;
      },
    }));
    const context = {
      ...f.candidateOperation,
      phase: "activation-admitted",
      boundary: "verifyRoles",
      allowedServices: ["postgres"],
    };
    const execution = withUpgradePhaseState(
      f.root,
      op.decision,
      async (s) => {
        await assert.rejects(s.guard((cap) => adapters.verifyRoles(context, cap)));
        assert.equal(started, true);
        assert.equal(f.d.state.containers.length, 4);
        if (mode === "unreaped")
          throw Object.assign(Error("unknown termination"), { terminationConfirmed: false });
        await s.fail();
        if (mode === "replaced probe") f.d.state.containers.at(-1).Id = "8".repeat(64);
        if (mode === "changed predecessor")
          await writeFile(join(f.root, "recovery-state.json"), "changed");
        await s.cleanup((cap) =>
          adapters.cleanupOwnedProbes({ ...context, boundary: "recovery" }, cap),
        );
      },
      { now: () => now },
    );
    if (mode !== "expired") {
      await assert.rejects(execution);
      assert.equal(cleaned, false);
      assert.ok(await lstat(join(f.root, ".deploy.lock")));
      return;
    }
    await execution;
    assert.equal(cleaned, true);
    assert.equal(f.d.state.containers.length, 3);
    assert.deepEqual(
      Object.fromEntries(
        f.d.state.containers.map((c) => [c.Config.Labels["com.docker.compose.service"], c.Id]),
      ),
      old.containers,
    );
    const journal = join(f.root, "upgrade-operations", f.input.identity.operationId, "state.json");
    const before = await readFile(journal),
      state = JSON.parse(before);
    assert.equal(state.migrationEntered, false);
    const decision = {
      ...op.decision,
      phase: "return-old",
      prior: { sequence: state.sequence, sha256: upgradeHash(before) },
      dispatch: { ...op.decision.dispatch, runId: "987654334" },
      expiresAt: new Date(now + 600000).toISOString(),
    };
    const observers = createUpgradeObservers(
      {
        admission: f.input,
        oldOperation: f.oldOperation,
        candidateOperation: f.candidateOperation,
        predecessorContainers: f.predecessorContainers,
        policy: f.policy,
      },
      f.dependencies,
    );
    const start = (service) => async (_ctx, cap) =>
      withHeldUpgradeState(cap, async () => {
        const c = f.d.state.containers.find((c) => c.Id === old.containers[service]);
        c.State = {
          Running: true,
          Restarting: false,
          Paused: false,
          Status: "running",
          Health: { Status: "healthy" },
        };
      });
    const returned = await executeUpgradeReturn(
      { root: f.root, decision },
      {
        verifyAdmission: async () => f.input.identity,
        inspectReturnEligibility: (_ctx, cap) => observers.inspectReturnEligibility(cap),
        inspectSchema: async () => old.schema,
        startOldApi: start("api"),
        startOldEdge: start("edge"),
        verifyOldHealth: async () => {},
        smoke: async () => {},
        cleanupOwnedStarts: async () => assert.fail("No failed return expected"),
      },
      { now: () => now },
    );
    assert.deepEqual(returned, old);
    assert.equal(JSON.parse(await readFile(journal)).phase, "returned-old");
  });
}

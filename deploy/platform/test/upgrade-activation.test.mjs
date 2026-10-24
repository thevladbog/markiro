import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { productionFixture } from "./production-activation-fixture.mjs";
import { hostIdentity } from "./host-fixtures.mjs";
import {
  upgradeFixture,
  upgradeHash,
  upgradeOldRuntime,
  upgradePreparation,
} from "./upgrade-fixture.mjs";
import { withUpgradeState, withHeldUpgradeState } from "../host/upgrade-state.mjs";
import { executeUpgradeActivation } from "../host/upgrade-activation.mjs";
async function fixture(t, failAt) {
  const f = await productionFixture(t, { nested: true });
  const recovered = {
    ...hostIdentity(),
    executorSha: "69f288e0a5299cabee229ce7dddf58bcba9fd22c",
    configurationSha256: f.identity.configurationSha256,
  };
  const u = upgradeFixture({
    root: f.root,
    identity: f.identity,
    recovered,
    prior: {
      ...hostIdentity(),
      configurationSha256: recovered.configurationSha256,
      admission: recovered.admission,
    },
    configuration: f.expected.configuration,
  });
  u.input.expiresAt = new Date(Date.now() + 600000).toISOString();
  const op = join(dirname(f.root), "recovery-operations", recovered.operationId, "activate");
  await mkdir(op, { recursive: true, mode: 0o700 });
  for (const [n, p] of Object.entries({
    original: join(f.root, "state.json"),
    acceptedRecovery: join(f.root, "recovery-state.json"),
    preparation: join(f.root, "recovery-preparation.json"),
    consumption: join(f.root, `recovery-activation-${recovered.operationId}.json`),
    activationOperation: join(op, "operation.json"),
  }))
    await writeFile(p, u.predecessorBytes[n], { mode: 0o600 });
  const old = upgradeOldRuntime(u.input);
  const proof = upgradePreparation(u.input, old);
  proof.backup = {
    operationId: f.identity.operationId,
    target: f.identity.target,
    archiveSha256: f.backup.archiveSha256,
    restoreEvidenceSha256: f.restoreEvidence.evidenceSha256,
  };
  proof.fence = f.record.fence;
  await withUpgradeState(f.root, u.input, async (s) => {
    await s.complete("admitted", old);
    await s.enter("old-stopped");
    await s.complete("old-stopped");
    await s.enter("backup-verified");
    await s.complete("backup-verified", proof.backup, proof);
  });
  const journal = join(f.root, "upgrade-operations", f.identity.operationId, "state.json");
  const before = await readFile(journal);
  const decision = {
    version: 1,
    kind: "platform-upgrade-phase",
    phase: "activate",
    identity: f.identity,
    prior: { sequence: 6, sha256: upgradeHash(before) },
    executorCi: u.input.executorCi,
    reviewedPlanSha256: u.input.reviewedPlanSha256,
    dispatch: { ...u.input.dispatch, runId: "987654333" },
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  const { writerFence, workload, root, identity, configuration, ...preparedPolicy } = f.expected;
  const input = {
    root,
    dockerConfig: f.dockerConfig,
    decision,
    configuration,
    preparedTarget: f.record,
    preparedPolicy,
  };
  const trace = [];
  const state = async () => JSON.parse(await readFile(journal));
  const action = async (name) => {
    const s = await state();
    trace.push([name, s.phase, s.status, s.migrationEntered]);
    if (name === failAt) throw Error("private failure");
  };
  const observation = async (oldAuthority) => {
    const s = await state();
    return {
      version: 1,
      kind: "platform-upgrade-observation",
      operationId: identity.operationId,
      configurationSha256: oldAuthority
        ? u.input.oldConfigurationSha256
        : identity.configurationSha256,
      target: identity.target,
      phase: s.phase,
      containers: {
        postgres: old.containers.postgres,
        api: ["api-started", "edge-started", "healthy"].includes(s.phase)
          ? "6".repeat(64)
          : old.containers.api,
        edge: ["edge-started", "healthy"].includes(s.phase) ? "7".repeat(64) : old.containers.edge,
      },
    };
  };
  const adapters = {
    writerFence,
    workload,
    verifyRelease: () => action("release"),
    verifyImages: () => action("images"),
    verifyRoles: () => action("roles"),
    smoke: () => action("smoke"),
    inspectTarget: async () => ({
      target: identity.target,
      project: "markiro-platform",
      serverProfile: "platform-only",
      uiProfile: "platform-only",
      os: "linux",
      architecture: "amd64",
    }),
    inspectStoppedOld: () => observation(true),
    inspectCandidate: () => observation(false),
    inspectSchema: async () => old.schema,
    inspectMigration: async () => ({
      name: `markiro-platform-migrate-${identity.operationId}`,
      ownerOperationId: identity.operationId,
      containerId: null,
      status: "absent",
    }),
    cleanupOwnedProbes: async (ctx, cap) =>
      withHeldUpgradeState(cap, async (h) => {
        assert.equal(h.cleanup, true);
        assert.equal(h.state.status, "recovery-required");
        await action("probe-cleanup");
      }),
    cleanupOwnedWorkloads: async (ctx, cap) =>
      withHeldUpgradeState(cap, async (h) => {
        assert.equal(h.state.status, "recovery-required");
        await action("cleanup");
      }),
    runProcess: async (request, recheck) => {
      recheck();
      assert.equal(request.executable, "/usr/bin/docker");
      assert.equal(request.env.DATABASE_URL, undefined);
      assert.equal(request.env.COMPOSE_DISABLE_ENV_FILE, "1");
      const args = request.args;
      const name = args.includes("pull") ? "pull" : args.includes("run") ? "migrate" : args.at(-1);
      if (name === "migrate") assert.equal((await state()).migrationEntered, true);
      await action(name);
    },
  };
  return { ...f, u, old, proof, input, decision, journal, state, trace, adapters };
}
const run = (f) => executeUpgradeActivation(f.input, f.adapters);
test("activation uses real backup/copy/key/fence validator then durable migration and API→edge", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await run(f), f.identity);
  assert.deepEqual(
    f.trace.map((r) => r[0]),
    ["release", "pull", "images", "migrate", "roles", "api", "edge", "smoke"],
  );
  const s = await f.state();
  assert.equal(s.sequence, 18);
  assert.equal(s.phase, "healthy");
  assert.equal(s.status, "completed");
  assert.equal(s.migrationEntered, true);
  const n = f.trace.length;
  await assert.rejects(run(f));
  assert.equal(f.trace.length, n);
});
for (const mutation of [
  "archive",
  "key",
  "copies",
  "fence",
  "sourcehold",
  "synthetic",
  "identity",
  "config",
  "expired",
  "prepare-only",
])
  test(`activation refuses ${mutation} before migrator or app command`, async (t) => {
    const f = await fixture(t);
    if (mutation === "archive") await writeFile(f.backup.archivePath, "changed");
    if (mutation === "key") f.record.observations.keyContinuity.value = {};
    if (mutation === "copies") f.record.observations.offHostRecovery.value = {};
    if (mutation === "fence") f.record.fence.enforcementSha256 = "e".repeat(64);
    if (mutation === "sourcehold")
      f.record.observations.egress.value.sourceHold.expiresAt = new Date(
        Date.now() - 1,
      ).toISOString();
    if (mutation === "synthetic") f.input.preparedPolicy.provenance = "local-synthetic";
    if (mutation === "identity") f.record.operationId = hostIdentity().operationId;
    if (mutation === "config")
      await writeFile(f.input.configuration.runtimeSnapshot.path, "CHANGED=1\n");
    if (mutation === "expired") f.decision.expiresAt = new Date(Date.now() - 1).toISOString();
    if (mutation === "prepare-only") f.input.decision = f.u.input;
    await assert.rejects(run(f));
    assert.equal(
      f.trace.some((r) => ["migrate", "api", "edge"].includes(r[0])),
      false,
    );
  });
for (const failAt of ["migrate", "roles", "api", "edge", "smoke"])
  test(`known ${failAt} failure keeps migration latch and terminal cleanup`, async (t) => {
    const f = await fixture(t, failAt);
    await assert.rejects(run(f), (e) => {
      assert.doesNotMatch(e.stack, /private failure/);
      return true;
    });
    const s = await f.state();
    assert.equal(s.migrationEntered, true);
    assert.equal(s.status, "recovery-required");
    assert.equal(f.trace.at(-1)[0], "cleanup");
  });
test("expiry inside installed process wrapper is checked synchronously at actual spawn", async (t) => {
  const f = await fixture(t);
  const original = f.adapters.runProcess;
  let started = false;
  f.adapters.runProcess = async (request, recheck) => {
    if (request.args.includes("run")) {
      const realNow = Date.now;
      Date.now = () => Date.parse(f.decision.expiresAt);
      try {
        recheck();
        started = true;
      } finally {
        Date.now = realNow;
      }
    } else await original(request, recheck);
  };
  await assert.rejects(run(f));
  assert.equal(started, false);
  assert.equal((await f.state()).migrationEntered, true);
});
test("unreaped migration keeps lock without competing cleanup or later app start", async (t) => {
  const f = await fixture(t);
  const original = f.adapters.runProcess;
  f.adapters.runProcess = async (req, check) => {
    if (req.args.includes("run"))
      throw Object.assign(Error("unreaped"), { terminationConfirmed: false });
    return original(req, check);
  };
  await assert.rejects(run(f));
  assert.ok(await lstat(join(f.root, ".deploy.lock")));
  assert.equal(
    f.trace.some((r) => ["cleanup", "api", "edge"].includes(r[0])),
    false,
  );
});

test("known pre-migration release failure cleans probes under integrity-only recovery capability", async (t) => {
  const f = await fixture(t, "release");
  await assert.rejects(run(f));
  assert.deepEqual(
    f.trace.map((r) => r[0]),
    ["release", "probe-cleanup"],
  );
  assert.equal((await f.state()).migrationEntered, false);
});

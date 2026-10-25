import { join } from "node:path";
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import test from "node:test";
import {
  createForwardObservers,
  createForwardBaselineVerifier,
} from "../host/forward-observation.mjs";
import { withForwardPreparationState, withForwardActivationState } from "../host/forward-state.mjs";
import { forwardPrepared, forwardDecision } from "./forward-fixture.mjs";
import {
  forwardObservationFixture,
  replaceForwardService,
} from "./forward-observation-fixture.mjs";
const open = (f, action) => withForwardPreparationState(f.root, f.input, action, f.options);
const observer = (f) => createForwardObservers(f, f.dependencies);
test("stopped migrated source binds full physical recipe and complete product ledger", async (t) => {
  const f = await forwardObservationFixture(t),
    o = observer(f);
  await open(f, async (s) => {
    const result = await s.guard(o.inspectSource);
    assert.deepEqual(result.containers, f.retainedIds);
    assert.equal(result.schema.migrationCount, "2");
    assert.equal(result.productMigrationProofSha256, f.productMigrationProof.proofSha256);
    assert.equal(result.configurationSha256, f.input.candidateConfigurationSha256);
    await s.complete("admitted", result);
    assert.deepEqual((await s.guard(o.inspectSchema)).schema, f.baseline.schema);
  });
  await assert.rejects(o.inspectSource({}));
});
for (const kind of [
  "old-api-running",
  "foreign-app",
  "recreated-pg",
  "schema",
  "ledger",
  "unknown-migrator",
  "stopped-probe",
  "prepared-transaction",
  "foreign-session",
  "config",
  "authority-mix",
])
  test(`forward source rejects ${kind}`, async (t) => {
    const f = await forwardObservationFixture(t),
      o = observer(f);
    await open(f, async (s) => {
      assert.deepEqual((await s.guard(o.inspectSource)).containers, f.retainedIds);
      if (kind === "old-api-running") f.u.d.state.containers[1].State.Running = true;
      if (kind === "foreign-app")
        f.u.d.state.containers.push({
          Id: "9".repeat(64),
          Config: { Labels: {} },
          State: { Running: true },
          HostConfig: {},
          NetworkSettings: { Networks: {} },
          Mounts: [],
        });
      if (kind === "recreated-pg") f.u.d.state.containers[0].Id = "f".repeat(64);
      if (kind === "schema") f.ledger.schema.schemaSha256 = "e".repeat(64);
      if (kind === "ledger") f.ledger.rows[1].hash = "e".repeat(64);
      if (kind === "unknown-migrator") {
        const c = structuredClone(f.u.d.state.containers[1]);
        c.Id = "f".repeat(64);
        c.Config.Labels["com.docker.compose.service"] = "migrate";
        f.u.d.state.containers.push(c);
      }
      if (kind === "stopped-probe")
        f.u.d.state.containers.push({
          Id: "d".repeat(64),
          Name: "/markiro-platform-probe-unexpected",
          Config: { Labels: {} },
          State: { Running: false },
          HostConfig: {},
          NetworkSettings: { Networks: {} },
          Mounts: [],
        });
      if (kind === "prepared-transaction") f.admin.prepared = 1;
      if (kind === "foreign-session")
        f.admin.sessions.push({ usename: "markiro_app", client_addr: "10.99.0.1" });
      if (kind === "config")
        await appendFile(f.candidateOperation.configuration.runtimeSnapshot.path, "#changed\n");
      if (kind === "authority-mix")
        f.u.d.state.containers[1].Config.Env.push("MARKIRO_RELEASES_DOMAIN=releases.markiro.app");
      await assert.rejects(s.guard(o.inspectSource));
    });
  });
test("activation permits replacement stage by stage and rejects retained IDs after completion", async (t) => {
  const f = await forwardObservationFixture(t),
    o = observer(f),
    proof = forwardPrepared(f);
  await open(f, async (s) => {
    await s.complete("admitted", await s.guard(o.inspectSource));
    await s.enter("source-held");
    await s.complete("source-held");
    await s.enter("backup-verified");
    await s.complete("backup-verified", proof.backup, proof.preparation);
  });
  const prior = JSON.parse(
    await readFile(
      join(f.root, "forward-recovery-operations", f.input.identity.operationId, "state.json"),
    ),
  );
  const oldEdge = structuredClone(f.u.d.state.containers[2]);
  await withForwardActivationState(
    f.root,
    forwardDecision(f, prior),
    async (s) => {
      await s.guard(o.inspectCandidate);
      await s.complete("activation-admitted");
      await s.enter("api-started");
      await s.guard(o.inspectCandidate);
      replaceForwardService(f, "api");
      await s.guard(o.inspectCandidate);
      await s.complete("api-started");
      await s.enter("edge-started");
      const acceptedApiId = f.u.d.state.containers[1].Id;
      f.u.d.state.containers[1].Id = "a".repeat(64);
      await assert.rejects(s.guard(o.inspectCandidate));
      f.u.d.state.containers[1].Id = acceptedApiId;
      await s.guard(o.inspectCandidate);
      replaceForwardService(f, "edge");
      await s.guard(o.inspectCandidate);
      await s.complete("edge-started");
      await s.enter("healthy");
      await s.guard(o.inspectCandidate);
      await s.complete("healthy");
      f.u.d.state.containers[2] = oldEdge;
      await assert.rejects(s.guard(o.inspectCandidate));
    },
    f.options,
  );
});

test("read-only physical verifier protects ownership handoff before any new state", async (t) => {
  const f = await forwardObservationFixture(t);
  f.options.verifyBaseline = createForwardBaselineVerifier(f, f.dependencies);
  f.admin.prepared = 1;
  const index = await readFile(join(f.root, "upgrade-index.json"));
  let called = false;
  await assert.rejects(
    open(f, () => {
      called = true;
    }),
  );
  assert.equal(called, false);
  assert.deepEqual(await readFile(join(f.root, "upgrade-index.json")), index);
});
test("physical verifier and capability observer share strict read-only source checks without recursion", async (t) => {
  const f = await forwardObservationFixture(t),
    o = observer(f);
  f.options.verifyBaseline = createForwardBaselineVerifier(f, f.dependencies);
  await open(f, async (s) => {
    assert.deepEqual((await s.guard(o.inspectSource)).containers, f.retainedIds);
  });
  assert.equal(
    f.u.commands.some((args) => ["start", "stop", "create", "run", "rm"].includes(args[0])),
    false,
  );
});
test("terminal cleanup observes stopped retained apps when failure preceded API replacement", async (t) => {
  const f = await forwardObservationFixture(t),
    o = observer(f),
    proof = forwardPrepared(f);
  await open(f, async (s) => {
    await s.complete("admitted", await s.guard(o.inspectSource));
    await s.enter("source-held");
    await s.complete("source-held");
    await s.enter("backup-verified");
    await s.complete("backup-verified", proof.backup, proof.preparation);
  });
  const prior = JSON.parse(
    await readFile(
      join(f.root, "forward-recovery-operations", f.input.identity.operationId, "state.json"),
    ),
  );
  await withForwardActivationState(
    f.root,
    forwardDecision(f, prior),
    async (s) => {
      await s.complete("activation-admitted");
      await s.enter("api-started");
      await s.fail();
      assert.deepEqual((await s.cleanup(o.inspectCandidate)).containers, f.retainedIds);
    },
    f.options,
  );
});

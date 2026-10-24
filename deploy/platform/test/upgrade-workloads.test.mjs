import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createUpgradeWorkloadCommands } from "../host/upgrade-workloads.mjs";
import { withUpgradeState, withUpgradePhaseState } from "../host/upgrade-state.mjs";
import { upgradeObservationFixture } from "./upgrade-observation-fixture.mjs";
import { upgradeOldRuntime, upgradePreparation, upgradeHash } from "./upgrade-fixture.mjs";
async function fixture(t, options = {}) {
  const f = await upgradeObservationFixture(t);
  f.d.state.containers[0].State.Health = { Status: "healthy" };
  const mutations = [];
  let uncertain = false;
  const dependencies = {
    ...f.dependencies,
    verifySources: async () => {},
    ...options,
    runProcess: async (request) => {
      const a = request.args.slice(2);
      if (a[0] === "container" && ["stop", "start"].includes(a[1])) {
        mutations.push(a);
        const c = f.d.state.containers.find((c) => c.Id === a.at(-1));
        assert.ok(c);
        c.State = {
          Running: a[1] === "start",
          Restarting: false,
          Paused: false,
          Status: a[1] === "start" ? "running" : "exited",
          Health: { Status: "healthy" },
        };
        if (uncertain) throw Object.assign(new Error("unreaped"), { terminationConfirmed: false });
        return { stdout: "" };
      }
      return f.dependencies.runProcess(request);
    },
  };
  const commands = createUpgradeWorkloadCommands(f, dependencies);
  const old = upgradeOldRuntime(f.input);
  old.containers = f.predecessorContainers;
  return {
    ...f,
    commands,
    mutations,
    old,
    setUncertain: () => {
      uncertain = true;
    },
  };
}
async function prepare(f) {
  const proof = upgradePreparation(f.input, f.old);
  await withUpgradeState(
    f.root,
    f.input,
    async (s) => {
      await s.complete("admitted", f.old);
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
  return {
    version: 1,
    kind: "platform-upgrade-phase",
    phase: "return-old",
    identity: f.input.identity,
    prior: { sequence: 6, sha256: upgradeHash(b) },
    executorCi: f.input.executorCi,
    reviewedPlanSha256: f.input.reviewedPlanSha256,
    dispatch: { ...f.input.dispatch, runId: "987654333" },
    expiresAt: f.input.expiresAt,
  };
}
test("preparation stops only exact old edge then API; early start and forged capability cannot mutate", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.commands.stopOldEdge({}));
  await withUpgradeState(
    f.root,
    f.input,
    async (s) => {
      await assert.rejects(s.guard(f.commands.stopOldEdge));
      await s.complete("admitted", f.old);
      await s.enter("old-stopped");
      await assert.rejects(s.guard(f.commands.startOldApi));
      await s.guard(f.commands.stopOldEdge);
      await s.guard(f.commands.stopOldApi);
    },
    { now: () => f.now },
  );
  assert.deepEqual(f.mutations, [
    ["container", "stop", "--time", "10", f.predecessorContainers.edge],
    ["container", "stop", "--time", "10", f.predecessorContainers.api],
  ]);
});
test("return starts retained IDs only in phase order; cleanup stops only IDs this invocation started", async (t) => {
  const f = await fixture(t),
    decision = await prepare(f);
  await withUpgradePhaseState(
    f.root,
    decision,
    async (s) => {
      await assert.rejects(s.guard(f.commands.startOldApi));
      await s.complete("return-admitted");
      await s.enter("old-api-started");
      await assert.rejects(s.guard(f.commands.startOldEdge));
      await s.guard(f.commands.startOldApi);
      await s.complete("old-api-started");
      await s.enter("old-edge-started");
      await s.guard(f.commands.startOldEdge);
      await s.complete("old-edge-started");
      await s.enter("returned-old");
      await s.guard(f.commands.verifyOldHealth);
      await s.fail();
      await s.cleanup(f.commands.cleanupOwnedStarts);
    },
    { now: () => f.now },
  );
  assert.deepEqual(
    f.mutations.map((a) => [a[1], a.at(-1)]),
    [
      ["start", f.predecessorContainers.api],
      ["start", f.predecessorContainers.edge],
      ["stop", f.predecessorContainers.edge],
      ["stop", f.predecessorContainers.api],
    ],
  );
});
for (const name of ["recreated", "foreign mount", "changed config", "migration latch"])
  test(`exact old mutation denies ${name}`, async (t) => {
    const f = await fixture(t),
      decision = await prepare(f);
    if (name === "migration latch") decision.phase = "activate";
    await withUpgradePhaseState(
      f.root,
      decision,
      async (s) => {
        await s.complete(name === "migration latch" ? "activation-admitted" : "return-admitted");
        await s.enter(name === "migration latch" ? "migration-entered" : "old-api-started");
        if (name === "recreated") f.d.state.containers[1].Id = "7".repeat(64);
        if (name === "foreign mount") f.d.state.containers[1].Mounts[0].Source += ".other";
        if (name === "changed config") f.d.state.containers[1].Config.Env.push("EXTRA=value");
        await assert.rejects(s.guard(f.commands.startOldApi));
      },
      { now: () => f.now },
    );
    assert.deepEqual(f.mutations, []);
  });
test("unconfirmed exact-ID start retains target lock and cannot trigger cleanup", async (t) => {
  const f = await fixture(t),
    decision = await prepare(f);
  f.setUncertain();
  await assert.rejects(
    withUpgradePhaseState(
      f.root,
      decision,
      async (s) => {
        await s.complete("return-admitted");
        await s.enter("old-api-started");
        await s.guard(f.commands.startOldApi);
      },
      { now: () => f.now },
    ),
  );
  assert.ok(await readFile(join(f.root, ".deploy.lock")));
  assert.equal(f.mutations.length, 1);
});

for (const health of ["starting", "unhealthy"])
  test(`old return readiness ${health} does not accept premature health`, async (t) => {
    let polls = 0,
      f;
    f = await fixture(t, {
      wait: async () => {
        polls++;
        const api = f.d.state.containers.find((c) => c.Id === f.predecessorContainers.api);
        api.State.Health.Status = "healthy";
      },
    });
    const decision = await prepare(f);
    await withUpgradePhaseState(
      f.root,
      decision,
      async (s) => {
        await s.complete("return-admitted");
        await s.enter("old-api-started");
        await s.guard(f.commands.startOldApi);
        await s.complete("old-api-started");
        await s.enter("old-edge-started");
        await s.guard(f.commands.startOldEdge);
        await s.complete("old-edge-started");
        await s.enter("returned-old");
        f.d.state.containers.find((c) => c.Id === f.predecessorContainers.api).State.Health.Status =
          health;
        if (health === "unhealthy") await assert.rejects(s.guard(f.commands.verifyOldHealth));
        else await s.guard(f.commands.verifyOldHealth);
      },
      { now: () => f.now },
    );
    assert.equal(polls, health === "starting" ? 1 : 0);
    assert.equal(f.mutations.length, 2);
  });

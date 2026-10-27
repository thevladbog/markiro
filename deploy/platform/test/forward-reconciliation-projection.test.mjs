import assert from "node:assert/strict";
import test from "node:test";
import {
  projectActivationReconciliationContainer,
  assertSameExitedActivationProbe,
} from "../forward-ci-expired-activation.mjs";
const inspect = () => ({
  Id: "a".repeat(64),
  Image: `sha256:${"b".repeat(64)}`,
  Name: "/synthetic-owned-probe",
  Config: { Image: "synthetic@sha256:test", Cmd: ["/probe/worker.mjs"] },
  HostConfig: { ReadonlyRootfs: true },
  Mounts: [{ Source: "/private/synthetic", Destination: "/input/data", RW: false }],
  State: {
    Running: false,
    Paused: false,
    Restarting: false,
    Status: "exited",
    ExitCode: 0,
    Pid: 0,
    StartedAt: "2026-10-27T08:00:00Z",
    FinishedAt: "2026-10-27T08:00:01Z",
    Health: {
      Status: "healthy",
      FailingStreak: 0,
      Log: [{ Start: "first", Output: "synthetic health output" }],
    },
  },
});
test("reconciliation records stable health status while actual health log advances", () => {
  const before = inspect(),
    after = inspect();
  after.State.Health.Log[0].Start = "next";
  after.State.Health.Log[0].Output = "another synthetic health result";
  assert.deepEqual(
    projectActivationReconciliationContainer(before),
    projectActivationReconciliationContainer(after),
  );
  after.State.Health.Status = "unhealthy";
  assert.notDeepEqual(
    projectActivationReconciliationContainer(before),
    projectActivationReconciliationContainer(after),
  );
  assert.equal(before.State.Health.Log[0].Start, "first");
});
test("exited probe identity and recipe survive volatile health telemetry", () => {
  const before = inspect(),
    after = inspect();
  after.State.Health.Status = "unhealthy";
  after.State.Health.Log[0].Start = "next";
  assertSameExitedActivationProbe(before, after);
  assert.equal(before.State.Health.Status, "healthy");
  assert.equal(after.State.Health.Status, "unhealthy");
});
for (const change of ["id", "image", "mount", "running", "pid", "exit", "finished"])
  test(`probe comparison still rejects changed ${change}`, () => {
    const before = inspect(),
      after = inspect();
    if (change === "id") after.Id = "c".repeat(64);
    if (change === "image") after.Image = `sha256:${"d".repeat(64)}`;
    if (change === "mount") after.Mounts[0].RW = true;
    if (change === "running") after.State.Running = true;
    if (change === "pid") after.State.Pid = 42;
    if (change === "exit") after.State.ExitCode = 1;
    if (change === "finished") after.State.FinishedAt = "2026-10-27T08:00:02Z";
    assert.throws(() => assertSameExitedActivationProbe(before, after));
  });

test("seed diagnostics admit only compiled public substeps", async () => {
  const { forwardActivationSeedStages } = await import("../forward-ci-expired-activation.mjs");
  const { forwardRehearsalFailure } = await import("../forward-ci.mjs");
  for (const phase of Object.values(forwardActivationSeedStages))
    assert.equal(forwardRehearsalFailure({ phase }).phase, phase);
  assert.equal(
    forwardRehearsalFailure({ phase: "seed activation: /private/secret" }).phase,
    "isolated forward rehearsal",
  );
});

for (const change of ["running", "pid", "exit"])
  test(`identical invalid probes are rejected for ${change}`, () => {
    const value = inspect();
    if (change === "running") value.State.Running = true;
    if (change === "pid") value.State.Pid = 42;
    if (change === "exit") value.State.ExitCode = 1;
    assert.throws(() => assertSameExitedActivationProbe(value, value));
  });
test("inspection projections refuse getters without executing them", () => {
  let executed = false;
  const value = inspect();
  Object.defineProperty(value, "State", {
    enumerable: true,
    get() {
      executed = true;
      return {};
    },
  });
  assert.throws(() => projectActivationReconciliationContainer(value));
  assert.throws(() => assertSameExitedActivationProbe(inspect(), value));
  assert.equal(executed, false);
});

test("probe failure identifies a compiled field group without exposing values", async () => {
  const { forwardActivationSeedStages } = await import("../forward-ci-expired-activation.mjs");
  for (const [field, stage] of [
    ["NetworkSettings", "probeNetwork"],
    ["Config", "probeConfig"],
    ["Mounts", "probeMounts"],
    ["PrivateUnclassifiedKey", "probeOther"],
  ]) {
    const before = inspect(),
      after = inspect(),
      seen = [];
    before[field] = { synthetic: "first" };
    after[field] = { synthetic: "PRIVATE-VALUE" };
    assert.throws(() =>
      assertSameExitedActivationProbe(before, after, (phase) => seen.push(phase)),
    );
    assert.ok(seen.length > 0);
    assert.equal(seen.at(-1), forwardActivationSeedStages[stage]);
    assert.equal(
      seen.some((v) => v.includes("PRIVATE")),
      false,
    );
  }
});

const mountSet = () =>
  ["/input/ca.crt", "/input/connections.json", "/probe/worker.mjs"].map((Destination, i) => ({
    Type: "bind",
    Source: `/private/synthetic/${i}`,
    Destination,
    RW: false,
    Mode: "ro",
    Propagation: "rprivate",
  }));
test("all Docker mount permutations preserve the exact destination-to-recipe mapping", () => {
  const before = inspect();
  before.Mounts = mountSet();
  for (const order of [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ]) {
    const after = inspect();
    after.Mounts = order.map((i) => before.Mounts[i]);
    assertSameExitedActivationProbe(before, after);
    assert.deepEqual(
      after.Mounts.map((m) => m.Destination),
      order.map((i) => before.Mounts[i].Destination),
    );
  }
});
for (const field of ["Type", "Source", "Destination", "RW", "Mode", "Propagation", "Extra"]) {
  test(`mount ordering normalization still rejects changed ${field}`, () => {
    const before = inspect(),
      after = inspect();
    before.Mounts = mountSet();
    after.Mounts = mountSet().reverse();
    after.Mounts[0][field] = field === "RW" ? true : "changed";
    assert.throws(() => assertSameExitedActivationProbe(before, after));
  });
}
test("identical duplicate mount destinations are rejected", () => {
  const value = inspect();
  value.Mounts = [...mountSet(), mountSet()[0]];
  assert.throws(() => assertSameExitedActivationProbe(value, value));
});

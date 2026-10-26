import assert from "node:assert/strict";
import { appendFile, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { executeForwardActivation } from "../host/forward-activation.mjs";
import { forwardActivationFixture } from "./forward-activation-fixture.mjs";
const run = (f) => executeForwardActivation(f.input, f.adapters, f.options);
test("forward activation reaches seq14 using only API-up, edge-up and smoke with unchanged migrated DB", async (t) => {
  const f = await forwardActivationFixture(t);
  assert.deepEqual(await run(f), f.input.decision.identity);
  assert.deepEqual(f.commands, ["api", "edge"]);
  assert.equal(f.trace.at(-1), "inspectCandidate");
  assert.ok(f.projectionChecks() >= 2);
  const state = JSON.parse(await readFile(f.journal));
  assert.equal(state.sequence, 14);
  assert.equal(state.phase, "healthy");
  assert.equal(state.status, "completed");
  assert.equal(state.migrationEntered, true);
  assert.equal(f.ids.postgres, f.old.postgres);
});
for (const kind of [
  "migration",
  "schema",
  "pg",
  "config",
  "inspectCandidate",
  "copies",
  "key",
  "fence",
  "projection",
  "approval",
  "verifyRelease",
  "verifyImages",
])
  test(`forward activation rejects ${kind} before candidate start`, async (t) => {
    const f = await forwardActivationFixture(t, kind);
    if (kind === "migration") f.ledger.rows[0].hash = "f".repeat(64);
    if (kind === "schema") f.ledger.schema.schemaSha256 = "f".repeat(64);
    if (kind === "pg") f.ids.postgres = "f".repeat(64);
    if (kind === "config")
      await appendFile(f.input.configuration.runtimeSnapshot.path, "#changed\n");
    if (kind === "copies")
      f.input.preparedTarget.observations.offHostRecovery.value.independentKeyAvailable = false;
    if (kind === "key")
      f.input.preparedTarget.observations.keyContinuity.value.signingContinuityVerified = false;
    if (kind === "fence") {
      const original = f.adapters.writerFence.observe;
      f.adapters.writerFence.observe = async (...args) => ({
        ...(await original(...args)),
        held: false,
      });
    }
    if (kind === "approval") f.input.preparedTarget.observations.egress.value.approved = false;
    await assert.rejects(run(f));
    assert.deepEqual(f.commands, []);
    assert.doesNotMatch(
      await readFile(join(f.directory, "failure.json"), "utf8"),
      /PRIVATE-|projection changed/u,
    );
  });
for (const where of ["api", "edge", "smoke"])
  test(`known failure after ${where} replacement cleans only exact new candidates`, async (t) => {
    const f = await forwardActivationFixture(t, where);
    await assert.rejects(run(f));
    const state = JSON.parse(await readFile(f.journal));
    assert.equal(state.status, "recovery-required");
    assert.equal(state.migrationEntered, true);
    assert.ok(f.cleanupIds.length >= 1);
    assert.ok(f.cleanupIds.every((id) => !Object.values(f.old).includes(id)));
    assert.equal(f.ids.postgres, f.old.postgres);
  });
function clocked(t, f) {
  const clock = { now: Date.now() };
  t.mock.method(Date, "now", () => clock.now);
  for (const [object, method] of [
    [f.adapters.writerFence, "observe"],
    [f.adapters.workload, "inspect"],
  ]) {
    const original = object[method];
    object[method] = async (...args) => ({
      ...(await original(...args)),
      observedAt: new Date(clock.now).toISOString(),
    });
  }
  return clock;
}
test("slow fence receives a new real cleanup observation without extending freshness", async (t) => {
  const f = await forwardActivationFixture(t),
    clock = clocked(t, f),
    original = f.adapters.writerFence.observe;
  let delayed = false;
  f.adapters.writerFence.observe = async (...args) => {
    const result = await original(...args);
    if (!delayed) {
      clock.now += 31000;
      delayed = true;
    }
    return { ...result, observedAt: new Date(clock.now).toISOString() };
  };
  await run(f);
  assert.deepEqual(f.commands, ["api", "edge"]);
});
test("slow final cleanup cannot refresh an already stale fence", async (t) => {
  const f = await forwardActivationFixture(t),
    clock = clocked(t, f),
    original = f.adapters.workload.inspect;
  let inspections = 0;
  f.adapters.workload.inspect = async (...args) => {
    const result = await original(...args);
    if (++inspections === 2) clock.now += 31000;
    return { ...result, observedAt: new Date(clock.now).toISOString() };
  };
  await assert.rejects(run(f));
  assert.deepEqual(f.commands, []);
});
test("actual spawn recheck denies decision expiry after the final observation", async (t) => {
  const f = await forwardActivationFixture(t),
    clock = clocked(t, f),
    original = f.adapters.runProcess;
  let attempted = false;
  f.adapters.runProcess = async (...args) => {
    attempted = true;
    clock.now = Date.parse(f.decision.expiresAt);
    return original(...args);
  };
  await assert.rejects(run(f));
  assert.equal(attempted, true);
  assert.deepEqual(f.commands, []);
});
test("unknown child termination retains lock and never competes with cleanup", async (t) => {
  const f = await forwardActivationFixture(t);
  f.adapters.runProcess = async () => {
    throw Object.assign(new Error("PRIVATE-UNREAPED"), { terminationConfirmed: false });
  };
  await assert.rejects(run(f), (e) => e.durabilityUncertain === true);
  assert.ok(await lstat(join(f.root, ".deploy.lock")));
  assert.equal(
    f.trace.some((n) => n.startsWith("cleanup")),
    false,
  );
});
for (const method of ["migrate", "startOldApi", "stopPostgres"])
  test(`activation refuses injected ${method} adapter`, async (t) => {
    const f = await forwardActivationFixture(t);
    f.adapters[method] = () => assert.fail("forbidden action");
    await assert.rejects(run(f));
    assert.deepEqual(f.commands, []);
  });

for (const diagnosticFails of [false, true])
  test(`coordinator supplies a sticky first diagnostic before nested cleanup (diagnosticFails=${diagnosticFails})`, async (t) => {
    const { noteHostProcessFailure } = await import("../host/failure-diagnostic.mjs");
    const f = await forwardActivationFixture(t);
    const path = join(f.directory, "failure.json");
    if (diagnosticFails)
      await (await import("node:fs/promises")).writeFile(path, "retained-first", { mode: 0o600 });
    let cleanup = false;
    f.adapters.verifyRoles = async (_context, _cap, persist) => {
      const first = noteHostProcessFailure(
        Object.assign(new Error("PRIVATE-FIRST"), { terminationConfirmed: true }),
        "/usr/bin/docker",
        42,
      );
      await persist(first);
      const bytes = await readFile(path, "utf8");
      assert.equal(JSON.parse(bytes).exitStatus, 42);
      cleanup = true;
      throw noteHostProcessFailure(
        Object.assign(new Error("PRIVATE-SECOND"), { durabilityUncertain: true }),
        "/usr/bin/docker",
        43,
      );
    };
    await assert.rejects(run(f));
    assert.equal(cleanup, !diagnosticFails);
    const bytes = await readFile(path, "utf8");
    if (diagnosticFails) assert.equal(bytes, "retained-first");
    else {
      assert.equal(JSON.parse(bytes).exitStatus, 42);
      assert.doesNotMatch(bytes, /PRIVATE-FIRST|PRIVATE-SECOND/u);
    }
    assert.ok(await lstat(join(f.root, ".deploy.lock")));
  });

for (const transport of ["serial", "batched"])
  test(`physical isolation ${transport} reads preserve the strict fence deadline`, async (t) => {
    const f = await forwardActivationFixture(t),
      clock = clocked(t, f);
    const { rehearsalFixture } = await import("./rehearsal-fixture.mjs");
    const { captureRehearsalResources, validateRehearsalDaemon } =
      await import("../upgrade-ci-guards.mjs");
    const actual = rehearsalFixture(),
      expected = captureRehearsalResources(actual);
    // Match the real rehearsal policy; only fence/workload retain the strict30s limit.
    f.input.preparedPolicy.maxAgeMs = 3600000;
    const samples = [];
    for (const [name, object, method] of [
      ["fence", f.adapters.writerFence, "observe"],
      ["cleanup", f.adapters.workload, "inspect"],
    ]) {
      const original = object[method];
      object[method] = async (...args) => {
        const value = await original(...args);
        samples.push({ name, at: Date.parse(value.observedAt) });
        return value;
      };
    }
    const read = async (value) => {
      const began = clock.now;
      await Promise.resolve();
      clock.now = Math.max(clock.now, began + 4000);
      return value;
    };
    f.options.verifyBaseline = async () => {
      const readers = {
        container: () => read(actual.container),
        volume: () => read(actual.volume),
        ipv4: () => read(actual.routes.ipv4),
        ipv6: () => read(actual.routes.ipv6),
      };
      if (transport === "serial") {
        const container = await readers.container(),
          volume = await readers.volume();
        const routes = { ipv4: await readers.ipv4(), ipv6: await readers.ipv6() };
        validateRehearsalDaemon(
          { invocationId: actual.invocationId, container, volume, routes },
          expected,
        );
      } else {
        const { verifyRehearsalIsolation } = await import("../upgrade-ci.mjs");
        await verifyRehearsalIsolation(actual.invocationId, readers, expected);
      }
    };
    if (transport === "serial") {
      await assert.rejects(run(f));
      assert.deepEqual(f.commands, []);
      const failure = JSON.parse(await readFile(join(f.directory, "failure.json")));
      assert.equal(failure.phase, "activation-admitted");
      assert.equal(failure.boundary, "entry");
      assert.equal(failure.code, "ERR_DATABASE_BACKUP");
      assert.deepEqual(
        samples.map(({ name }) => name),
        ["cleanup", "fence", "cleanup"],
      );
      assert.ok(samples[2].at - samples[1].at > 30000);
    } else {
      await run(f);
      assert.deepEqual(f.commands, ["api", "edge"]);
    }
  });

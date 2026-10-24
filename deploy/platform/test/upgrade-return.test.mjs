import assert from "node:assert/strict";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { phaseFixture } from "./upgrade-phase-fixture.mjs";
import { withHeldUpgradeState, withUpgradePhaseState } from "../host/upgrade-state.mjs";
import { executeUpgradeReturn } from "../host/upgrade-return.mjs";
async function fixture(t, failed) {
  const f = await phaseFixture(t, failed);
  const decision = await f.phaseInput("return-old");
  const trace = [];
  const state = async () => JSON.parse(await readFile(f.journal));
  const old = (await state()).oldRuntime;
  const methods = [
    "verifyAdmission",
    "inspectReturnEligibility",
    "inspectSchema",
    "startOldApi",
    "startOldEdge",
    "verifyOldHealth",
    "smoke",
    "cleanupOwnedStarts",
  ];
  const adapters = Object.fromEntries(
    methods.map((name) => [
      name,
      async (context, cap) =>
        withHeldUpgradeState(cap, async (held) => {
          trace.push(name);
          assert.deepEqual(context.oldRuntime, old);
          assert.equal(held.state.decision.phase, "return-old");
          if (name === "verifyAdmission") return held.state.admission.identity;
          if (name === "inspectSchema") return old.schema;
          if (name === "inspectReturnEligibility")
            return {
              version: 1,
              kind: "platform-upgrade-observation",
              operationId: f.input.identity.operationId,
              configurationSha256: f.input.oldConfigurationSha256,
              target: f.input.identity.target,
              phase: held.state.phase,
              containers: old.containers,
            };
          if (name === "startOldApi" || name === "startOldEdge")
            assert.equal(
              held.state.phase,
              name === "startOldApi" ? "old-api-started" : "old-edge-started",
            );
          if (name === "cleanupOwnedStarts") assert.equal(held.state.status, "recovery-required");
        }),
    ]),
  );
  return { ...f, decision, trace, state, old, adapters, context: { root: f.root, decision } };
}
const run = (f) => executeUpgradeReturn(f.context, f.adapters, { now: () => f.phaseNow });
test("return starts only retained old API then edge, schema rechecked, health and TLS before terminal", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await run(f), f.old);
  assert.deepEqual(
    f.trace.filter((n) => n.startsWith("start")),
    ["startOldApi", "startOldEdge"],
  );
  assert.ok(f.trace.includes("verifyOldHealth") && f.trace.includes("smoke"));
  const s = await f.state();
  assert.equal(s.phase, "returned-old");
  assert.equal(s.status, "completed");
  assert.equal(s.migrationEntered, false);
  const count = f.trace.length;
  await assert.rejects(run(f));
  assert.equal(f.trace.length, count);
});
for (const failed of ["admitted", "old-stopped", "backup-verified"])
  test(`known preparation failure at ${failed} can return with fresh permission`, async (t) => {
    const f = await fixture(t, failed);
    await run(f);
  });
for (const mutation of [
  "schema",
  "migration",
  "system",
  "container",
  "config",
  "target",
  "expiry",
  "missing adapter",
])
  test(`return denies ${mutation} without starting containers`, async (t) => {
    const f = await fixture(t);
    if (["schema", "migration", "system"].includes(mutation)) {
      const original = f.adapters.inspectSchema;
      f.adapters.inspectSchema = async (...args) => ({
        ...(await original(...args)),
        [mutation === "schema"
          ? "schemaSha256"
          : mutation === "migration"
            ? "migrationSha256"
            : "systemId"]: "c".repeat(64),
      });
    }
    if (["container", "config", "target"].includes(mutation)) {
      const original = f.adapters.inspectReturnEligibility;
      f.adapters.inspectReturnEligibility = async (...args) => {
        const v = await original(...args);
        if (mutation === "container") v.containers = { ...v.containers, api: "7".repeat(64) };
        if (mutation === "config") v.configurationSha256 = "f".repeat(64);
        if (mutation === "target") v.target = { ...v.target, databaseId: "123" };
        return v;
      };
    }
    if (mutation === "expiry") {
      const original = f.adapters.inspectSchema;
      f.adapters.inspectSchema = async (...args) => {
        const v = await original(...args);
        f.phaseNow = Date.parse(f.decision.expiresAt);
        return v;
      };
    }
    if (mutation === "missing adapter") delete f.adapters.verifyOldHealth;
    await assert.rejects(run(f));
    assert.equal(
      f.trace.some((n) => n.startsWith("start")),
      false,
    );
  });
for (const failed of ["startOldApi", "startOldEdge", "verifyOldHealth", "smoke"])
  test(`return ${failed} failure publishes terminal intent before owned cleanup`, async (t) => {
    const f = await fixture(t);
    f.adapters[failed] = async () => {
      f.trace.push(failed);
      throw Error("private-value");
    };
    await assert.rejects(run(f), (e) => {
      assert.doesNotMatch(e.stack, /private-value/);
      return true;
    });
    assert.equal((await f.state()).status, "recovery-required");
    assert.equal(f.trace.at(-1), "cleanupOwnedStarts");
  });
test("unconfirmed return producer retains lock and never starts competing cleanup", async (t) => {
  const f = await fixture(t);
  f.adapters.startOldApi = async () => {
    throw Object.assign(Error("unreaped"), { terminationConfirmed: false });
  };
  await assert.rejects(run(f));
  assert.ok(await lstat(join(f.root, ".deploy.lock")));
  assert.equal(f.trace.includes("cleanupOwnedStarts"), false);
});
test("a durable migration latch rejects return even before migrator starts", async (t) => {
  const f = await fixture(t);
  const a = await f.phaseInput("activate");
  await assert.rejects(
    withUpgradePhaseState(
      f.root,
      a,
      async (s) => {
        await s.complete("activation-admitted");
        await s.enter("migration-entered");
        throw Error("spawn failure");
      },
      { now: () => f.phaseNow },
    ),
  );
  f.context.decision = await f.phaseInput("return-old");
  await assert.rejects(run(f));
  assert.deepEqual(f.trace, []);
});

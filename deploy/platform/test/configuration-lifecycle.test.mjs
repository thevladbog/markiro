import test from "node:test";
import assert from "node:assert/strict";
import { runConfigurationLifecycle } from "../host/configuration-lifecycle.mjs";

const secret = "private-provider-credential";
function failure(flags = {}) {
  return Object.assign(new Error(`${secret}: child output`), {
    code: secret,
    cause: { token: secret },
    stdout: secret,
    ...flags,
  });
}

// Only external host operations are replaced: this target keeps the running API,
// unchanged database/catalog identities, pending journal and accepted receipts.
function fixture(failures = {}) {
  const calls = [];
  const before = { id: "api-before", environment: "old", running: true };
  const target = {
    api: before,
    schema: "schema-accepted",
    catalog: "catalog-accepted",
    workers: ["catalog-read-stopped", "catalog-write-stopped"],
  };
  const journal = { pending: false, checkpoints: [], receipts: [] };
  let afterCount = 0;
  const step = (name) => {
    calls.push(name);
    if (failures[name]) throw failures[name];
  };
  const invariant = () => {
    assert.equal(target.schema, "schema-accepted");
    assert.equal(target.catalog, "catalog-accepted");
    assert.deepEqual(target.workers, ["catalog-read-stopped", "catalog-write-stopped"]);
  };
  const adapters = {
    async verifyBefore() {
      step("verify-before");
      assert.equal(target.api, before);
      invariant();
    },
    async checkpoint(stage, current) {
      step(stage);
      if (["api-replaced", "verified", "returned-old"].includes(stage)) {
        assert.equal(current.id, target.api.id);
      } else assert.equal(current, undefined);
      journal.pending = true;
      journal.checkpoints.push({ stage, current });
    },
    async apply() {
      step("apply");
      assert.equal(journal.checkpoints.at(-1).stage, "applying");
      step("before-stop");
      target.api = null;
      step("after-stop");
      target.api = { id: "api-candidate", environment: "dadata", running: false };
      step("after-create");
      target.api.running = true;
      step("after-start");
    },
    async inspectCandidate() {
      step("inspect-candidate");
      assert.equal(target.api.id, "api-candidate");
      return { id: target.api.id };
    },
    async verifyAfter() {
      step(++afterCount === 1 ? "verify-after" : "verify-restored");
      assert.equal(target.api.running, true);
      invariant();
    },
    async suggestions() {
      step("suggestions");
      assert.equal(target.api.environment, "dadata");
    },
    async accept(outcome, current) {
      step(`accept-${outcome}`);
      assert.equal(current.id, target.api.id);
      const receipt = { outcome, apiContainerId: current.id };
      journal.receipts.push(receipt);
      // A receipt/index write can succeed while the process loses confirmation.
      step(`after-accept-${outcome}`);
      journal.pending = false;
      return receipt;
    },
    async restoreBefore() {
      step("restore-before");
      assert.equal(journal.checkpoints.at(-1).stage, "returning-old");
      assert.ok(target.api === null || ["api-before", "api-candidate"].includes(target.api.id));
      target.api = { id: "api-restored", environment: "old", running: true };
    },
    async inspectRestored() {
      step("inspect-restored");
      return { id: target.api.id };
    },
  };
  return { adapters, calls, target, journal, invariant };
}

async function rejection(f) {
  let caught;
  await assert.rejects(runConfigurationLifecycle(f.adapters), (error) => {
    caught = error;
    return true;
  });
  assert.equal(caught.code, "CONFIGURATION_LIFECYCLE_FAILED");
  assert.ok(!JSON.stringify(caught).includes(secret));
  assert.ok(!String(caught).includes(secret));
  assert.ok(!caught.stack.includes(secret));
  assert.equal(caught.cause, undefined);
  assert.equal(caught.stdout, undefined);
  return caught;
}

test("accepts the exact new API only after durable checkpoints, health and suggestions", async () => {
  const f = fixture();
  assert.deepEqual(await runConfigurationLifecycle(f.adapters), {
    outcome: "healthy",
    apiContainerId: "api-candidate",
  });
  assert.deepEqual(f.calls, [
    "verify-before",
    "admitted",
    "applying",
    "apply",
    "before-stop",
    "after-stop",
    "after-create",
    "after-start",
    "inspect-candidate",
    "api-replaced",
    "verify-after",
    "suggestions",
    "verified",
    "accept-healthy",
    "after-accept-healthy",
  ]);
  assert.equal(f.journal.pending, false);
  assert.equal(f.journal.receipts.length, 1);
  f.invariant();
});

for (const stage of ["verify-before", "admitted", "applying"]) {
  test(`denial at ${stage} cannot apply or restore any API`, async () => {
    const f = fixture({ [stage]: failure() });
    const error = await rejection(f);
    assert.equal(error.stage, stage);
    assert.equal(error.restored, undefined);
    assert.equal(f.target.api.id, "api-before");
    assert.ok(!f.calls.includes("apply"));
    assert.ok(!f.calls.includes("restore-before"));
    assert.equal(f.journal.receipts.length, 0);
  });
}

for (const stage of [
  "apply",
  "before-stop",
  "after-stop",
  "after-create",
  "after-start",
  "inspect-candidate",
  "api-replaced",
  "verify-after",
  "suggestions",
  "verified",
  "accept-healthy",
]) {
  test(`known failure at ${stage} returns old configuration with a fresh accepted API identity`, async () => {
    const f = fixture({ [stage]: failure({ terminationConfirmed: true }) });
    const error = await rejection(f);
    assert.equal(error.restored, true);
    assert.equal(error.terminationConfirmed, true);
    assert.equal(error.recoveryRequired, undefined);
    assert.deepEqual(f.target.api, { id: "api-restored", environment: "old", running: true });
    assert.deepEqual(f.journal.receipts, [
      { outcome: "returned-old", apiContainerId: "api-restored" },
    ]);
    assert.equal(f.journal.pending, false);
    assert.equal(f.calls.filter((call) => call === "restore-before").length, 1);
    assert.equal(f.calls.filter((call) => call === "apply").length, 1);
    assert.equal(
      f.calls.filter((call) => call === "suggestions").length,
      stage === "suggestions" || ["verified", "accept-healthy"].includes(stage) ? 1 : 0,
    );
    f.invariant();
  });
}

for (const stage of [
  "verify-before",
  "admitted",
  "applying",
  "apply",
  "after-stop",
  "after-create",
  "after-start",
  "inspect-candidate",
  "api-replaced",
  "verify-after",
  "suggestions",
  "verified",
  "accept-healthy",
]) {
  for (const flags of [{ terminationConfirmed: false }, { durabilityUncertain: true }]) {
    test(`uncertainty at ${stage} (${Object.keys(flags)[0]}) prevents any restore or acceptance`, async () => {
      const f = fixture({ [stage]: failure(flags) });
      const error = await rejection(f);
      assert.equal(error.recoveryRequired, true);
      for (const [key, value] of Object.entries(flags)) assert.equal(error[key], value);
      assert.ok(!f.calls.includes("restore-before"));
      assert.equal(f.journal.receipts.length, 0);
      if (!["verify-before", "admitted"].includes(stage)) assert.equal(f.journal.pending, true);
      f.invariant();
    });
  }
}

test("lost confirmation after healthy receipt never rolls back an accepted target", async () => {
  const f = fixture({ "after-accept-healthy": failure({ durabilityUncertain: true }) });
  const error = await rejection(f);
  assert.equal(error.stage, "accept-healthy");
  assert.equal(error.durabilityUncertain, true);
  assert.equal(error.recoveryRequired, true);
  assert.equal(f.target.api.id, "api-candidate");
  assert.deepEqual(f.journal.receipts, [{ outcome: "healthy", apiContainerId: "api-candidate" }]);
  assert.equal(f.journal.pending, true);
  assert.ok(!f.calls.includes("restore-before"));
});

for (const stage of [
  "returning-old",
  "restore-before",
  "inspect-restored",
  "verify-restored",
  "returned-old",
  "accept-returned-old",
  "after-accept-returned-old",
]) {
  for (const flags of [
    { terminationConfirmed: true },
    { terminationConfirmed: false },
    { durabilityUncertain: true },
  ]) {
    test(`recovery failure at ${stage} (${Object.entries(flags)[0].join("=")}) retains pending state without repeating mutation`, async () => {
      const f = fixture({
        suggestions: failure({ terminationConfirmed: true }),
        [stage]: failure(flags),
      });
      const error = await rejection(f);
      assert.equal(
        error.stage,
        stage === "after-accept-returned-old" ? "accept-returned-old" : stage,
      );
      assert.equal(error.recoveryRequired, true);
      assert.equal(error.restored, undefined);
      for (const [key, value] of Object.entries(flags)) assert.equal(error[key], value);
      assert.equal(f.journal.pending, true);
      assert.equal(f.calls.filter((call) => call === "apply").length, 1);
      assert.equal(
        f.calls.filter((call) => call === "restore-before").length,
        stage === "returning-old" ? 0 : 1,
      );
      assert.equal(f.calls.filter((call) => call === "suggestions").length, 1);
      f.invariant();
    });
  }
}

test("a returned unknown apply outcome prevents inspection and restore", async () => {
  const f = fixture();
  f.adapters.apply = async () => {
    f.calls.push("apply");
    f.target.api = null;
    return { terminationConfirmed: false, output: secret };
  };
  const error = await rejection(f);
  assert.equal(error.stage, "apply");
  assert.equal(error.terminationConfirmed, false);
  assert.equal(error.recoveryRequired, true);
  assert.equal(f.journal.pending, true);
  assert.ok(!f.calls.includes("inspect-candidate"));
  assert.ok(!f.calls.includes("restore-before"));
});

test("a returned unknown restore outcome prevents inspection and acceptance", async () => {
  const f = fixture({ suggestions: failure() });
  f.adapters.restoreBefore = async () => {
    f.calls.push("restore-before");
    return { terminationConfirmed: false, output: secret };
  };
  const error = await rejection(f);
  assert.equal(error.stage, "restore-before");
  assert.equal(error.terminationConfirmed, false);
  assert.equal(error.recoveryRequired, true);
  assert.equal(f.journal.pending, true);
  assert.ok(!f.calls.includes("inspect-restored"));
  assert.equal(f.journal.receipts.length, 0);
});

for (const method of [
  "verifyBefore",
  "checkpoint",
  "apply",
  "inspectCandidate",
  "verifyAfter",
  "suggestions",
  "accept",
  "restoreBefore",
  "inspectRestored",
]) {
  test(`missing fixed ${method} adapter is rejected before observing or mutating the target`, async () => {
    const f = fixture();
    delete f.adapters[method];
    const error = await rejection(f);
    assert.equal(error.stage, "adapters");
    assert.deepEqual(f.calls, []);
    assert.equal(f.target.api.id, "api-before");
  });
}

for (const [method, stage] of [
  ["inspectCandidate", "inspect-candidate"],
  ["verifyAfter", "verify-after"],
  ["suggestions", "suggestions"],
]) {
  test(`an explicitly uncertain ${method} result retains the candidate without restoring`, async () => {
    const f = fixture();
    f.adapters[method] = async () => ({ durabilityUncertain: true, diagnostic: secret });
    const error = await rejection(f);
    assert.equal(error.stage, stage);
    assert.equal(error.durabilityUncertain, true);
    assert.equal(error.recoveryRequired, true);
    assert.equal(f.target.api.id, "api-candidate");
    assert.equal(f.journal.pending, true);
    assert.ok(!f.calls.includes("restore-before"));
  });
}

test("sanitization retains boolean flags and ignores untrusted diagnostic fields and flag values", async () => {
  const f = fixture({
    "verify-before": failure({
      stage: secret,
      terminationConfirmed: secret,
      durabilityUncertain: { token: secret },
      restored: false,
      recoveryRequired: false,
    }),
  });
  const error = await rejection(f);
  assert.equal(error.stage, "verify-before");
  assert.equal(error.terminationConfirmed, undefined);
  assert.equal(error.durabilityUncertain, undefined);
  assert.equal(error.restored, false);
  assert.equal(error.recoveryRequired, false);
});

test("recovery failure latches unsafe termination and durability outcomes", async () => {
  // The recovery failure must retain both unsafe outcomes together.
  const f = fixture({
    suggestions: failure({ terminationConfirmed: true, durabilityUncertain: false }),
    "restore-before": failure({ terminationConfirmed: false, durabilityUncertain: true }),
  });
  const error = await rejection(f);
  assert.equal(error.terminationConfirmed, false);
  assert.equal(error.durabilityUncertain, true);
  assert.equal(error.recoveryRequired, true);
  assert.equal(f.journal.pending, true);
});

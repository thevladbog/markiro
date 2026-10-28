import { createHostAdapters, loadHostOperation } from "../host/command.mjs";
import {
  commandIntegrationFixture,
  integrationOptions,
} from "./host-command-integration-fixture.mjs";
import { productionAuthorization } from "./production-activation-fixture.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { executeForwardActivation } from "../host/forward-activation.mjs";
import { forwardActivationFixture } from "./forward-activation-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { validateForwardAdmission, validateForwardDecision } from "../host/forward-admission.mjs";
import { validatePreparedTarget } from "../host/prepared-target.mjs";
import { forwardFixture, forwardPrepared, forwardDecision } from "./forward-fixture.mjs";
import { productionFixture } from "./production-activation-fixture.mjs";
import { upgradeBytes } from "./upgrade-fixture.mjs";

const authority = "protected-dispatch-once";
function dispatchBound(value) {
  value.version = 2;
  value.authority = authority;
  delete value.expiresAt;
  return value;
}
function preparedBound(f) {
  f.record.version = 3;
  const value = f.record.observations.egress.value;
  value.authority = authority;
  value.sourceHold.authority = authority;
  delete value.expiresAt;
  delete value.sourceHold.expiresAt;
  return f;
}
test("dispatch-bound forward admission remains valid after eight hours without minting another run", () => {
  const f = forwardFixture();
  dispatchBound(f.input);
  f.now += 8 * 3600000;
  assert.deepEqual(validateForwardAdmission(f.input, f), f.input);
  for (const mutate of [
    (v) => {
      v.authority = "unrestricted";
    },
    (v) => {
      v.expiresAt = "2099-01-01T00:00:00.000Z";
    },
    (v) => {
      v.dispatch.runAttempt = "2";
    },
    (v) => {
      v.dispatch.runId = f.records.state.decision.dispatch.runId;
    },
    (v) => {
      v.failed.hashes.state = "f".repeat(64);
    },
    (v) => {
      v.baseline.schema.systemId = "foreign-db";
    },
  ]) {
    const input = structuredClone(f.input);
    mutate(input);
    assert.throws(() => validateForwardAdmission(input, f));
  }
});
test("dispatch-bound activation accepts elapsed time but still binds the exact preparation and separate run", () => {
  const f = forwardFixture(),
    prior = forwardPrepared(f),
    decision = dispatchBound(forwardDecision(f, prior));
  const options = { prior, priorBytes: upgradeBytes(prior), now: f.now + 8 * 3600000 };
  assert.deepEqual(validateForwardDecision(decision, options), decision);
  for (const mutate of [
    (v) => {
      v.authority = "unrestricted";
    },
    (v) => {
      v.expiresAt = "2099-01-01T00:00:00.000Z";
    },
    (v) => {
      v.dispatch = structuredClone(f.input.dispatch);
    },
    (v) => {
      v.prior.sha256 = "f".repeat(64);
    },
    (v) => {
      v.identity.operationId = "33333333-3333-4333-8333-333333333333";
    },
  ]) {
    const value = structuredClone(decision);
    mutate(value);
    assert.throws(() => validateForwardDecision(value, options));
  }
});
test("nonexpiring prepared target retains immutable backup proofs and requires newly observed fence/workload", async (t) => {
  const f = preparedBound(await productionFixture(t));
  const clock = Date.now() + 2 * 3600000;
  t.mock.method(Date, "now", () => clock);
  for (const [owner, method] of [
    [f.expected.workload, "inspect"],
    [f.expected.writerFence, "observe"],
  ]) {
    const original = owner[method];
    owner[method] = async (...args) => ({
      ...(await original(...args)),
      observedAt: new Date(clock).toISOString(),
    });
  }
  const proof = await validatePreparedTarget(f.record, f.expected);
  assert.equal(typeof proof.recheckFreshness, "function");
  proof.recheckFreshness();
  f.setHeld(false);
  await assert.rejects(validatePreparedTarget(f.record, f.expected));
});
for (const issue of ["copies", "keys", "certificate", "source hold", "authority", "extra expiry"]) {
  test(`nonexpiring prepared target still refuses changed ${issue}`, async (t) => {
    const f = preparedBound(await productionFixture(t));
    const value = f.record.observations.egress.value;
    if (issue === "copies")
      f.record.observations.offHostRecovery.value.independentKeyAvailable = false;
    if (issue === "keys")
      f.record.observations.keyContinuity.value.signingContinuityVerified = false;
    if (issue === "certificate")
      f.record.observations.tls.value.expiresAt = new Date(Date.now() - 1).toISOString();
    if (issue === "source hold") value.sourceHold.held = false;
    if (issue === "authority") value.authority = "unrestricted";
    if (issue === "extra expiry") value.expiresAt = "2099-01-01T00:00:00.000Z";
    await assert.rejects(validatePreparedTarget(f.record, f.expected));
  });
}

test("single-use activation survives a two-hour pause between API and edge and cannot replay", async (t) => {
  const f = await forwardActivationFixture(t);
  dispatchBound(f.input.decision);
  preparedBound({ record: f.input.preparedTarget });
  const clock = { now: Date.now() };
  t.mock.method(Date, "now", () => clock.now);
  for (const [owner, method] of [
    [f.observers.workload, "inspect"],
    [f.observers.writerFence, "observe"],
  ]) {
    const original = owner[method];
    owner[method] = async (...args) => ({
      ...(await original(...args)),
      observedAt: new Date(clock.now).toISOString(),
    });
  }
  const original = f.adapters.runProcess;
  f.adapters.runProcess = async (...args) => {
    const result = await original(...args);
    if (args[0].args.at(-1) === "api") clock.now += 2 * 3600000;
    return result;
  };
  await executeForwardActivation(f.input, f.adapters, f.options);
  assert.deepEqual(f.commands, ["api", "edge"]);
  const bytes = await readFile(f.journal),
    state = JSON.parse(bytes);
  assert.equal(state.sequence, 14);
  assert.equal(state.phase, "healthy");
  assert.equal(state.status, "completed");
  assert.equal(f.ids.postgres, f.old.postgres);
  await assert.rejects(executeForwardActivation(f.input, f.adapters, f.options));
  assert.deepEqual(f.commands, ["api", "edge"]);
  assert.ok((await readFile(f.journal)).equals(bytes));
});
test("a dispatch-bound decision cannot silently opt a legacy prepared target out of its deadline", async (t) => {
  const f = await forwardActivationFixture(t);
  dispatchBound(f.input.decision);
  await assert.rejects(executeForwardActivation(f.input, f.adapters, f.options));
  assert.deepEqual(f.commands, []);
});

test("v3 still remeasures retained-job projection before API replacement", async (t) => {
  const f = await commandIntegrationFixture(t, null, { nested: true });
  const options = await integrationOptions(f.root);
  const loaded = await loadHostOperation(f.root, options);
  // The compiled forward runtime supplies this trusted adapter view. The
  // ordinary loader/engine separately reject v3 rather than minting authority.
  const op = loaded.record.deployment;
  op.preparedTarget.observations.egress.value = productionAuthorization(op.preparedTarget, f);
  preparedBound({ record: op.preparedTarget });
  const daemon = join(f.root, "daemon.json");
  const state = JSON.parse(await readFile(daemon));
  state.activationProjection = structuredClone(
    op.preparedTarget.observations.egress.value.review.projection,
  );
  await writeFile(daemon, JSON.stringify(state), { mode: 0o600 });
  const process = options.runProcess;
  let projectionReads = 0;
  options.runProcess = async (request) => {
    if (request.args.includes("--file")) projectionReads++;
    return process(request);
  };
  const adapters = await createHostAdapters(loaded, options);
  const context = {
    ...op,
    phase: "api-started",
    boundary: "command",
    allowedServices: ["postgres"],
    previousHealthy: null,
    migration: { name: "markiro-platform-migrate-" + op.identity.operationId },
  };
  await adapters.inspectTarget(context);
  assert.equal(projectionReads, 1);
  state.activationProjection[0].rows = 1;
  await writeFile(daemon, JSON.stringify(state), { mode: 0o600 });
  await assert.rejects(adapters.inspectTarget(context));
  assert.equal(projectionReads, 2);
});

test("ordinary loader cannot mint the nonexpiring forward authority", async (t) => {
  const f = await commandIntegrationFixture(t, null, { nested: true });
  const target = f.record.deployment.preparedTarget;
  target.observations.egress.value = productionAuthorization(target, f);
  preparedBound({ record: target });
  await f.publish();
  await assert.rejects(loadHostOperation(f.root, await integrationOptions(f.root)));
});

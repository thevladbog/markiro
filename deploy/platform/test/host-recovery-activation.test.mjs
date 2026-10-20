import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { privateFixture, hostIdentity, backupProof } from "./host-fixtures.mjs";
import { withRecoveryState } from "../host/recovery-state.mjs";
import { withHostState, withHeldHostState } from "../host/state.mjs";
import { withRecoveryActivationState } from "../host/recovery-activation-state.mjs";
const now = Date.parse("2026-10-20T00:00:00Z");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const phases = ["activation-admitted", "images-verified", "api-started", "edge-started", "healthy"];
async function fixture(t) {
  const { root } = await privateFixture(t);
  const prior = hostIdentity(),
    identity = hostIdentity();
  const bytes = Buffer.from(
    JSON.stringify({
      version: 1,
      sequence: 14,
      previousHealthy: null,
      current: {
        identity: prior,
        phase: "api-started",
        status: "recovery-required",
        backup: backupProof(prior),
      },
    }) + "\n",
  );
  await writeFile(join(root, "state.json"), bytes, { mode: 0o600 });
  const admission = {
    version: 1,
    kind: "platform-failed-activation-recovery",
    identity,
    predecessor: { identity: prior, sequence: 14, stateSha256: hash(bytes) },
    executorCi: { runId: "123456789", runAttempt: "1" },
    expiresAt: "2026-10-20T00:10:00.000Z",
  };
  await withRecoveryState(
    root,
    admission,
    async (store) => {
      await store.complete("admitted");
      await store.enter("target-stopped");
      await store.complete("target-stopped");
      await store.enter("backup-verified");
      await store.complete("backup-verified", backupProof(identity));
    },
    { now: () => now },
  );
  const preparation = await readFile(join(root, "recovery-state.json"));
  const observations = Object.fromEntries(
    [
      "postgres",
      "tls",
      "rolePolicy",
      "restoredSnapshot",
      "egress",
      "keyContinuity",
      "offHostRecovery",
    ].map((name) => [
      name,
      {
        kind: ["postgres", "tls", "rolePolicy", "restoredSnapshot"].includes(name)
          ? "measured"
          : "operator-attestation",
        producerId: name,
        executorSha: identity.executorSha,
        operationId: identity.operationId,
        target: identity.target,
        fenceId: "fixture-fence",
        configurationSha256: identity.configurationSha256,
        snapshotId: "fixture-snapshot",
        observedAt: "2026-10-20T00:20:00.000Z",
        value: {},
      },
    ]),
  );
  observations.restoredSnapshot.value = {
    archiveSha256: "d".repeat(64),
    restoreEvidenceSha256: "e".repeat(64),
  };
  const input = {
    version: 1,
    kind: "platform-recovery-activation",
    admission: { ...admission, expiresAt: "2026-10-20T00:50:00.000Z" },
    preparation: { sequence: 6, sha256: hash(preparation) },
    preparedTarget: {
      version: 2,
      kind: "platform-prepared-target",
      operationId: identity.operationId,
      target: identity.target,
      executorSha: identity.executorSha,
      configurationSha256: identity.configurationSha256,
      provenance: "live-source",
      fence: {
        fenceId: "fixture-fence",
        enforcementSha256: "f".repeat(64),
        beganAt: "2026-10-20T00:00:00.000Z",
      },
      observations,
    },
    preparedPolicy: {
      backup: {},
      restoreEvidence: {},
      roleMapping: {},
      postgres: {},
      tls: {},
      rolePolicySha256: "f".repeat(64),
      provenance: "live-source",
      maxAgeMs: 3600000,
      producers: Object.fromEntries(Object.keys(observations).map((n) => [n, n])),
    },
    configuration: {
      candidateId: identity.operationId,
      runtimeSnapshot: {},
      migrationSnapshot: {},
    },
    dispatch: { toolingSha: "a".repeat(40), runId: "456789", runAttempt: "1" },
  };
  return { root, bytes, preparation, input };
}
const run = (f, cb, clock = () => now + 20 * 60000) =>
  withRecoveryActivationState(f.root, f.input, cb, { now: clock });
async function immutable(f) {
  assert.deepEqual(await readFile(join(f.root, "state.json")), f.bytes);
  assert.deepEqual(await readFile(join(f.root, "recovery-preparation.json")), f.preparation);
}
test("structural activation accepts expired historical admission and exact durable sequence; full live prepared validation remains executor obligation", async (t) => {
  const f = await fixture(t);
  let expired;
  await run(f, async (store) => {
    expired = store;
    for (const [i, phase] of phases.entries()) {
      if (i) await store.enter(phase);
      const state = await store.read();
      assert.equal(state.sequence, 7 + i * 2);
      assert.equal(state.phase, phase);
      await assert.rejects(store.enter("healthy"));
      await assert.rejects(store.complete(phase, {}));
      await store.complete(phase);
    }
    await assert.rejects(store.enter("images-verified"));
    await assert.rejects(withHostState(f.root, () => {}));
  });
  await immutable(f);
  await assert.rejects(expired.read());
  const state = JSON.parse(await readFile(join(f.root, "recovery-state.json")));
  assert.equal(state.sequence, 16);
  assert.equal(state.status, "completed");
  assert.equal(state.admission.expiresAt, "2026-10-20T00:10:00.000Z");
  await assert.rejects(run(f, () => assert.fail("replay")));
  await assert.rejects(withHostState(f.root, (s) => s.begin(hostIdentity())));
  const consumption = JSON.parse(
    await readFile(
      join(f.root, `recovery-activation-${f.input.admission.identity.operationId}.json`),
    ),
  );
  assert.equal(consumption.activationSha256, hash(Buffer.from(JSON.stringify(f.input))));
});
for (const [name, mutate] of [
  ["expired", (f) => (f.input.admission.expiresAt = "2026-10-20T00:19:00.000Z")],
  ["identity", (f) => (f.input.admission.identity.executorSha = "a".repeat(40))],
  ["predecessor", (f) => (f.input.admission.predecessor.stateSha256 = "a".repeat(64))],
  ["CI", (f) => (f.input.admission.executorCi.runId = "99")],
  [
    "backup",
    (f) =>
      (f.input.preparedTarget.observations.restoredSnapshot.value.archiveSha256 = "a".repeat(64)),
  ],
  ["hash", (f) => (f.input.preparation.sha256 = "a".repeat(64))],
  ["v1", (f) => (f.input.preparedTarget.version = 1)],
  ["synthetic", (f) => (f.input.preparedPolicy.provenance = "local-synthetic")],
  ["extra", (f) => (f.input.force = true)],
  ["dispatch", (f) => (f.input.dispatch.runId = "01")],
])
  test(`activation rejects ${name} before callback`, async (t) => {
    const f = await fixture(t);
    mutate(f);
    await assert.rejects(run(f, () => assert.fail("callback")));
    assert.deepEqual(await readFile(join(f.root, "recovery-state.json")), f.preparation);
  });
test("activation rejects accessor data without invoking getters", async (t) => {
  const f = await fixture(t);
  let called = false;
  Object.defineProperty(f.input, "dispatch", {
    enumerable: true,
    get() {
      called = true;
      return {};
    },
  });
  await assert.rejects(run(f, () => assert.fail("callback")));
  assert.equal(called, false);
});
test("activation freezes input synchronously and checks fresh deadline at every boundary", async (t) => {
  const f = await fixture(t);
  let clock = now + 20 * 60000;
  const pending = run(
    f,
    async (store) => {
      await store.complete("activation-admitted");
      clock = now + 51 * 60000;
      await assert.rejects(store.enter("images-verified"));
    },
    () => clock,
  );
  f.input.admission.expiresAt = "2026-10-20T01:00:00.000Z";
  await pending;
  await immutable(f);
  assert.equal(JSON.parse(await readFile(join(f.root, "recovery-state.json"))).sequence, 8);
});
for (const name of ["recovery-preparation.json", "consumption"])
  test(`partial ${name} persistence refuses replay`, async (t) => {
    const f = await fixture(t);
    const path =
      name === "consumption"
        ? `recovery-activation-${f.input.admission.identity.operationId}.json`
        : name;
    await writeFile(join(f.root, path), f.preparation, { mode: 0o600 });
    await assert.rejects(run(f, () => assert.fail("callback")));
    assert.deepEqual(await readFile(join(f.root, path)), f.preparation);
  });
for (const name of ["state.json", "recovery-preparation.json"])
  test(`changed ${name} bytes reject every next boundary`, async (t) => {
    const f = await fixture(t);
    await run(f, async (store) => {
      await store.complete("activation-admitted");
      await writeFile(
        join(f.root, name),
        Buffer.concat([name === "state.json" ? f.bytes : f.preparation, Buffer.from(" ")]),
      );
      await assert.rejects(store.enter("images-verified"));
    });
    assert.equal(JSON.parse(await readFile(join(f.root, "recovery-state.json"))).sequence, 8);
  });
test("simultaneous activation shares lock and ordinary errors permanently fence replay", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    run(f, async (store) => {
      await assert.rejects(run(f, () => assert.fail("second")));
      await store.complete("activation-admitted");
      await store.enter("images-verified");
      throw new Error("fixture");
    }),
  );
  const state = JSON.parse(await readFile(join(f.root, "recovery-state.json")));
  assert.equal(state.sequence, 10);
  assert.equal(state.status, "recovery-required");
  await immutable(f);
  await assert.rejects(run(f, () => assert.fail("replay")));
});
for (const kind of ["termination", "caught-persistence"])
  test(`${kind} uncertainty retains lock and last durable phase`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      run(f, async (store) => {
        if (kind === "termination")
          throw Object.assign(new Error("fixture"), { terminationConfirmed: false });
        await assert.rejects(
          store.guard(async (capability) =>
            withHeldHostState(capability, () => {
              throw Object.assign(new Error("fixture"), { durabilityUncertain: true });
            }),
          ),
        );
      }),
      { durabilityUncertain: true },
    );
    await lstat(join(f.root, ".deploy.lock"));
    await immutable(f);
    assert.equal(JSON.parse(await readFile(join(f.root, "recovery-state.json"))).sequence, 7);
  });
test("caught unconfirmed adapter termination still latches shared lock", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    run(f, async (store) => {
      await assert.rejects(
        store.guard(async () => {
          throw Object.assign(new Error("fixture"), { terminationConfirmed: false });
        }),
      );
    }),
    { durabilityUncertain: true },
  );
  await lstat(join(f.root, ".deploy.lock"));
  await immutable(f);
});
test("prepared evidence arrays preserve strict data-only snapshot rules", async (t) => {
  const f = await fixture(t);
  f.input.preparedTarget.observations.egress.value = { projection: [] };
  let token;
  await run(f, async (store) => {
    await store.guard((capability) =>
      withHeldHostState(capability, (held) => {
        token = capability;
        assert.equal(held.state.sequence, 14);
      }),
    );
    await assert.rejects(withHeldHostState(token, () => {}));
  });
  await assert.rejects(withHeldHostState(token, () => {}));
});
test("mutated current sidecar is never overwritten by a subsequent boundary", async (t) => {
  const f = await fixture(t);
  let modified;
  await run(f, async (store) => {
    modified = Buffer.concat([
      await readFile(join(f.root, "recovery-state.json")),
      Buffer.from(" "),
    ]);
    await writeFile(join(f.root, "recovery-state.json"), modified);
    await assert.rejects(store.complete("activation-admitted"));
  });
  assert.deepEqual(await readFile(join(f.root, "recovery-state.json")), modified);
});

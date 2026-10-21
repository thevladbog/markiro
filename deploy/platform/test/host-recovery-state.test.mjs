import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { privateFixture, hostIdentity, backupProof } from "./host-fixtures.mjs";
import { withHostState, withHeldHostState } from "../host/state.mjs";
import { withRecoveryState } from "../host/recovery-state.mjs";
const now = Date.parse("2026-10-20T00:00:00Z");
async function fixture(t) {
  const { root } = await privateFixture(t);
  const prior = hostIdentity();
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
    }),
  );
  await writeFile(join(root, "state.json"), bytes, { mode: 0o600 });
  const identity = structuredClone(prior);
  identity.operationId = hostIdentity().operationId;
  const admission = {
    version: 1,
    kind: "platform-failed-activation-recovery",
    identity,
    predecessor: {
      identity: prior,
      sequence: 14,
      stateSha256: createHash("sha256").update(bytes).digest("hex"),
    },
    executorCi: { runId: "123456789", runAttempt: "1" },
    expiresAt: "2026-10-20T00:30:00.000Z",
  };
  return { root, admission, bytes };
}
function run(f, cb) {
  return withRecoveryState(f.root, f.admission, cb, { now: () => now });
}
test("recovery journal preserves original failure and shares the ordinary deployment lock", async (t) => {
  const f = await fixture(t);
  await run(f, async (store) => {
    assert.equal((await store.read()).phase, "admitted");
    await assert.rejects(withHostState(f.root, () => {}));
    await assert.rejects(store.enter("edge-started"));
    await store.complete("admitted");
    await store.enter("target-stopped");
    await store.complete("target-stopped");
  });
  assert.deepEqual(await readFile(join(f.root, "state.json")), f.bytes);
  const ledger = JSON.parse(await readFile(join(f.root, "recovery-state.json")));
  assert.equal(ledger.phase, "target-stopped");
  assert.equal(ledger.status, "completed");
  await assert.rejects(run(f, () => {}));
});
test("recovery callback failure durably fences replay without changing predecessor", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    run(f, async (store) => {
      await store.complete("admitted");
      await store.enter("target-stopped");
      throw new Error("fixture private failure");
    }),
  );
  const ledger = JSON.parse(await readFile(join(f.root, "recovery-state.json")));
  assert.equal(ledger.phase, "target-stopped");
  assert.equal(ledger.status, "recovery-required");
  assert.deepEqual(await readFile(join(f.root, "state.json")), f.bytes);
  await assert.rejects(run(f, () => {}));
});

test("caller cannot extend recovery admission lifetime after entry", async (t) => {
  const f = await fixture(t);
  let clock = now;
  await withRecoveryState(
    f.root,
    f.admission,
    async (store) => {
      await store.complete("admitted");
      f.admission.expiresAt = "2026-10-20T01:00:00.000Z";
      clock = now + 31 * 60 * 1000;
      await assert.rejects(store.enter("target-stopped"));
    },
    { now: () => clock },
  );
  const ledger = JSON.parse(await readFile(join(f.root, "recovery-state.json")));
  assert.equal(ledger.phase, "admitted");
  assert.equal(ledger.admission.expiresAt, "2026-10-20T00:30:00.000Z");
});

test("expired recovery store cannot mutate its durable sidecar", async (t) => {
  const f = await fixture(t);
  let expired;
  await run(f, async (store) => {
    expired = store;
    await store.complete("admitted");
  });
  const before = await readFile(join(f.root, "recovery-state.json"));
  await assert.rejects(expired.enter("target-stopped"));
  assert.deepEqual(await readFile(join(f.root, "recovery-state.json")), before);
  assert.deepEqual(await readFile(join(f.root, "state.json")), f.bytes);
});

test("changed predecessor bytes fence recovery before the next transition", async (t) => {
  const f = await fixture(t);
  await run(f, async (store) => {
    await store.complete("admitted");
    await writeFile(join(f.root, "state.json"), Buffer.concat([f.bytes, Buffer.from(" ")]));
    await assert.rejects(store.enter("target-stopped"));
  });
  const ledger = JSON.parse(await readFile(join(f.root, "recovery-state.json")));
  assert.equal(ledger.phase, "admitted");
  assert.equal(ledger.sequence, 2);
});

test("recovery backup completion requires proof bound to the new operation", async (t) => {
  const f = await fixture(t);
  await run(f, async (store) => {
    await store.complete("admitted");
    await store.enter("target-stopped");
    await store.complete("target-stopped");
    await store.enter("backup-verified");
    await assert.rejects(store.complete("backup-verified"));
    await assert.rejects(
      store.complete("backup-verified", backupProof(f.admission.predecessor.identity)),
    );
    const proof = backupProof(f.admission.identity);
    await store.complete("backup-verified", proof);
    proof.archiveSha256 = "0".repeat(64);
    assert.deepEqual((await store.read()).backup, backupProof(f.admission.identity));
    await assert.rejects(store.enter("api-started"));
  });
  assert.deepEqual(await readFile(join(f.root, "state.json")), f.bytes);
});

test("recovery refuses extra backup evidence on a non-backup phase", async (t) => {
  const f = await fixture(t);
  await run(f, async (store) => {
    await assert.rejects(store.complete("admitted", backupProof(f.admission.identity)));
    assert.equal((await store.read()).status, "entered");
  });
});

import { executeRecoveryPreparation } from "../host/recovery-preparation.mjs";
for (const failure of [null, "admission", "ownership", "stop", "writers", "backup"]) {
  test(`recovery preparation persists safe boundaries with ${failure ?? "no"} failure`, async (t) => {
    const f = await fixture(t);
    const calls = [];
    const phase = async () => JSON.parse(await readFile(join(f.root, "recovery-state.json")));
    const adapters = {
      verifyAdmission: async (context) => {
        calls.push("admission");
        if (failure === "admission") throw new Error("fixture refused");
        return context.admission.identity;
      },
      inspectTarget: async (context) => {
        calls.push("ownership");
        if (failure === "ownership") throw new Error("fixture foreign target");
        return { target: context.admission.identity.target, project: "markiro-platform" };
      },
      stopOwnedWorkloads: async () => {
        const state = await phase();
        assert.equal(state.phase, "target-stopped");
        assert.equal(state.status, "entered");
        calls.push("stop");
        if (failure === "stop") throw new Error("fixture timeout");
      },
      inspectStoppedWorkloads: async (context) => {
        calls.push("writers");
        return {
          target: context.admission.identity.target,
          project: "markiro-platform",
          active: failure === "writers" ? ["foreign"] : [],
        };
      },
      createBackup: async (context, capability) => {
        await withHeldHostState(capability, async (held) => {
          assert.equal(held.root, f.root);
          assert.equal(held.state.sequence, 14);
          await assert.rejects(withHostState(f.root, () => {}));
        });
        const state = await phase();
        assert.equal(state.phase, "backup-verified");
        assert.equal(state.status, "entered");
        calls.push("backup");
        return backupProof(
          failure === "backup" ? f.admission.predecessor.identity : context.admission.identity,
        );
      },
    };
    const execution = executeRecoveryPreparation(
      { root: f.root, admission: f.admission },
      adapters,
      { now: () => now },
    );
    if (failure) await assert.rejects(execution);
    else assert.deepEqual(await execution, backupProof(f.admission.identity));
    const expected = ["admission", "ownership", "stop", "writers", "backup"];
    assert.deepEqual(calls, failure ? expected.slice(0, expected.indexOf(failure) + 1) : expected);
    const state = await phase();
    assert.equal(state.status, failure ? "recovery-required" : "completed");
    assert.deepEqual(await readFile(join(f.root, "state.json")), f.bytes);
  });
}

test("recovery backup producer is phase-bound, single-use and retains uncertainty", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    run(f, async (store) => {
      let calls = 0;
      const producer = async () => {
        calls++;
      };
      await assert.rejects(store.produceBackup(producer));
      assert.equal(calls, 0);
      await store.complete("admitted");
      await store.enter("target-stopped");
      await store.complete("target-stopped");
      await store.enter("backup-verified");
      await assert.rejects(
        store.produceBackup(async (capability) => {
          await withHeldHostState(capability, () => {
            throw Object.assign(new Error("fixture uncertain cleanup"), {
              durabilityUncertain: true,
            });
          });
        }),
      );
      await assert.rejects(store.produceBackup(producer));
      assert.equal(calls, 0);
    }),
    { durabilityUncertain: true },
  );
  await readFile(join(f.root, ".deploy.lock"));
  assert.deepEqual(await readFile(join(f.root, "state.json")), f.bytes);
});

test("backup producer capability expires and successful production cannot be repeated", async (t) => {
  const f = await fixture(t);
  let token;
  let calls = 0;
  await run(f, async (store) => {
    await store.complete("admitted");
    await store.enter("target-stopped");
    await store.complete("target-stopped");
    await store.enter("backup-verified");
    const proof = await store.produceBackup(async (capability) => {
      token = capability;
      calls++;
      return withHeldHostState(capability, () => backupProof(f.admission.identity));
    });
    await assert.rejects(withHeldHostState(token, () => {}));
    await assert.rejects(
      store.produceBackup(() => {
        calls++;
      }),
    );
    await store.complete("backup-verified", proof);
  });
  assert.equal(calls, 1);
  await assert.rejects(withHeldHostState(token, () => {}));
  assert.deepEqual(await readFile(join(f.root, "state.json")), f.bytes);
});

test("unconfirmed stop process retains recovery lock even before backup starts", async (t) => {
  const f = await fixture(t);
  let backupCalled = false;
  await assert.rejects(
    executeRecoveryPreparation(
      { root: f.root, admission: f.admission },
      {
        verifyAdmission: async () => f.admission.identity,
        inspectTarget: async () => ({
          target: f.admission.identity.target,
          project: "markiro-platform",
        }),
        stopOwnedWorkloads: async () => {
          throw Object.assign(new Error("fixture stop still running"), {
            terminationConfirmed: false,
          });
        },
        inspectStoppedWorkloads: async () => {
          throw new Error("must not inspect after uncertain stop");
        },
        createBackup: async () => {
          backupCalled = true;
        },
      },
      { now: () => now },
    ),
    { durabilityUncertain: true },
  );
  assert.equal(backupCalled, false);
  await lstat(join(f.root, ".deploy.lock"));
  assert.deepEqual(await readFile(join(f.root, "state.json")), f.bytes);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile } from "node:fs/promises";
import { validatePreparedTarget } from "../host/prepared-target.mjs";
import { preparedFixture } from "./prepared-target-fixture.mjs";
import { productionFixture } from "./production-activation-fixture.mjs";
import { withHostState } from "../host/state.mjs";

const mutations = {
  "PG digest differs from actual config": (f) => {
    f.expected.postgres.image = "sha256:" + "9".repeat(64);
    f.record.observations.postgres.value.image = f.expected.postgres.image;
  },
  "excessive freshness": (f) => {
    f.expected.maxAgeMs = 86400001;
  },
  "zero freshness": (f) => {
    f.expected.maxAgeMs = 0;
  },
  "future workload": (f) => {
    const inspect = f.expected.workload.inspect;
    f.expected.workload.inspect = async () => ({
      ...(await inspect()),
      observedAt: new Date(Date.now() + 10000).toISOString(),
    });
  },
  "stale workload": (f) => {
    const inspect = f.expected.workload.inspect;
    f.expected.workload.inspect = async () => ({
      ...(await inspect()),
      observedAt: new Date(Date.now() - 31000).toISOString(),
    });
  },
  "future fence": (f) => {
    const observe = f.expected.writerFence.observe;
    f.expected.writerFence.observe = async (request) => ({
      ...(await observe(request)),
      observedAt: new Date(Date.now() + 10000).toISOString(),
    });
  },
  "different fence": (f) => {
    const observe = f.expected.writerFence.observe;
    f.expected.writerFence.observe = async (request) => ({
      ...(await observe(request)),
      fenceId: "other",
    });
  },
  "fence producer": (f) => {
    const observe = f.expected.writerFence.observe;
    f.expected.writerFence.observe = async (request) => ({
      ...(await observe(request)),
      producerId: "other",
    });
  },
  "workload producer": (f) => {
    const inspect = f.expected.workload.inspect;
    f.expected.workload.inspect = async () => ({ ...(await inspect()), producerId: "other" });
  },
  "extra record key": (f) => {
    f.record.accepted = true;
  },
  "wrong offhost archive": (f) => {
    f.record.observations.offHostRecovery.value.archiveSha256 = "0".repeat(64);
  },
  "missing signing continuity": (f) => {
    f.record.observations.keyContinuity.value.signingContinuityVerified = false;
  },
  "snapshot hash mismatch": async (f) => {
    f.evidence.restoredInventorySha256 = "0".repeat(64);
    await f.publish();
  },

  "runtime config": async (f) =>
    appendFile(f.expected.configuration.runtimeSnapshot.path, "#changed"),
  "migration config": async (f) =>
    appendFile(f.expected.configuration.migrationSnapshot.path, "#changed"),
  "operator substituted for restore": (f) => {
    f.record.observations.restoredSnapshot.kind = "operator-attestation";
  },
  "missing egress": (f) => {
    delete f.record.observations.egress;
  },
  "missing keys": (f) => {
    delete f.record.observations.keyContinuity;
  },
  "missing recovery": (f) => {
    delete f.record.observations.offHostRecovery;
  },
  "released fence": (f) => f.setHeld(false),
  "active workload": (f) => f.setStatus("running"),
  "unknown workload": (f) => f.setStatus("unknown"),
  "future observation": (f) => {
    f.record.observations.tls.observedAt = new Date(Date.now() + 1000).toISOString();
  },
  "stale observation": (f) => {
    f.expected.maxAgeMs = 1;
  },
  "pre fence": (f) => {
    f.record.observations.tls.observedAt = "2020-01-01T00:00:00.000Z";
  },
  "wrong producer": (f) => {
    f.record.observations.postgres.producerId = "untrusted";
  },
  "wrong snapshot": (f) => {
    f.record.observations.postgres.snapshotId = "AAAA";
  },
  "wrong config": (f) => {
    f.record.observations.postgres.configurationSha256 = "a".repeat(64);
  },
  "wrong pg digest": (f) => {
    f.record.observations.postgres.value.image = "sha256:" + "0".repeat(64);
  },
  "expired cert": (f) => {
    f.record.observations.tls.value.expiresAt = new Date(Date.now() - 1).toISOString();
  },
  "wrong SAN": (f) => {
    f.record.observations.tls.value.san = "other.private";
  },
  "wrong role policy": (f) => {
    f.record.observations.rolePolicy.value.policySha256 = "0".repeat(64);
  },
  "wrong mapping": (f) => {
    f.expected.roleMapping.roles = [{ source: "unknown", target: "renamed" }];
  },
  "synthetic live substitution": (f) => {
    f.expected.provenance = "live-source";
  },
  "retained intents omitted": (f) => {
    delete f.record.observations.egress.value.retainedMail;
  },
  "independent key missing": (f) => {
    f.record.observations.offHostRecovery.value.independentKeyAvailable = false;
  },
  "owner label mismatch": (f) => {
    const inspect = f.expected.workload.inspect;
    f.expected.workload.inspect = async () => ({ ...(await inspect()), ownerOperationId: "other" });
  },
  "container substituted": (f) => {
    f.expected.workload.identity = { ...f.expected.workload.identity, containerId: "b".repeat(64) };
  },
};
test("prepared target retains explicit synthetic provenance and operator attestations", async (t) => {
  const f = await preparedFixture(t);
  const result = await validatePreparedTarget(f.record, f.expected);
  assert.deepEqual(result.record, f.record);
  assert.equal(result.backupProof.operationId, f.identity.operationId);
  assert.equal(result.record.observations.egress.kind, "operator-attestation");
});
for (const [name, mutate] of Object.entries(mutations))
  test(`prepared target rejects ${name} without journal advancement`, async (t) => {
    const f = await preparedFixture(t);
    await mutate(f);
    await withHostState(f.root, async (store) => {
      await store.begin(f.identity);
      await store.complete("admitted");
      for (const phase of ["images-verified", "target-stopped"]) {
        await store.enter(phase);
        await store.complete(phase);
      }
      await store.enter("backup-verified");
      const before = await store.read();
      await assert.rejects(async () => {
        const result = await validatePreparedTarget(f.record, f.expected);
        await store.complete("backup-verified", result.backupProof);
      });
      assert.deepEqual(await store.read(), before);
    });
  });

for (const expired of ["backup start", "restore completion"])
  test(`prepared target rejects ${expired} expiring during inspection without journal advancement`, async (t) => {
    const f = await preparedFixture(t);
    const began = Date.parse(f.document.startedAt);
    let now = began + 1000;
    t.mock.method(Date, "now", () => now);
    const iso = () => new Date(now).toISOString();
    f.expected.maxAgeMs = 1500;
    // Backup-only expiry has a newly completed restore. In the restore-expiry
    // case the backup is necessarily at least as old by producer chronology.
    if (expired === "backup start") {
      f.document.completedAt = iso();
      f.evidence.startedAt = iso();
      f.evidence.completedAt = iso();
    }
    await f.publish();
    const restored = f.record.observations.restoredSnapshot.value;
    restored.inventorySha256 = f.backup.inventorySha256;
    restored.restoreEvidenceSha256 = f.restoreEvidence.evidenceSha256;
    for (const observation of Object.values(f.record.observations)) observation.observedAt = iso();
    const inspect = f.expected.workload.inspect;
    f.expected.workload.inspect = async () => ({ ...(await inspect()), observedAt: iso() });
    const observe = f.expected.writerFence.observe;
    f.expected.writerFence.observe = async (request) => ({
      ...(await observe(request)),
      observedAt: iso(),
    });
    // Establish that the full bytes/bindings and initial freshness are valid.
    await validatePreparedTarget(f.record, f.expected);
    f.expected.writerFence.observe = async (request) => {
      const result = await observe(request);
      now += 1000;
      return { ...result, observedAt: iso() };
    };
    await withHostState(f.root, async (store) => {
      await store.begin(f.identity);
      await store.complete("admitted");
      for (const phase of ["images-verified", "target-stopped"]) {
        await store.enter(phase);
        await store.complete(phase);
      }
      await store.enter("backup-verified");
      const before = await store.read();
      await assert.rejects(async () => {
        const result = await validatePreparedTarget(f.record, f.expected);
        await store.complete("backup-verified", result.backupProof);
      });
      const expiredAt = expired === "backup start" ? f.document.startedAt : f.evidence.completedAt;
      assert.equal(now - Date.parse(expiredAt), 2000);
      if (expired === "backup start") assert.equal(now - Date.parse(f.evidence.completedAt), 1000);
      for (const observation of Object.values(f.record.observations))
        assert.equal(now - Date.parse(observation.observedAt), 1000);
      assert.deepEqual(await store.read(), before);
      assert.equal(before.current.status, "entered");
      assert.equal(before.current.backup, null);
    });
  });

function cleanedWorkload(f) {
  const resources = structuredClone(f.evidence.cleanup.resources);
  const producerId = f.expected.workload.producerId;
  return {
    identity: { resources },
    producerId,
    executorSha: f.identity.executorSha,
    inspect: async () => ({
      version: 2,
      kind: "platform-restore-cleanup",
      status: "absent",
      operationId: f.identity.operationId,
      target: f.identity.target,
      producerId,
      executorSha: f.identity.executorSha,
      observedAt: new Date().toISOString(),
      resources,
      present: [],
      operationResources: [],
    }),
  };
}

test("prepared target accepts fresh absence of all byte-bound restore cleanup resources", async (t) => {
  const f = await preparedFixture(t);
  f.expected.workload = cleanedWorkload(f);
  const result = await validatePreparedTarget(f.record, f.expected);
  assert.equal(result.backupProof.restoreEvidenceSha256, f.restoreEvidence.evidenceSha256);
});

for (const mutation of [
  "missing resource",
  "substituted resource",
  "remaining volume",
  "extra operation resource",
  "stale",
  "unknown key",
])
  test(`prepared cleanup rejects ${mutation}`, async (t) => {
    const f = await preparedFixture(t);
    f.expected.workload = cleanedWorkload(f);
    const inspect = f.expected.workload.inspect;
    f.expected.workload.inspect = async () => {
      const observation = await inspect();
      if (mutation === "missing resource") observation.resources.pop();
      if (mutation === "substituted resource") observation.resources[0].name += "-other";
      if (mutation === "remaining volume") observation.present.push(observation.resources[0]);
      if (mutation === "extra operation resource")
        observation.operationResources.push({ kind: "container", name: "outsider" });
      if (mutation === "stale") observation.observedAt = new Date(Date.now() - 31000).toISOString();
      if (mutation === "unknown key") observation.verified = true;
      return observation;
    };
    await assert.rejects(validatePreparedTarget(f.record, f.expected));
  });

function preparedClock(t, f) {
  const clock = { now: Date.now() };
  t.mock.method(Date, "now", () => clock.now);
  const inspect = f.expected.workload.inspect;
  f.expected.workload.inspect = async (...args) => ({
    ...(await inspect(...args)),
    observedAt: new Date(clock.now).toISOString(),
  });
  const observe = f.expected.writerFence.observe;
  f.expected.writerFence.observe = async (...args) => ({
    ...(await observe(...args)),
    observedAt: new Date(clock.now).toISOString(),
  });
  return clock;
}

test("slow writer fence is followed by a fresh complete cleanup observation", async (t) => {
  const f = await preparedFixture(t);
  f.expected.workload = cleanedWorkload(f);
  const clock = preparedClock(t, f);
  const observe = f.expected.writerFence.observe;
  f.expected.writerFence.observe = async (...args) => {
    const value = await observe(...args);
    clock.now += 31000;
    return { ...value, observedAt: new Date(clock.now).toISOString() };
  };
  const result = await validatePreparedTarget(f.record, f.expected);
  result.recheckFreshness();
  clock.now += 30001;
  assert.throws(result.recheckFreshness);
});

test("unsafe early cleanup denies the writer fence before its producer runs", async (t) => {
  const f = await preparedFixture(t);
  f.expected.workload = cleanedWorkload(f);
  const inspect = f.expected.workload.inspect;
  f.expected.workload.inspect = async (...args) => {
    const value = await inspect(...args);
    value.present.push(value.resources[0]);
    return value;
  };
  let fenceRan = false;
  f.expected.writerFence.observe = async () => {
    fenceRan = true;
    throw Error("must not reach a fence producer with active restore resources");
  };
  await assert.rejects(validatePreparedTarget(f.record, f.expected));
  assert.equal(fenceRan, false);
});

for (const mutation of ["substituted resource", "foreign resource", "stale", "future", "producer"])
  test(`cleanup changed after slow fence rejects ${mutation}`, async (t) => {
    const f = await preparedFixture(t);
    f.expected.workload = cleanedWorkload(f);
    const clock = preparedClock(t, f);
    const observe = f.expected.writerFence.observe;
    let fenceCompleted = false;
    f.expected.writerFence.observe = async (...args) => {
      const value = await observe(...args);
      clock.now += 31000;
      fenceCompleted = true;
      return { ...value, observedAt: new Date(clock.now).toISOString() };
    };
    const inspect = f.expected.workload.inspect;
    f.expected.workload.inspect = async (...args) => {
      const value = await inspect(...args);
      if (fenceCompleted) {
        if (mutation === "substituted resource") value.resources[0].name += "-changed";
        if (mutation === "foreign resource")
          value.operationResources.push({ kind: "container", name: "foreign-restore" });
        if (mutation === "stale") value.observedAt = new Date(clock.now - 30001).toISOString();
        if (mutation === "future") value.observedAt = new Date(clock.now + 1).toISOString();
        if (mutation === "producer") value.producerId = "untrusted-producer";
      }
      return value;
    };
    await assert.rejects(validatePreparedTarget(f.record, f.expected));
  });

test("slow final cleanup rejects a fence older than 30 seconds", async (t) => {
  const f = await preparedFixture(t);
  f.expected.workload = cleanedWorkload(f);
  const clock = preparedClock(t, f);
  const observe = f.expected.writerFence.observe;
  let fenceCompleted = false;
  f.expected.writerFence.observe = async (...args) => {
    const value = await observe(...args);
    fenceCompleted = true;
    return value;
  };
  const inspect = f.expected.workload.inspect;
  f.expected.workload.inspect = async (...args) => {
    if (fenceCompleted) clock.now += 31000;
    return inspect(...args);
  };
  await assert.rejects(validatePreparedTarget(f.record, f.expected));
});

test("final cleanup cannot extend backup freshness", async (t) => {
  const f = await preparedFixture(t);
  const began = Date.parse(f.document.startedAt);
  const clock = { now: began + 1000 };
  t.mock.method(Date, "now", () => clock.now);
  const iso = () => new Date(clock.now).toISOString();
  f.expected.maxAgeMs = 1500;
  f.document.completedAt = iso();
  f.evidence.startedAt = iso();
  f.evidence.completedAt = iso();
  await f.publish();
  const restored = f.record.observations.restoredSnapshot.value;
  restored.inventorySha256 = f.backup.inventorySha256;
  restored.restoreEvidenceSha256 = f.restoreEvidence.evidenceSha256;
  for (const value of Object.values(f.record.observations)) value.observedAt = iso();
  f.expected.workload = cleanedWorkload(f);
  const observe = f.expected.writerFence.observe;
  let fenceCompleted = false;
  f.expected.writerFence.observe = async (...args) => {
    const value = await observe(...args);
    fenceCompleted = true;
    return { ...value, observedAt: iso() };
  };
  const inspect = f.expected.workload.inspect;
  f.expected.workload.inspect = async (...args) => {
    if (fenceCompleted) clock.now += 1000;
    return { ...(await inspect(...args)), observedAt: iso() };
  };
  await assert.rejects(validatePreparedTarget(f.record, f.expected));
});

test("final cleanup cannot extend production authorization expiry", async (t) => {
  const f = await productionFixture(t);
  f.expected.workload = cleanedWorkload(f);
  const clock = preparedClock(t, f);
  f.record.observations.egress.value.expiresAt = new Date(clock.now + 1000).toISOString();
  await validatePreparedTarget(f.record, f.expected);
  const observe = f.expected.writerFence.observe;
  let fenceCompleted = false;
  f.expected.writerFence.observe = async (...args) => {
    const value = await observe(...args);
    fenceCompleted = true;
    return value;
  };
  const inspect = f.expected.workload.inspect;
  f.expected.workload.inspect = async (...args) => {
    if (fenceCompleted) clock.now += 1001;
    return inspect(...args);
  };
  await assert.rejects(validatePreparedTarget(f.record, f.expected));
});

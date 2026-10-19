import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile } from "node:fs/promises";
import { validatePreparedTarget } from "../host/prepared-target.mjs";
import { preparedFixture } from "./prepared-target-fixture.mjs";
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

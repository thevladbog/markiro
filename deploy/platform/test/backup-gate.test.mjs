import assert from "node:assert/strict";
import { test } from "node:test";
import { canonical, digest } from "../backup/schemas.mjs";
import { appendFile } from "node:fs/promises";
import { verifyBackupGate } from "../host/backup-gate.mjs";
import { preparedFixture } from "./prepared-target-fixture.mjs";
import { withHostState } from "../host/state.mjs";

export async function atBackup(store, identity) {
  await store.begin(identity);
  await store.complete("admitted");
  for (const phase of ["images-verified", "target-stopped"]) {
    await store.enter(phase);
    await store.complete(phase);
  }
  await store.enter("backup-verified");
}
test("backup gate returns exactly the existing journal proof after byte verification", async (t) => {
  const f = await preparedFixture(t);
  assert.deepEqual(await verifyBackupGate(f), {
    archiveSha256: f.backup.archiveSha256,
    restoreEvidenceSha256: f.restoreEvidence.evidenceSha256,
    target: f.identity.target,
    operationId: f.identity.operationId,
  });
});
for (const mutation of [
  "archive",
  "inventory",
  "evidence",
  "operation",
  "target",
  "snapshot",
  "fence",
  "runtime",
  "producer",
  "provenance",
  "incomplete",
  "cleanup",
  "future",
  "pre-fence",
]) {
  test(`backup gate rejects ${mutation} and cannot complete journal`, async (t) => {
    const f = await preparedFixture(t);
    if (["archive", "inventory", "evidence"].includes(mutation))
      await appendFile(
        mutation === "archive"
          ? f.backup.archivePath
          : mutation === "inventory"
            ? f.backup.inventoryPath
            : f.restoreEvidence.evidencePath,
        "changed",
      );
    else {
      if (mutation === "operation") f.evidence.operationId = "11111111-1111-4111-8111-111111111111";
      if (mutation === "target") f.evidence.target = { ...f.identity.target, hostId: "other" };
      if (mutation === "snapshot") f.evidence.snapshotId = "AAAA";
      if (mutation === "fence") {
        f.evidence.fence = structuredClone(f.evidence.fence);
        f.evidence.fence.before.fenceId = "other";
      }
      if (mutation === "runtime")
        f.evidence.runtime = { ...f.evidence.runtime, image: `sha256:${"1".repeat(64)}` };
      if (mutation === "producer") f.evidence.executorSha = "1".repeat(40);
      if (mutation === "provenance") f.evidence.provenance = "live-source";
      if (mutation === "incomplete") f.evidence.status = "recovery-required";
      if (mutation === "cleanup") f.evidence.cleanup.verified = false;
      if (mutation === "future")
        f.evidence.completedAt = new Date(Date.now() + 10000).toISOString();
      if (mutation === "pre-fence") f.document.startedAt = "2020-01-01T00:00:00.000Z";
      await f.publish();
    }
    await withHostState(f.root, async (store) => {
      await atBackup(store, f.identity);
      await assert.rejects(async () =>
        store.complete("backup-verified", await verifyBackupGate(f)),
      );
      const state = await store.read();
      assert.equal(state.current.status, "entered");
      assert.equal(state.current.backup, null);
      await assert.rejects(store.enter("migrating"));
    });
  });
}

test("backup admission verifies a complete inventory above the control-file capacity", async (t) => {
  const f = await preparedFixture(t);
  for (let n = 0; n < 9000; n++)
    f.document.inventory.tables.push({
      schema: "public",
      name: `large_${n}`,
      count: "0",
      sha256: "f".repeat(64),
    });
  assert.ok(Buffer.byteLength(canonical(f.document)) > 1051095);
  f.evidence.restoredInventorySha256 = digest(f.document.inventory);
  await f.publish();
  assert.equal((await verifyBackupGate(f)).archiveSha256, f.backup.archiveSha256);
  await appendFile(f.backup.inventoryPath, " ");
  await assert.rejects(verifyBackupGate(f));
});

test("catalog rows cannot pass backup gate without full ledger snapshot evidence", async (t) => {
  const f = await preparedFixture(t);
  f.document.inventory.tables.push({
    schema: "public",
    name: "release_catalog_receipts",
    count: "1",
    sha256: "a".repeat(64),
  });
  await f.publish();
  await assert.rejects(verifyBackupGate(f));
});

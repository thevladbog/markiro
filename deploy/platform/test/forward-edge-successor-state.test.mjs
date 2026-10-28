import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { forwardEdgeSuccessorFixture } from "./forward-edge-successor-fixture.mjs";
import { forwardPrepared } from "./forward-fixture.mjs";
import { forwardMetadata } from "./forward-state-fixture.mjs";
import { withForwardPreparationState, forwardPhaseReceipt } from "../host/forward-state.mjs";
import { forwardImmediatePredecessor } from "../host/forward-history.mjs";
import { withForwardBackupRuntime, readBackupRuntime } from "../backup/local-runtime.mjs";
import { forwardRuntimeDescriptor } from "./forward-backup-fixture.mjs";
const options = (f) => ({
  now: () => f.now,
  productMigrationProof: f.productMigrationProof,
  verifyBaseline: async () => {},
  renameIndex: async ({ root, destination, checkpoint }) => {
    await checkpoint("before-rename");
    await rename(join(root, "upgrade-index.json"), join(root, destination));
    for (const p of ["after-rename", "source-parent-synced", "archive-parent-synced"])
      await checkpoint(p);
    return forwardMetadata(join(root, destination));
  },
});
const open = (f, fn, patch = {}) =>
  withForwardPreparationState(f.root, f.input, fn, { ...options(f), ...patch });
async function backupEntry(f, store) {
  const p = forwardPrepared(f);
  await store.complete("admitted", p.sourceRuntime);
  await store.enter("source-held");
  await store.complete("source-held");
  await store.enter("backup-verified");
  return p;
}
test("failed edge successor durably hands off only the current index and preserves every predecessor", async (t) => {
  const f = await forwardEdgeSuccessorFixture(t),
    oldIndex = await forwardMetadata(join(f.root, "upgrade-index.json")),
    oldState = Buffer.from(f.failedEdgeBytes.state);
  assert.deepEqual(forwardImmediatePredecessor(f.input), f.input.priorEdge);
  assert.equal(forwardPhaseReceipt(f.input).priorSha256, f.input.priorEdge.hashes.state);
  await open(f, async (store) => {
    const p = await backupEntry(f, store);
    await store.complete("backup-verified", p.backup, p.preparation);
  });
  const dir = join(f.root, "forward-recovery-operations", f.input.identity.operationId),
    current = JSON.parse(await readFile(join(dir, "state.json")));
  assert.equal(current.sequence, 6);
  assert.equal(current.phase, "backup-verified");
  assert.deepEqual(current.sourceRuntime.containers, f.sourceIds);
  assert.ok(
    (
      await readFile(
        join(f.root, "forward-recovery-operations", f.prior.identity.operationId, "state.json"),
      )
    ).equals(oldState),
  );
  assert.ok((await readFile(join(dir, "predecessor-index.json"))).equals(f.failedEdgeBytes.index));
  const after = await forwardMetadata(join(dir, "predecessor-index.json"));
  for (const k of ["dev", "ino", "uid", "gid", "mode", "size", "mtimeNs"])
    assert.equal(after[k], oldIndex[k]);
  await assert.rejects(open(f, () => assert.fail("consumed prepare replay")));
});
for (const point of ["before-rename", "after-rename", "success-written"])
  test(`failed edge successor retains uncertainty at ${point}`, async (t) => {
    const f = await forwardEdgeSuccessorFixture(t);
    let effects = false;
    await assert.rejects(
      open(
        f,
        () => {
          effects = true;
        },
        {
          checkpoint: async (name) => {
            if (name === point) throw Error("controlled handoff failure");
          },
        },
      ),
      (e) => e.durabilityUncertain === true,
    );
    assert.equal(effects, false);
    assert.ok(await readFile(join(f.root, ".deploy.lock")));
  });
test("new backup capability keeps all older runtime descriptors and refuses changed current failed-parent runtime", async (t) => {
  const f = await forwardEdgeSuccessorFixture(t),
    own = f.input.identity.operationId;
  await f.put(
    join(f.root, `forward-backup-runtime-${own}.json`),
    forwardRuntimeDescriptor(f.input.identity.executorSha),
  );
  let checked = false;
  await assert.rejects(
    open(f, async (store) => {
      await backupEntry(f, store);
      await store.guard((cap) =>
        withForwardBackupRuntime(cap, async (_held, runtime) => {
          assert.equal(
            JSON.parse(await readBackupRuntime(f.root, own, runtime)).executorSha,
            f.input.identity.executorSha,
          );
          await f.put(
            join(f.root, `forward-backup-runtime-${f.prior.identity.operationId}.json`),
            forwardRuntimeDescriptor("e".repeat(40)),
          );
          await assert.rejects(readBackupRuntime(f.root, own, runtime));
          checked = true;
          throw Error("end controlled fixture");
        }),
      );
    }),
  );
  assert.equal(checked, true);
});

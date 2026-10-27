import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { forwardActivationSuccessorFixture } from "./forward-activation-successor-fixture.mjs";
import { forwardPrepared } from "./forward-fixture.mjs";
import { forwardMetadata } from "./forward-state-fixture.mjs";
import { withForwardPreparationState, forwardPhaseReceipt } from "../host/forward-state.mjs";
import { forwardImmediatePredecessor } from "../host/forward-history.mjs";
import { forwardRuntimeDescriptor } from "./forward-backup-fixture.mjs";
import { withForwardBackupRuntime, readBackupRuntime } from "../backup/local-runtime.mjs";
const options = (f) => ({
  now: () => f.now,
  productMigrationProof: f.productMigrationProof,
  verifyBaseline: async () => {},
  renameIndex: async ({ root, destination, checkpoint }) => {
    await checkpoint("before-rename");
    await rename(join(root, "upgrade-index.json"), join(root, destination));
    for (const point of ["after-rename", "source-parent-synced", "archive-parent-synced"])
      await checkpoint(point);
    return forwardMetadata(join(root, destination));
  },
});
const prepare = (f, callback, patch = {}) =>
  withForwardPreparationState(f.root, f.input, callback, { ...options(f), ...patch });
async function backupEntry(f, store) {
  const p = forwardPrepared(f);
  await store.complete("admitted", p.sourceRuntime);
  await store.enter("source-held");
  await store.complete("source-held");
  await store.enter("backup-verified");
  return p;
}
test("activation successor hands off the exact current index and preserves both failed generations", async (t) => {
  const f = await forwardActivationSuccessorFixture(t),
    oldIndex = await forwardMetadata(join(f.root, "upgrade-index.json"));
  const oldState = await readFile(
    join(f.root, "forward-recovery-operations", f.prior.identity.operationId, "state.json"),
  );
  assert.deepEqual(forwardImmediatePredecessor(f.input), f.input.priorActivation);
  assert.equal(forwardPhaseReceipt(f.input).priorSha256, f.input.priorActivation.hashes.state);
  await prepare(f, async (store) => {
    const p = await backupEntry(f, store);
    await store.complete("backup-verified", p.backup, p.preparation);
  });
  const dir = join(f.root, "forward-recovery-operations", f.input.identity.operationId);
  const archived = await forwardMetadata(join(dir, "predecessor-index.json"));
  for (const key of ["dev", "ino", "uid", "gid", "mode", "size", "mtimeNs"])
    assert.equal(archived[key], oldIndex[key]);
  assert.deepEqual(
    await readFile(join(dir, "predecessor-index.json")),
    f.failedActivationBytes.index,
  );
  assert.deepEqual(
    await readFile(
      join(f.root, "forward-recovery-operations", f.prior.identity.operationId, "state.json"),
    ),
    oldState,
  );
  const current = JSON.parse(await readFile(join(dir, "state.json")));
  assert.equal(current.sequence, 6);
  assert.equal(current.phase, "backup-verified");
  assert.deepEqual(current.sourceRuntime.schema, f.input.baseline.schema);
  assert.equal(
    JSON.parse(await readFile(join(f.root, "upgrade-index.json"))).predecessorIndexSha256,
    f.input.priorActivation.hashes.index,
  );
  await assert.rejects(prepare(f, () => assert.fail("consumed preparation replay")));
});
for (const point of ["before-rename", "after-rename", "success-written"])
  test(`activation successor preserves uncertainty at ${point}`, async (t) => {
    const f = await forwardActivationSuccessorFixture(t);
    let called = false;
    await assert.rejects(
      prepare(
        f,
        () => {
          called = true;
        },
        {
          checkpoint: async (name) => {
            if (name === point) throw Error("synthetic handoff failure");
          },
        },
      ),
      (e) => e.durabilityUncertain === true,
    );
    assert.equal(called, false);
    assert.ok(await readFile(join(f.root, ".deploy.lock")));
    await assert.rejects(prepare(f, () => assert.fail("second producer")));
  });
test("changed failed activation bytes invalidate a held successor before effects", async (t) => {
  const f = await forwardActivationSuccessorFixture(t);
  let effect = false;
  await assert.rejects(
    prepare(f, async (store) => {
      await f.put(join(f.activationDirectory, "command-started.json"), {});
      await store.guard(() => {
        effect = true;
      });
    }),
  );
  assert.equal(effect, false);
  assert.ok(await readFile(join(f.root, ".deploy.lock")));
});
test("new backup capability binds its own descriptor and retains older forward descriptors", async (t) => {
  const f = await forwardActivationSuccessorFixture(t),
    own = f.input.identity.operationId;
  let entered = false,
    ownRead = false,
    olderRefused = false;
  await f.put(
    join(f.root, `forward-backup-runtime-${own}.json`),
    forwardRuntimeDescriptor(f.input.identity.executorSha),
  );
  await assert.rejects(
    prepare(f, async (store) => {
      await backupEntry(f, store);
      await store.guard((cap) =>
        withForwardBackupRuntime(cap, async (held, runtime) => {
          entered = true;
          assert.equal(held.state.admission.kind, "platform-forward-activation-successor");
          assert.equal(
            JSON.parse(await readBackupRuntime(f.root, own, runtime)).executorSha,
            f.input.identity.executorSha,
          );
          ownRead = true;
          const older = JSON.parse(f.failedForwardBytes.state).admission.identity;
          await f.put(
            join(f.root, `forward-backup-runtime-${older.operationId}.json`),
            forwardRuntimeDescriptor("2".repeat(40)),
          );
          await assert.rejects(readBackupRuntime(f.root, own, runtime));
          olderRefused = true;
          throw Error("end synthetic test with retained failure");
        }),
      );
    }),
  );
  assert.equal(entered, true);
  assert.equal(ownRead, true);
  assert.equal(olderRefused, true);
});

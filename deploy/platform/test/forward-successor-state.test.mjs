import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rename, lstat } from "node:fs/promises";
import { join } from "node:path";
import { forwardSuccessorFixture } from "./forward-successor-fixture.mjs";
import { forwardMetadata } from "./forward-state-fixture.mjs";
import { forwardPrepared, forwardDecision } from "./forward-fixture.mjs";
import {
  withForwardPreparationState,
  withForwardActivationState,
  forwardPhaseReceipt,
} from "../host/forward-state.mjs";
const options = (f) => ({
  now: () => Date.now(),
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
test("successor directly archives immediate forward index and completes separate protected phases", async (t) => {
  const f = await forwardSuccessorFixture(t),
    before = await forwardMetadata(join(f.root, "upgrade-index.json"));
  const priorState = await f.read(
      `forward-recovery-operations/${f.prior.identity.operationId}/state.json`,
    ),
    priorArchive = await f.read(
      `forward-recovery-operations/${f.prior.identity.operationId}/predecessor-index.json`,
    );
  assert.equal(forwardPhaseReceipt(f.input).priorSha256, f.input.priorForward.hashes.state);
  await prepare(f, async (store) => {
    const p = forwardPrepared(f);
    await store.complete("admitted", p.sourceRuntime);
    await store.enter("source-held");
    await store.complete("source-held");
    await store.enter("backup-verified");
    await store.complete("backup-verified", p.backup, p.preparation);
  });
  const dir = join(f.root, "forward-recovery-operations", f.input.identity.operationId),
    archived = await forwardMetadata(join(dir, "predecessor-index.json"));
  for (const k of ["dev", "ino", "uid", "gid", "mode", "size", "mtimeNs"])
    assert.equal(archived[k], before[k]);
  assert.deepEqual(await readFile(join(dir, "predecessor-index.json")), f.failedForwardBytes.index);
  const index = JSON.parse(await f.read("upgrade-index.json")),
    intent = JSON.parse(await readFile(join(dir, "handoff-intent.json")));
  assert.equal(index.predecessorIndexSha256, f.input.priorForward.hashes.index);
  assert.equal(intent.failedOperationId, f.prior.identity.operationId);
  assert.equal(intent.expectedSha256, f.input.priorForward.hashes.index);
  const prepared = JSON.parse(await readFile(join(dir, "state.json"))),
    decision = forwardDecision(f, prepared);
  decision.expiresAt = new Date(Date.now() + 1800000).toISOString();
  await withForwardActivationState(
    f.root,
    decision,
    async (store) => {
      for (const phase of ["activation-admitted", "api-started", "edge-started", "healthy"]) {
        if (phase !== "activation-admitted") await store.enter(phase);
        await store.complete(phase);
      }
    },
    options(f),
  );
  assert.equal(JSON.parse(await readFile(join(dir, "state.json"))).sequence, 14);
  assert.deepEqual(
    await f.read(`forward-recovery-operations/${f.prior.identity.operationId}/state.json`),
    priorState,
  );
  assert.deepEqual(
    await f.read(
      `forward-recovery-operations/${f.prior.identity.operationId}/predecessor-index.json`,
    ),
    priorArchive,
  );
  await assert.rejects(prepare(f, () => assert.fail("replay")));
});
for (const point of [
  "intent-written",
  "before-rename",
  "after-rename",
  "source-parent-synced",
  "archive-parent-synced",
  "archive-verified",
  "state-written",
  "index-written",
  "ownership-verified",
  "success-written",
])
  test(`successor uncertainty retains lock at ${point}`, async (t) => {
    const f = await forwardSuccessorFixture(t);
    let called = false;
    await assert.rejects(
      prepare(
        f,
        () => {
          called = true;
        },
        {
          checkpoint: async (name) => {
            if (name === point) throw new Error("synthetic checkpoint");
          },
        },
      ),
      (e) => e.durabilityUncertain === true,
    );
    assert.equal(called, false);
    assert.ok((await lstat(join(f.root, ".deploy.lock"))).isFile());
    await assert.rejects(prepare(f, () => assert.fail("second producer")));
  });
test("changed prior operation is denied before ownership handoff", async (t) => {
  const f = await forwardSuccessorFixture(t),
    before = await f.read("upgrade-index.json");
  await f.put(join(f.directory, "operation.json"), {});
  await assert.rejects(prepare(f, () => assert.fail("foreign input")));
  assert.deepEqual(await f.read("upgrade-index.json"), before);
});

test("unconfirmed producer refuses successor and retains common lock before handoff", async (t) => {
  const f = await forwardSuccessorFixture(t),
    before = await f.read("upgrade-index.json");
  await assert.rejects(
    prepare(f, () => assert.fail("producer conflict"), {
      verifyBaseline: async () => {
        throw Object.assign(new Error("unknown owned child"), { terminationConfirmed: false });
      },
    }),
    (e) => e.durabilityUncertain === true,
  );
  assert.deepEqual(await f.read("upgrade-index.json"), before);
  assert.ok(await lstat(join(f.root, ".deploy.lock")));
});
test("prior mutation during successor capability invalidates authority and retains lock", async (t) => {
  const f = await forwardSuccessorFixture(t);
  await assert.rejects(
    prepare(f, async (store) => {
      await f.put(join(f.directory, "execution-fence.json"), {});
      await store.guard(() => assert.fail("changed predecessor"));
    }),
    (e) => e.durabilityUncertain === true,
  );
  assert.ok(await lstat(join(f.root, ".deploy.lock")));
});
test("successor backup capability selects its own runtime and retains the immediate predecessor descriptor", async (t) => {
  const { withForwardBackupRuntime, readBackupRuntime } =
    await import("../backup/local-runtime.mjs");
  const { forwardRuntimeDescriptor } = await import("./forward-backup-fixture.mjs");
  const f = await forwardSuccessorFixture(t),
    name = `forward-backup-runtime-${f.input.identity.operationId}.json`;
  await f.put(join(f.root, name), forwardRuntimeDescriptor(f.input.identity.executorSha));
  const prior = await f.read(`forward-backup-runtime-${f.prior.identity.operationId}.json`);
  await prepare(f, async (store) => {
    await store.complete("admitted", forwardPrepared(f).sourceRuntime);
    await store.enter("source-held");
    await store.complete("source-held");
    await store.enter("backup-verified");
    await store.guard((cap) =>
      withForwardBackupRuntime(cap, async (held, context) => {
        assert.equal(held.state.admission.kind, "platform-forward-admission-successor");
        assert.deepEqual(
          await readBackupRuntime(f.root, f.input.identity.operationId, context),
          await f.read(name),
        );
      }),
    );
  });
  assert.deepEqual(
    await f.read(`forward-backup-runtime-${f.prior.identity.operationId}.json`),
    prior,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { forwardActivationSuccessorFixture } from "./forward-activation-successor-fixture.mjs";
import { forwardPrepared, forwardDecision } from "./forward-fixture.mjs";
import { forwardMetadata } from "./forward-state-fixture.mjs";
import {
  withForwardPreparationState,
  withForwardActivationState,
  withHeldForwardState,
} from "../host/forward-state.mjs";
const options = (f) => ({
  now: () => f.now,
  productMigrationProof: f.productMigrationProof,
  verifyBaseline: async () => {},
  renameIndex: async ({ root, destination, checkpoint }) => {
    await checkpoint("before-rename");
    await fs.rename(join(root, "upgrade-index.json"), join(root, destination));
    for (const point of ["after-rename", "source-parent-synced", "archive-parent-synced"])
      await checkpoint(point);
    return forwardMetadata(join(root, destination));
  },
});
const prepare = (f, action) => withForwardPreparationState(f.root, f.input, action, options(f));
const historyPath = (f) =>
  join(f.root, "forward-recovery-operations", f.prior.identity.operationId, "state.json");
const ownPath = (f) =>
  join(f.root, "forward-recovery-operations", f.input.identity.operationId, "state.json");
async function prepared(f) {
  await prepare(f, async (s) => {
    const p = forwardPrepared(f);
    await s.complete("admitted", p.sourceRuntime);
    await s.enter("source-held");
    await s.complete("source-held");
    await s.enter("backup-verified");
    await s.complete("backup-verified", p.backup, p.preparation);
  });
  return JSON.parse(await fs.readFile(ownPath(f)));
}
for (const activation of [false, true])
  test(`one fresh history scan per ${activation ? "activation" : "prepare"} capability verification`, async (t) => {
    const f = await forwardActivationSuccessorFixture(t);
    const prior = activation ? await prepared(f) : null;
    const enter = activation
      ? (fn) => withForwardActivationState(f.root, forwardDecision(f, prior), fn, options(f))
      : (fn) => prepare(f, fn);
    let reads = 0;
    await enter((s) =>
      s.guard((cap) =>
        withHeldForwardState(cap, async (held) => {
          await held.verify();
          const open = fs.open;
          const spy = t.mock.method(fs, "open", (...args) => {
            if (args[0] === historyPath(f)) reads++;
            return open(...args);
          });
          syncBuiltinESMExports();
          try {
            await held.verify();
          } finally {
            spy.mock.restore();
            syncBuiltinESMExports();
          }
          // The complete immutable chain is still read on EVERY verification, but
          // it must not be scanned again just to validate another invariant.
          const now = f.now;
          f.now = Date.parse(f.input.expiresAt);
          try {
            await assert.rejects(held.verify());
          } finally {
            f.now = now;
          }
          await held.verify();
        }),
      ),
    );
    assert.equal(reads, 1);
  });
for (const boundary of ["between-actions", "held-recheck", "post-action", "cleanup"])
  test(`fresh history refuses tampering at ${boundary} and preserves the lock`, async (t) => {
    const f = await forwardActivationSuccessorFixture(t);
    let entered = false,
      effect = false;
    await assert.rejects(
      prepare(f, async (s) => {
        await s.guard((cap) => withHeldForwardState(cap, (held) => held.verify()));
        if (boundary === "between-actions") {
          await f.put(historyPath(f), {});
          await s.guard(() => {
            effect = true;
          });
          return;
        }
        if (boundary === "cleanup") await s.fail();
        await s[boundary === "cleanup" ? "cleanup" : "guard"]((cap) =>
          withHeldForwardState(cap, async (held) => {
            entered = true;
            await held.verify();
            await f.put(historyPath(f), {});
            if (boundary !== "post-action") {
              await held.verify();
              effect = true;
            }
          }),
        );
        effect = true;
      }),
      (error) => error.durabilityUncertain === true,
    );
    assert.equal(entered, boundary !== "between-actions");
    assert.equal(effect, false);
    assert.ok(await fs.readFile(join(f.root, ".deploy.lock")));
  });
test("held verification rechecks historical installed bytes before another effect", async (t) => {
  const f = await forwardActivationSuccessorFixture(t);
  let entered = false,
    effect = false;
  await assert.rejects(
    prepare(f, (s) =>
      s.guard((cap) =>
        withHeldForwardState(cap, async (held) => {
          entered = true;
          await held.verify();
          await fs.appendFile(
            join(
              dirname(f.root),
              "upgrade-bootstrap",
              f.prior.identity.executorSha,
              "deploy/platform/host/probe-worker.mjs",
            ),
            "\n// changed source\n",
          );
          await held.verify();
          effect = true;
        }),
      ),
    ),
    (error) => error.durabilityUncertain === true,
  );
  assert.equal(entered, true);
  assert.equal(effect, false);
  assert.ok(await fs.readFile(join(f.root, ".deploy.lock")));
});
test("fail refuses changed history without rewriting the journal or index", async (t) => {
  const f = await forwardActivationSuccessorFixture(t);
  let inspected = false;
  await assert.rejects(
    prepare(f, async (s) => {
      const state = await fs.readFile(ownPath(f));
      const index = await fs.readFile(join(f.root, "upgrade-index.json"));
      await f.put(historyPath(f), {});
      await assert.rejects(s.fail(), (error) => error.durabilityUncertain === true);
      assert.deepEqual(await fs.readFile(ownPath(f)), state);
      assert.deepEqual(await fs.readFile(join(f.root, "upgrade-index.json")), index);
      inspected = true;
      await s.guard(() => assert.fail("changed history must remain refused"));
    }),
    (error) => error.durabilityUncertain === true,
  );
  assert.equal(inspected, true);
  assert.ok(await fs.readFile(join(f.root, ".deploy.lock")));
});

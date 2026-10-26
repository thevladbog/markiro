import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  withForwardBackupRuntime,
  withUpgradeBackupRuntime,
  readBackupRuntime,
} from "../backup/local-runtime.mjs";
import { withForwardPreparationState } from "../host/forward-state.mjs";
import { forwardStateFixture } from "./forward-state-fixture.mjs";
import { forwardPrepared } from "./forward-fixture.mjs";
import {
  forwardRuntimeDescriptor as descriptor,
  provisionForwardRuntimes,
} from "./forward-backup-fixture.mjs";
const open = (f, action) => withForwardPreparationState(f.root, f.input, action, f.options);
const reach = async (f, s) => {
  await s.complete("admitted", forwardPrepared(f).sourceRuntime);
  await s.enter("source-held");
  await s.complete("source-held");
  await s.enter("backup-verified");
};
test("forward runtime consumes only entered post-migration backup capability and preserves all old descriptors", async (t) => {
  const f = await forwardStateFixture(t),
    { originals, name } = await provisionForwardRuntimes(f);
  let expired;
  await open(f, async (s) => {
    await reach(f, s);
    await s.guard((cap) =>
      assert.rejects(
        withUpgradeBackupRuntime(cap, () => assert.fail("old migration=false guard bypass")),
      ),
    );
    await s.guard((cap) =>
      withForwardBackupRuntime(cap, async (held, context) => {
        expired = context;
        assert.equal(held.state.migrationEntered, true);
        assert.equal(held.state.sequence, 5);
        assert.deepEqual(
          await readBackupRuntime(f.root, f.input.identity.operationId, context),
          await readFile(join(f.root, name)),
        );
      }),
    );
    await assert.rejects(readBackupRuntime(f.root, f.input.identity.operationId, expired));
  });
  for (const [path, value] of Object.entries(originals))
    assert.equal(await readFile(join(f.root, path), "utf8"), JSON.stringify(value));
});
for (const kind of [
  "forged",
  "wrong-phase",
  "wrong-executor",
  "wrong-provenance",
  "changed-original",
  "changed-recovery",
  "changed-failed",
  "changed-current",
  "expired",
])
  test(`forward runtime rejects ${kind}`, async (t) => {
    const f = await forwardStateFixture(t),
      { name } = await provisionForwardRuntimes(f);
    await open(f, async (s) => {
      if (kind !== "wrong-phase") await reach(f, s);
      if (kind === "forged") {
        await assert.rejects(withForwardBackupRuntime({}, () => assert.fail("forged")));
        return;
      }
      if (kind === "wrong-executor" || kind === "wrong-provenance") {
        const value = descriptor(f.input.identity.executorSha);
        if (kind === "wrong-executor") value.executorSha = "a".repeat(40);
        else value.provenance = "fixture";
        await writeFile(join(f.root, name), JSON.stringify(value), { mode: 0o600 });
        await assert.rejects(
          s.guard((cap) => withForwardBackupRuntime(cap, () => assert.fail("unproved worker"))),
        );
        return;
      }
      if (kind === "wrong-phase") {
        await assert.rejects(
          s.guard((cap) => withForwardBackupRuntime(cap, () => assert.fail("phase bypass"))),
        );
        return;
      }
      let entered = false;
      await s
        .guard((cap) =>
          withForwardBackupRuntime(cap, async (_held, context) => {
            entered = true;
            const paths = {
              "changed-original": "backup-runtime.json",
              "changed-recovery": `recovery-backup-runtime-${f.input.originalPredecessor.identity.operationId}.json`,
              "changed-failed": `upgrade-backup-runtime-${f.input.failed.identity.operationId}.json`,
              "changed-current": name,
            };
            if (kind === "expired") f.clock.now = Date.parse(f.input.expiresAt);
            else await writeFile(join(f.root, paths[kind]), "{}", { mode: 0o600 });
            await assert.rejects(readBackupRuntime(f.root, f.input.identity.operationId, context));
            if (kind === "expired") f.clock.now--;
          }),
        )
        .catch((error) => {
          if (!kind.startsWith("changed-")) throw error;
        });
      assert.equal(entered, true);
    });
  });

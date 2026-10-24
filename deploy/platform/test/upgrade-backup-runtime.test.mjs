import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withUpgradeBackupRuntime, readBackupRuntime } from "../backup/local-runtime.mjs";
import { withUpgradeState } from "../host/upgrade-state.mjs";
import { upgradeObservationFixture } from "./upgrade-observation-fixture.mjs";
import { upgradeOldRuntime } from "./upgrade-fixture.mjs";
const runtime = (executorSha) => ({
  version: 1,
  executorSha,
  dockerExecutable: "/usr/bin/docker",
  endpoint: "unix:///var/run/docker.sock",
  image: `sha256:${"e".repeat(64)}`,
  provenance: "live-source",
});
async function fixture(t) {
  const f = await upgradeObservationFixture(t);
  const originals = {
    "backup-runtime.json": runtime(f.records.original.current.identity.executorSha),
    [`recovery-backup-runtime-${f.input.predecessor.identity.operationId}.json`]: runtime(
      f.input.predecessor.identity.executorSha,
    ),
  };
  const name = `upgrade-backup-runtime-${f.input.identity.operationId}.json`;
  for (const [path, value] of Object.entries({
    ...originals,
    [name]: runtime(f.input.identity.executorSha),
  }))
    await writeFile(join(f.root, path), JSON.stringify(value), { mode: 0o600 });
  return { ...f, originals, name };
}
async function prepared(store, f) {
  await store.complete("admitted", upgradeOldRuntime(f.input));
  await store.enter("old-stopped");
  await store.complete("old-stopped");
  await store.enter("backup-verified");
}
test("upgrade backup runtime is separately provisioned, preserves historical runtimes, and expires", async (t) => {
  const f = await fixture(t);
  let retained;
  await withUpgradeState(
    f.root,
    f.input,
    async (store) => {
      await prepared(store, f);
      await store.guard((cap) =>
        withUpgradeBackupRuntime(cap, async (held, runtimeContext) => {
          retained = runtimeContext;
          assert.equal(held.state.phase, "backup-verified");
          const bytes = await readBackupRuntime(
            f.root,
            f.input.identity.operationId,
            runtimeContext,
          );
          assert.equal(JSON.parse(bytes).executorSha, f.input.identity.executorSha);
        }),
      );
      await assert.rejects(readBackupRuntime(f.root, f.input.identity.operationId, retained));
    },
    { now: () => f.now },
  );
  for (const [name, value] of Object.entries(f.originals))
    assert.equal(await readFile(join(f.root, name), "utf8"), JSON.stringify(value));
});
for (const mode of [
  "forged",
  "wrong-phase",
  "wrong-executor",
  "changed-original",
  "changed-recovery",
  "changed-current",
  "expired",
])
  test(`upgrade backup runtime rejects ${mode}`, async (t) => {
    const f = await fixture(t);
    if (mode === "wrong-executor")
      await writeFile(join(f.root, f.name), JSON.stringify(runtime("a".repeat(40))));
    await withUpgradeState(
      f.root,
      f.input,
      async (store) => {
        if (mode !== "wrong-phase") await prepared(store, f);
        await assert.rejects(
          store.guard((cap) =>
            withUpgradeBackupRuntime(mode === "forged" ? {} : cap, async (held, token) => {
              const changed = {
                "changed-original": "backup-runtime.json",
                "changed-recovery": `recovery-backup-runtime-${f.input.predecessor.identity.operationId}.json`,
                "changed-current": f.name,
              }[mode];
              if (changed) await appendFile(join(f.root, changed), " ");
              if (mode === "expired") f.now = Date.parse(f.input.expiresAt);
              await readBackupRuntime(f.root, f.input.identity.operationId, token);
            }),
          ),
        );
      },
      { now: () => f.now },
    );
  });

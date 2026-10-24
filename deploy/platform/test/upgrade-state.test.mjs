import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withUpgradeState } from "../host/upgrade-state.mjs";
import { withHostState, withHeldHostState } from "../host/state.mjs";
import { privateFixture, backupProof } from "./host-fixtures.mjs";
import {
  upgradeFixture,
  upgradeBytes,
  upgradeHash,
  upgradeOldRuntime,
  upgradePreparation,
} from "./upgrade-fixture.mjs";

async function fixture(t) {
  const { root: parent } = await privateFixture(t);
  const root = join(parent, "state");
  await mkdir(root, { mode: 0o700 });
  const f = upgradeFixture();
  const recoveredId = f.input.predecessor.identity.operationId;
  const activationRoot = join(parent, "recovery-operations", recoveredId, "activate");
  await mkdir(activationRoot, { recursive: true, mode: 0o700 });
  const files = {
    original: join(root, "state.json"),
    acceptedRecovery: join(root, "recovery-state.json"),
    preparation: join(root, "recovery-preparation.json"),
    consumption: join(root, `recovery-activation-${recoveredId}.json`),
    activationOperation: join(activationRoot, "operation.json"),
  };
  // The retained operation path is byte-bound to this isolated state root.
  f.records.activationOperation.operation.root = root;
  f.records.activationOperation.operation.dockerConfig = join(root, "docker");
  f.predecessorBytes.activationOperation = upgradeBytes(f.records.activationOperation);
  f.input.predecessor.hashes.activationOperation = upgradeHash(
    f.predecessorBytes.activationOperation,
  );
  for (const [name, path] of Object.entries(files))
    await writeFile(path, f.predecessorBytes[name], { mode: 0o600 });
  return { ...f, parent, root, files };
}
const run = (f, callback, now = () => f.now) =>
  withUpgradeState(f.root, f.input, callback, { now });
const journalPath = (f) =>
  join(f.root, "upgrade-operations", f.input.identity.operationId, "state.json");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
async function unchanged(f) {
  for (const [name, path] of Object.entries(f.files))
    assert.deepEqual(await readFile(path), f.predecessorBytes[name]);
}
async function prepare(store, identity) {
  const input = (await store.read()).admission;
  await store.complete("admitted", upgradeOldRuntime(input));
  await store.enter("old-stopped");
  await store.complete("old-stopped");
  await store.enter("backup-verified");
  await store.complete("backup-verified", backupProof(identity), upgradePreparation(input));
}

test("durable index and consumption precede first guarded action; predecessor stays exact", async (t) => {
  const f = await fixture(t);
  let retained;
  await run(f, async (store) => {
    retained = store;
    const initial = await store.read();
    assert.equal(initial.phase, "admitted");
    assert.equal(initial.sequence, 1);
    assert.equal(initial.migrationEntered, false);
    await store.guard(async (capability) => {
      const index = await readJson(join(f.root, "upgrade-index.json"));
      assert.equal(index.operationId, f.input.identity.operationId);
      assert.equal(index.stateSha256, upgradeHash(await readFile(journalPath(f))));
      const consumed = await readJson(
        join(
          f.root,
          "upgrade-operations",
          f.input.identity.operationId,
          "prepare-consumption.json",
        ),
      );
      assert.deepEqual(consumed.dispatch, f.input.dispatch);
      await withHeldHostState(capability, async (held) => {
        assert.equal(held.root, f.root);
        assert.equal(held.state.current.status, "recovery-required");
      });
    });
    await assert.rejects(withHostState(f.root, () => assert.fail("parallel owner")));
    await prepare(store, f.input.identity);
    assert.equal((await store.read()).sequence, 6);
    await assert.rejects(store.enter("activation-admitted"));
    await assert.rejects(store.enter("migration-entered"));
  });
  await unchanged(f);
  await assert.rejects(retained.read());
  await assert.rejects(run(f, () => assert.fail("same-operation replay")));
  f.input.identity.operationId = randomUUID();
  await assert.rejects(run(f, () => assert.fail("different UUID bypass")));
  await assert.rejects(lstat(join(f.root, ".deploy.lock")), { code: "ENOENT" });
});

for (const boundary of ["admitted", "old-stopped", "backup-verified"]) {
  test(`known failure at ${boundary} leaves terminal index and no replay`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      run(f, async (store) => {
        if (boundary !== "admitted") {
          await store.complete("admitted", upgradeOldRuntime(f.input));
          await store.enter("old-stopped");
        }
        if (boundary === "backup-verified") {
          await store.complete("old-stopped");
          await store.enter("backup-verified");
        }
        throw new Error("synthetic failure");
      }),
    );
    const state = await readJson(journalPath(f));
    assert.equal(state.status, "recovery-required");
    assert.equal(state.phase, boundary);
    assert.equal(state.migrationEntered, false);
    await unchanged(f);
    f.input.identity.operationId = randomUUID();
    await assert.rejects(run(f, () => assert.fail("bypass failed index")));
  });
}

test("changed retained bytes or journal fence later actions; expiry fences commands", async (t) => {
  for (const change of ["predecessor", "journal", "index", "expiry"]) {
    const f = await fixture(t);
    let now = f.now;
    await assert.rejects(
      run(
        f,
        async (store) => {
          if (change === "expiry") now = Date.parse(f.input.expiresAt);
          else {
            const path =
              change === "predecessor"
                ? f.files.preparation
                : change === "journal"
                  ? journalPath(f)
                  : join(f.root, "upgrade-index.json");
            await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(" ")]));
          }
          await store.guard(() => assert.fail("guard must reject before command"));
        },
        () => now,
      ),
    );
  }
});

test("forgotten uncertain producer drains before release and retains shared lock", async (t) => {
  const f = await fixture(t);
  let drained = false;
  await assert.rejects(
    run(f, async (store) => {
      void store.guard(async (capability) => {
        void withHeldHostState(capability, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          drained = true;
          throw Object.assign(new Error("unconfirmed producer"), { terminationConfirmed: false });
        }).catch(() => {}); // caller observes rejection but does not await/drain it
      });
    }),
  );
  assert.equal(drained, true);
  await lstat(join(f.root, ".deploy.lock"));
  await unchanged(f);
  await assert.rejects(withHostState(f.root, () => assert.fail("uncertain lock bypass")));
});

const moduleUrl = new URL("../host/upgrade-state.mjs", import.meta.url).href;
for (const fault of [
  "index-link",
  "index-sync",
  "consumption-link",
  "consumption-sync",
  "journal-link",
  "journal-sync",
  "journal-replace",
  "index-replace",
]) {
  test(`durable preparation fails closed at ${fault}`, async (t) => {
    const f = await fixture(t);
    const inputPath = join(f.parent, "input.json");
    await writeFile(inputPath, upgradeBytes(f.input), { mode: 0o600 });
    const owner = fork(
      "--input-type=module",
      [
        "--eval",
        `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const root = process.argv[1], inputPath = process.argv[2], fault = ${JSON.stringify(fault)};
      const originalLink = fs.link.bind(fs), originalOpen = fs.open.bind(fs), originalRename = fs.rename.bind(fs);
      let published, indexReplaces = 0;
      fs.rename = async (source, target) => {
        const journal = target.endsWith('/state.json');
        const index = target.endsWith('/upgrade-index.json');
        if (index) indexReplaces++;
        if ((fault === 'journal-replace' && journal) || (fault === 'index-replace' && indexReplaces === 2)) throw new Error('synthetic rename');
        return originalRename(source, target);
      };
      fs.link = async (source, target) => {
        const kind = target.endsWith('/upgrade-index.json') ? 'index' : target.endsWith('/prepare-consumption.json') ? 'consumption' : target.endsWith('/state.json') ? 'journal' : null;
        if (fault === kind + '-link') throw Object.assign(new Error('synthetic I/O'), { code: 'EIO' });
        const result = await originalLink(source, target);
        if (kind) published = kind;
        return result;
      };
      fs.open = async (...args) => {
        const h = await originalOpen(...args), sync = h.sync.bind(h);
        h.sync = async () => {
          if ((await h.stat()).isDirectory() && fault === published + '-sync') throw new Error('synthetic fsync');
          return sync();
        };
        return h;
      };
      syncBuiltinESMExports();
      const { withUpgradeState } = await import(${JSON.stringify(moduleUrl)});
      let entered = false;
      try {
        await withUpgradeState(root, JSON.parse(await fs.readFile(inputPath)), async (store) => { entered = true; await store.complete('admitted'); }, { now: () => ${f.now} });
        process.send({ success: true, entered });
      } catch (error) { process.send({ code: error.code, uncertain: error.durabilityUncertain, entered }); }
      process.disconnect();
    `,
        f.root,
        inputPath,
      ],
      { silent: true, env: { PATH: "/usr/bin:/bin" } },
    );
    t.after(() => {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    });
    const [result] = await once(owner, "message", { signal: AbortSignal.timeout(10000) });
    assert.equal(result.entered, fault.endsWith("-replace"));
    assert.equal(result.uncertain, true);
    await lstat(join(f.root, ".deploy.lock"));
    await unchanged(f);
  });
}

import assert from "node:assert/strict";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { privateFixture, hostIdentity } from "./host-fixtures.mjs";
import { forwardPrepared, forwardDecision } from "./forward-fixture.mjs";
import { withHostState } from "../host/state.mjs";
import {
  withForwardPreparationState,
  withForwardActivationState,
  withHeldForwardState,
  validateForwardJournal,
} from "../host/forward-state.mjs";
import {
  forwardMetadata as metadata,
  forwardStateFixture as fixture,
} from "./forward-state-fixture.mjs";
const prepare = (f, callback) => withForwardPreparationState(f.root, f.input, callback, f.options);
const completePrepare = async (f, store) => {
  const p = forwardPrepared(f);
  await store.complete("admitted", p.sourceRuntime);
  await store.enter("source-held");
  await store.complete("source-held");
  await store.enter("backup-verified");
  await store.complete("backup-verified", p.backup, p.preparation);
};
test("forward store preserves original authorities and index inode while publishing phases1..14", async (t) => {
  const f = await fixture(t),
    indexBefore = await metadata(join(f.root, "upgrade-index.json"));
  let stale;
  await prepare(f, async (store) => {
    assert.equal((await store.read()).migrationEntered, true);
    await store.guard((cap) =>
      withHeldForwardState(cap, async (held) => {
        assert.equal(held.state.phase, "admitted");
        stale = cap;
        await held.verify();
      }),
    );
    await completePrepare(f, store);
  });
  await assert.rejects(withHeldForwardState(stale, () => assert.fail("stale capability")));
  const dir = join(f.root, "forward-recovery-operations", f.input.identity.operationId);
  const archived = await metadata(join(dir, "predecessor-index.json"));
  for (const key of ["dev", "ino", "uid", "gid", "mode", "size", "mtimeNs"])
    assert.equal(archived[key], indexBefore[key]);
  const preparedBytes = await readFile(join(dir, "state.json")),
    prior = JSON.parse(preparedBytes),
    decision = forwardDecision(f, prior);
  await withForwardActivationState(
    f.root,
    decision,
    async (store) => {
      for (const phase of ["activation-admitted", "api-started", "edge-started", "healthy"]) {
        if (phase !== "activation-admitted") await store.enter(phase);
        await store.complete(phase);
      }
    },
    f.options,
  );
  const final = JSON.parse(await readFile(join(dir, "state.json")));
  validateForwardJournal(final, prior);
  assert.equal(final.sequence, 14);
  assert.equal(final.migrationEntered, true);
  for (const [path, bytes] of f.retained)
    if (path !== join(f.root, "upgrade-index.json")) assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readFile(join(dir, "before-post-migration-activate.json")), preparedBytes);
  await assert.rejects(prepare(f, () => assert.fail("duplicate prepare")));
  await assert.rejects(
    withForwardActivationState(
      f.root,
      decision,
      () => assert.fail("duplicate activation"),
      f.options,
    ),
  );
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
  test(`handoff uncertainty retains lock and never exposes capability at ${point}`, async (t) => {
    const f = await fixture(t, {
      checkpoint: async (name) => {
        if (name === point) throw new Error("private-handoff-failure");
      },
    });
    let called = false;
    await assert.rejects(
      prepare(f, () => {
        called = true;
      }),
      (e) => e.durabilityUncertain === true,
    );
    assert.equal(called, false);
    assert.ok(await lstat(join(f.root, ".deploy.lock")));
    await assert.rejects(prepare(f, () => assert.fail("uncertain retry")));
  });
test("physical baseline refusal happens before handoff intent", async (t) => {
  const f = await fixture(t, {
    verifyBaseline: async () => {
      throw new Error("physical mismatch");
    },
  });
  await assert.rejects(prepare(f, () => assert.fail("physical guard bypass")));
  assert.deepEqual(await readFile(join(f.root, "upgrade-index.json")), f.failedBytes.index);
});
test("forged and ordinary capabilities cannot enter forward authority", async (t) => {
  await assert.rejects(withHeldForwardState({}, () => assert.fail("forged")));
  const f = await fixture(t);
  await withHostState(f.root, (host) =>
    host.guardPersistence((cap) =>
      assert.rejects(withHeldForwardState(cap, () => assert.fail("ordinary"))),
    ),
  );
});
test("old state write entries reject forward ownership while common read guard remains available", async (t) => {
  const f = await fixture(t);
  await prepare(f, (s) => completePrepare(f, s));
  const original = await readFile(join(f.root, "state.json"));
  await withHostState(f.root, async (host) => {
    await host.guardPersistence(async () => {});
    await assert.rejects(host.fail());
  });
  assert.deepEqual(await readFile(join(f.root, "state.json")), original);
});
test("changed immutable failed history retains lock and blocks a forward producer", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepare(f, async (s) => {
      await writeFile(
        join(f.root, "upgrade-operations", f.input.failed.identity.operationId, "state.json"),
        "{}",
        { mode: 0o600 },
      );
      await s.guard(() => assert.fail("changed history"));
    }),
    (e) => e.durabilityUncertain === true,
  );
  assert.ok(await lstat(join(f.root, ".deploy.lock")));
});
test("simultaneous producers are denied and held verification expires", async (t) => {
  const f = await fixture(t);
  await prepare(f, async (s) => {
    let release, ready;
    const began = new Promise((r) => {
      ready = r;
    });
    const waiting = new Promise((r) => {
      release = r;
    });
    const producer = s.guard((cap) =>
      withHeldForwardState(cap, async () => {
        ready();
        await waiting;
      }),
    );
    await began;
    await assert.rejects(s.read());
    release();
    await producer;
    await s.guard((cap) =>
      withHeldForwardState(cap, async (held) => {
        f.clock.now = Date.parse(f.input.expiresAt);
        await assert.rejects(held.verify());
        f.clock.now--;
      }),
    );
  });
});

test("ordinary entered-state mutation is denied specifically by forward index ownership", async (t) => {
  const f = await privateFixture(t);
  await withHostState(f.root, (s) => s.begin(hostIdentity()));
  const before = await readFile(join(f.root, "state.json"));
  await writeFile(
    join(f.root, "upgrade-index.json"),
    JSON.stringify({ version: 1, kind: "platform-forward-recovery-index" }),
    { mode: 0o600 },
  );
  await withHostState(f.root, async (s) => {
    await s.read();
    await assert.rejects(s.fail());
  });
  assert.deepEqual(await readFile(join(f.root, "state.json")), before);
});
test(
  "forgotten held producer is fully drained before the forward store returns",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    let ready,
      release,
      completed = false;
    const started = new Promise((r) => {
      ready = r;
    });
    const waiting = new Promise((r) => {
      release = r;
    });
    const result = prepare(f, (s) => {
      void s.guard((cap) =>
        withHeldForwardState(cap, async () => {
          ready();
          await waiting;
          completed = true;
        }),
      );
    });
    await Promise.race([
      started,
      result.then(() => assert.fail("forward store returned before its producer began")),
    ]);
    release();
    await result;
    assert.equal(completed, true);
  },
);

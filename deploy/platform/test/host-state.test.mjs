import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withHostState } from "../host/state.mjs";
import { backupProof, hostIdentity, privateFixture } from "./host-fixtures.mjs";

const phases = [
  "admitted",
  "images-verified",
  "target-stopped",
  "backup-verified",
  "migrating",
  "migrated",
  "api-started",
  "edge-started",
  "healthy",
];
const rejected = (error) =>
  error.code === "ERR_HOST_STATE" && error.message === "Host deployment state operation failed.";
async function advance(store, identity, through = "healthy") {
  for (const phase of phases) {
    if (phase !== "admitted") await store.enter(phase);
    await store.complete(phase, ...(phase === "backup-verified" ? [backupProof(identity)] : []));
    if (phase === through) break;
  }
}
const disk = async (root) => JSON.parse(await readFile(join(root, "state.json"), "utf8"));

function child(t, source, args = []) {
  const process = fork("--input-type=module", ["--eval", source, ...args], {
    silent: true,
    env: { PATH: "/usr/bin:/bin" },
  });
  t.after(() => {
    if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
  });
  return process;
}
const moduleUrl = new URL("../host/state.mjs", import.meta.url).href;

test("durable handoff preserves complete healthy identity, immutable inputs and private modes", async (t) => {
  const { root } = await privateFixture(t);
  const identity = hostIdentity();
  const expected = structuredClone(identity);
  await withHostState(root, async (store) => {
    assert.deepEqual(await store.read(), {
      version: 1,
      sequence: 0,
      current: null,
      previousHealthy: null,
    });
    const started = store.begin(identity);
    identity.target.hostId = "mutated";
    await started;
    const clone = await store.read();
    clone.current.identity.target.hostId = "mutated-again";
    await advance(store, expected);
  });
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, "state.json"))).mode & 0o777, 0o600);
  const healthy = (await disk(root)).current;
  assert.deepEqual(healthy, {
    identity: expected,
    phase: "healthy",
    status: "completed",
    backup: backupProof(expected),
  });
  assert.doesNotMatch(
    JSON.stringify(await disk(root)),
    /DATABASE_URL|PLATFORM_AUTH_SECRET|fixture-private-error/,
  );
  assert.equal((await disk(root)).sequence, 18);
  await withHostState(root, async (store) => {
    await assert.rejects(store.begin(expected), rejected);
    const foreign = hostIdentity();
    foreign.target.volumeId = "foreign";
    await assert.rejects(store.begin(foreign), rejected);
    const next = hostIdentity();
    await store.begin(next);
    assert.deepEqual((await store.read()).previousHealthy, healthy);
    assert.equal((await disk(root)).sequence, 19);
  });
});

test("lock excludes nested and distinct processes, and a terminated owner leaves its lock", async (t) => {
  const { root } = await privateFixture(t);
  const owner = child(
    t,
    `import { withHostState } from ${JSON.stringify(moduleUrl)};
    await withHostState(process.argv[1], async () => {
      process.send("locked"); await new Promise(resolve => process.once("message", resolve));
    }); process.send("released"); process.disconnect();`,
    [root],
  );
  assert.deepEqual(
    (await once(owner, "message", { signal: AbortSignal.timeout(10000) }))[0],
    "locked",
  );
  assert.equal((await lstat(join(root, ".deploy.lock"))).mode & 0o777, 0o600);
  await assert.rejects(
    withHostState(root, () => {}),
    rejected,
  );
  owner.send("release");
  assert.deepEqual(
    (await once(owner, "message", { signal: AbortSignal.timeout(10000) }))[0],
    "released",
  );
  await withHostState(root, async () => {
    await assert.rejects(
      withHostState(root, () => {}),
      rejected,
    );
  });
  const killed = child(
    t,
    `import { withHostState } from ${JSON.stringify(moduleUrl)};
    await withHostState(process.argv[1], async () => { process.send("locked"); await new Promise(() => {}); });`,
    [root],
  );
  assert.deepEqual(
    (await once(killed, "message", { signal: AbortSignal.timeout(10000) }))[0],
    "locked",
  );
  const exited = once(killed, "exit");
  killed.kill("SIGKILL");
  assert.equal((await exited)[1], "SIGKILL");
  const before = await readFile(join(root, ".deploy.lock"));
  await assert.rejects(
    withHostState(root, () => {}),
    rejected,
  );
  assert.deepEqual(await readFile(join(root, ".deploy.lock")), before);
});

test("strict reads reject truncated, unknown, symlink and impossible records", async (t) => {
  const mutations = [
    (s) => {
      s.secret = "fixture-private-value";
    },
    (s) => {
      s.current.phase = "unknown";
    },
    (s) => {
      s.current.status = "unknown";
    },
    (s) => {
      s.current.phase = "migrating";
    },
    (s) => {
      s.current.backup = backupProof(s.current.identity);
    },
    (s) => {
      s.sequence = 0;
    },
    (s) => {
      s.previousHealthy = structuredClone(s.current);
    },
    (s) => {
      s.current.identity.admission.registry.api.imageId = "sha256:" + "f".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const { root } = await privateFixture(t);
    await withHostState(root, (store) => store.begin(hostIdentity()));
    const record = await disk(root);
    mutate(record);
    await writeFile(join(root, "state.json"), JSON.stringify(record), { mode: 0o600 });
    await assert.rejects(
      withHostState(root, () => {}),
      rejected,
    );
  }
  for (const kind of ["truncated", "symlink"]) {
    const { root } = await privateFixture(t);
    if (kind === "symlink") await symlink(join(root, "source.env"), join(root, "state.json"));
    else await writeFile(join(root, "state.json"), "{", { mode: 0o600 });
    await assert.rejects(
      withHostState(root, () => {}),
      rejected,
    );
  }
});

test("strict identity rejects every nested admission mismatch and hidden private fields", async (t) => {
  const mutations = [
    (i) => {
      i.operationId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    },
    (i) => {
      i.executorSha += "\n";
    },
    (i) => {
      i.configurationSha256 = "bad";
    },
    (i) => {
      i.target.hostId = "../host";
    },
    (i) => {
      i.admission.extra = "fixture-private-value";
    },
    (i) => {
      i.admission.manifest.serverProfile = "full";
    },
    (i) => {
      i.admission.manifest.sourceSha = "f".repeat(40);
    },
    (i) => {
      i.admission.verified.images.api.extra = "private";
    },
    (i) => {
      i.admission.publisher.runAttempt = "9";
    },
    (i) => {
      i.admission.ci.runId = "9";
    },
    (i) => {
      i.admission.artifact.id = "01";
    },
    (i) => {
      i.admission.registry.edge.platform = "linux/arm64";
    },
    (i) => {
      Object.defineProperty(i, "secret", { value: "private" });
    },
    (i) => {
      i[Symbol("secret")] = "private";
    },
    (i) => {
      Object.defineProperty(i.target, "hostId", {
        enumerable: true,
        get() {
          throw new Error("private");
        },
      });
    },
  ];
  const { root } = await privateFixture(t);
  await withHostState(root, async (store) => {
    for (const mutate of mutations) {
      const identity = hostIdentity();
      mutate(identity);
      await assert.rejects(store.begin(identity), rejected);
      assert.equal((await store.read()).current, null);
    }
  });
});

test("phase order and backup proof binding reject skipping, repeats and foreign proof", async (t) => {
  const { root } = await privateFixture(t);
  const identity = hostIdentity();
  await withHostState(root, async (store) => {
    await assert.rejects(store.enter("images-verified"), rejected);
    await store.begin(identity);
    await assert.rejects(store.enter("images-verified"), rejected);
    await assert.rejects(store.complete("admitted", {}), rejected);
    await store.complete("admitted");
    await assert.rejects(store.complete("admitted"), rejected);
    await assert.rejects(store.enter("target-stopped"), rejected);
    for (const phase of ["images-verified", "target-stopped"]) {
      await store.enter(phase);
      await store.complete(phase);
    }
    await store.enter("backup-verified");
    for (const mutate of [
      (p) => {
        p.target.databaseId = "foreign";
      },
      (p) => {
        p.operationId = hostIdentity().operationId;
      },
      (p) => {
        p.archiveSha256 = "invalid";
      },
      (p) => {
        p.extra = true;
      },
    ]) {
      const proof = backupProof(identity);
      mutate(proof);
      await assert.rejects(store.complete("backup-verified", proof), rejected);
    }
    await assert.rejects(store.complete("backup-verified"), rejected);
    await store.complete("backup-verified", backupProof(identity));
    await store.enter("migrating");
    await store.fail();
    const state = await store.read();
    assert.equal(state.current.phase, "migrating");
    assert.equal(state.current.status, "recovery-required");
    assert.deepEqual(state.current.backup, backupProof(identity));
    await assert.rejects(store.begin(hostIdentity()), rejected);
    await assert.rejects(store.complete("migrating"), rejected);
    await assert.rejects(store.fail(), rejected);
  });
});

for (const [index, phase] of phases.entries())
  for (const boundary of phase === "healthy" ? ["entry"] : ["entry", "completion"]) {
    test(`callback failure at ${phase} ${boundary} leaves durable unresolved state`, async (t) => {
      const { root } = await privateFixture(t);
      const identity = hostIdentity();
      await assert.rejects(
        withHostState(root, async (store) => {
          await store.begin(identity);
          for (let n = 0; n <= index; n++) {
            const current = phases[n];
            if (n) await store.enter(current);
            if (n === index && boundary === "entry") throw new Error("fixture-private-error");
            await store.complete(
              current,
              ...(current === "backup-verified" ? [backupProof(identity)] : []),
            );
          }
          throw new Error("fixture-private-error");
        }),
        rejected,
      );
      const persisted = await disk(root);
      assert.equal(persisted.current.phase, phase);
      assert.equal(persisted.current.status, boundary === "entry" ? "entered" : "completed");
      await withHostState(root, async (store) => {
        assert.deepEqual(await store.read(), persisted);
        await assert.rejects(store.begin(hostIdentity()), rejected);
        await store.fail();
        assert.equal((await disk(root)).current.status, "recovery-required");
      });
    });
  }

test("store lifetime and concurrent calls cannot escape lock ownership", async (t) => {
  const { root } = await privateFixture(t);
  let retained;
  await withHostState(root, async (store) => {
    retained = store;
    const mutation = store.begin(hostIdentity());
    await assert.rejects(store.read(), rejected);
    await assert.rejects(store.begin(hostIdentity()), rejected);
    await mutation;
  });
  for (const method of [
    () => retained.read(),
    () => retained.begin(hostIdentity()),
    () => retained.fail(),
    () => retained.enter("images-verified"),
    () => retained.complete("admitted"),
  ])
    await assert.rejects(method(), rejected);
  const second = await privateFixture(t);
  let launched;
  await withHostState(second.root, (store) => {
    launched = store.begin(hostIdentity());
  });
  await launched;
  assert.equal((await disk(second.root)).sequence, 1);
  await withHostState(second.root, (store) => store.read());
});

test("rename and directory fsync uncertainty latch even when callback catches rejection", async (t) => {
  for (const fault of ["rename", "state-sync", "lock-sync"]) {
    const { root } = await privateFixture(t);
    const owner = child(
      t,
      `
      import fs from "node:fs/promises"; import { syncBuiltinESMExports } from "node:module";
      const root = process.argv[1]; let syncs = 0; const fault = ${JSON.stringify(fault)};
      const originalOpen = fs.open.bind(fs); const originalRename = fs.rename.bind(fs);
      fs.open = async (...args) => { const h = await originalOpen(...args);
        if(args[0] === root) { const originalSync = h.sync.bind(h); h.sync = async () => {
          syncs++; if((fault === "lock-sync" && syncs === 1) || (fault === "state-sync" && syncs === 2)) throw new Error("private-fsync-error");
          return originalSync(); }; } return h; };
      fs.rename = async (...args) => { if(fault === "rename") throw new Error("private-rename-error"); return originalRename(...args); };
      syncBuiltinESMExports(); const { withHostState } = await import(${JSON.stringify(moduleUrl)});
      const { hostIdentity } = await import(${JSON.stringify(new URL("./host-fixtures.mjs", import.meta.url).href)});
      let subsequentRejected = false;
      try { await withHostState(root, async store => {
        try { await store.begin(hostIdentity()); } catch {}
        try { await store.begin(hostIdentity()); } catch { subsequentRejected = true; }
      }); process.send({ success: true }); } catch(error) { process.send({ code: error.code, message: error.message, durabilityUncertain: error.durabilityUncertain, subsequentRejected }); }
      process.disconnect();`,
      [root],
    );
    const result = (await once(owner, "message", { signal: AbortSignal.timeout(10000) }))[0];
    assert.equal(result.code, "ERR_HOST_STATE");
    assert.equal(result.durabilityUncertain, true);
    assert.equal(result.message, "Host deployment state operation failed.");
    if (fault !== "lock-sync") assert.equal(result.subsequentRejected, true);
    await lstat(join(root, ".deploy.lock"));
    await assert.rejects(
      withHostState(root, () => {}),
      rejected,
    );
  }
});

test("successful healthy completion remains valid after a callback failure", async (t) => {
  const { root } = await privateFixture(t);
  const identity = hostIdentity();
  await assert.rejects(
    withHostState(root, async (store) => {
      await store.begin(identity);
      await advance(store, identity);
      await assert.rejects(store.fail(), rejected);
      throw new Error("fixture-private-healthy-error");
    }),
    rejected,
  );
  await withHostState(root, async (store) => {
    assert.equal((await store.read()).current.status, "completed");
    await store.begin(hostIdentity());
  });
});

test("backup recovery sequence and retained healthy target are validated on read", async (t) => {
  for (const kind of [
    "premature-proof",
    "missing-proof",
    "foreign-prior",
    "duplicate-prior",
    "invalid-healthy-sequence",
  ]) {
    const { root } = await privateFixture(t);
    const identity = hostIdentity();
    await withHostState(root, async (store) => {
      await store.begin(identity);
      if (["premature-proof", "missing-proof"].includes(kind)) {
        await advance(store, identity, "target-stopped");
        await store.enter("backup-verified");
        if (kind === "missing-proof")
          await store.complete("backup-verified", backupProof(identity));
        await store.fail();
      } else {
        await advance(store, identity);
        await store.begin(hostIdentity());
      }
    });
    const record = await disk(root);
    if (kind === "premature-proof") record.current.backup = backupProof(identity);
    if (kind === "missing-proof") record.current.backup = null;
    if (kind === "foreign-prior") {
      record.previousHealthy.identity.target.hostId = "foreign";
      record.previousHealthy.backup.target.hostId = "foreign";
    }
    if (kind === "duplicate-prior")
      record.current.identity.operationId = record.previousHealthy.identity.operationId;
    if (kind === "invalid-healthy-sequence") record.sequence++;
    await writeFile(join(root, "state.json"), JSON.stringify(record), { mode: 0o600 });
    await assert.rejects(
      withHostState(root, () => {}),
      rejected,
    );
  }
});

test("unawaited mutation keeps the lock until its real directory fsync finishes", async (t) => {
  const { root } = await privateFixture(t);
  const owner = child(
    t,
    `
    import fs from "node:fs/promises"; import { once } from "node:events"; import { syncBuiltinESMExports } from "node:module";
    const root = process.argv[1]; let syncs = 0; const originalOpen = fs.open.bind(fs);
    fs.open = async (...args) => { const h = await originalOpen(...args);
      if(args[0] === root) { const originalSync = h.sync.bind(h); h.sync = async () => {
        if(++syncs === 2) { process.send("writing"); await once(process, "message"); }
        return originalSync(); }; } return h; };
    syncBuiltinESMExports(); const { withHostState } = await import(${JSON.stringify(moduleUrl)});
    const { hostIdentity } = await import(${JSON.stringify(new URL("./host-fixtures.mjs", import.meta.url).href)});
    await withHostState(root, store => { void store.begin(hostIdentity()); });
    process.send("released"); process.disconnect();`,
    [root],
  );
  assert.equal(
    (await once(owner, "message", { signal: AbortSignal.timeout(10000) }))[0],
    "writing",
  );
  await assert.rejects(
    withHostState(root, () => {}),
    rejected,
  );
  owner.send("finish-sync");
  assert.equal(
    (await once(owner, "message", { signal: AbortSignal.timeout(10000) }))[0],
    "released",
  );
  await withHostState(root, async (store) => assert.equal((await store.read()).sequence, 1));
});

test("retirement fsync failure is distinct and permits a fresh synced acquisition", async (t) => {
  const { root } = await privateFixture(t);
  const owner = child(
    t,
    `
    import fs from "node:fs/promises"; import { syncBuiltinESMExports } from "node:module";
    let syncs = 0; const root = process.argv[1]; const originalOpen = fs.open.bind(fs);
    fs.open = async (...args) => { const h = await originalOpen(...args);
      if(args[0] === root) { const originalSync = h.sync.bind(h); h.sync = async () => {
        if(++syncs === 2) throw new Error("private-release-fsync"); return originalSync(); }; } return h; };
    syncBuiltinESMExports(); const { withHostState } = await import(${JSON.stringify(moduleUrl)});
    try { await withHostState(root, () => {}); process.send({success: true}); }
    catch(error) { process.send({code: error.code, message: error.message, durabilityUncertain: error.durabilityUncertain, lockRetirementUncertain: error.lockRetirementUncertain}); }
    process.disconnect();`,
    [root],
  );
  assert.deepEqual((await once(owner, "message", { signal: AbortSignal.timeout(10000) }))[0], {
    code: "ERR_HOST_LOCK_RELEASE",
    message: "Host deployment lock retirement failed.",
    durabilityUncertain: false,
    lockRetirementUncertain: true,
  });
  await assert.rejects(lstat(join(root, ".deploy.lock")), { code: "ENOENT" });
  await withHostState(root, (store) => store.begin(hostIdentity()));
  assert.equal((await disk(root)).sequence, 1);
});

for (const healthy of [false, true])
  test(`retirement failure leaves a synced successor untouched (${healthy ? "healthy handoff" : "unresolved candidate"})`, async (t) => {
    const { root } = await privateFixture(t);
    const owner = child(
      t,
      `
    import assert from "node:assert/strict"; import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const root = process.argv[1]; const healthy = ${JSON.stringify(healthy)};
    let markRelease, failRelease, markSecond, releaseSecond;
    const reachedRelease = new Promise(resolve => { markRelease = resolve; });
    const releaseGate = new Promise(resolve => { failRelease = resolve; });
    const secondEntered = new Promise(resolve => { markSecond = resolve; });
    const secondGate = new Promise(resolve => { releaseSecond = resolve; });
    let syncs = 0; const originalOpen = fs.open.bind(fs);
    fs.open = async (...args) => { const h = await originalOpen(...args);
      if(args[0] === root) { const originalSync = h.sync.bind(h); h.sync = async () => {
        if(++syncs === (healthy ? 20 : 3)) { markRelease(); await releaseGate; throw new Error("private-retirement-fsync"); }
        return originalSync(); }; } return h; };
    syncBuiltinESMExports(); const { withHostState } = await import(${JSON.stringify(moduleUrl)});
    const { hostIdentity, backupProof } = await import(${JSON.stringify(new URL("./host-fixtures.mjs", import.meta.url).href)});
    const phases = ["admitted", "images-verified", "target-stopped", "backup-verified", "migrating", "migrated", "api-started", "edge-started", "healthy"];
    const identity = hostIdentity(); let expired;
    const first = withHostState(root, async store => {
      expired = store; await store.begin(identity);
      if(healthy) for(const phase of phases) {
        if(phase !== "admitted") await store.enter(phase);
        await store.complete(phase, ...(phase === "backup-verified" ? [backupProof(identity)] : []));
      }
    }).catch(error => ({code: error.code, message: error.message, durabilityUncertain: error.durabilityUncertain, lockRetirementUncertain: error.lockRetirementUncertain}));
    await reachedRelease;
    const second = withHostState(root, async store => {
      const state = await store.read(); assert.equal(state.current.identity.operationId, identity.operationId);
      if(healthy) { await store.begin(hostIdentity()); assert.deepEqual((await store.read()).previousHealthy.identity, identity); }
      else await assert.rejects(store.begin(hostIdentity()), {code: "ERR_HOST_STATE"});
      markSecond(); await secondGate;
    });
    await secondEntered;
    const lockBefore = await fs.lstat(root + "/.deploy.lock");
    const bytesBefore = await fs.readFile(root + "/state.json", "utf8");
    failRelease(); const error = await first;
    const lockAfter = await fs.lstat(root + "/.deploy.lock");
    assert.equal(lockAfter.ino, lockBefore.ino); assert.equal(lockAfter.dev, lockBefore.dev);
    assert.equal(await fs.readFile(root + "/state.json", "utf8"), bytesBefore);
    for(const method of [() => expired.read(), () => expired.begin(hostIdentity()), () => expired.enter("images-verified"), () => expired.complete("admitted"), () => expired.fail()])
      await assert.rejects(method(), {code: "ERR_HOST_STATE"});
    releaseSecond(); await second;
    await withHostState(root, async store => {
      assert.equal((await store.read()).current.status, "entered");
      await assert.rejects(store.begin(hostIdentity()), {code: "ERR_HOST_STATE"});
    });
    process.send({error, successorUntouched: true, expiredMethodsRejected: true, unresolvedBeginRejected: true, healthyHandoff: healthy});
    process.disconnect();`,
      [root],
    );
    const result = (await once(owner, "message", { signal: AbortSignal.timeout(10000) }))[0];
    assert.deepEqual(result, {
      error: {
        code: "ERR_HOST_LOCK_RELEASE",
        message: "Host deployment lock retirement failed.",
        durabilityUncertain: false,
        lockRetirementUncertain: true,
      },
      successorUntouched: true,
      expiredMethodsRejected: true,
      unresolvedBeginRejected: true,
      healthyHandoff: healthy,
    });
  });

test("caught recovery persistence uncertainty retains the shared deployment lock and original journal", async (t) => {
  const { root } = await privateFixture(t);
  await withHostState(root, async (store) => {
    await store.begin(hostIdentity());
    await store.fail();
  });
  const original = await readFile(join(root, "state.json"));
  await assert.rejects(
    withHostState(root, async (store) => {
      assert.equal(typeof store.guardPersistence, "function");
      await assert.rejects(
        store.guardPersistence(async () => {
          throw Object.assign(new Error("private persistence failure"), {
            durabilityUncertain: true,
          });
        }),
        rejected,
      );
      await assert.rejects(store.read(), rejected);
    }),
    (error) => rejected(error) && error.durabilityUncertain === true,
  );
  assert.deepEqual(await readFile(join(root, "state.json")), original);
  assert.ok((await lstat(join(root, ".deploy.lock"))).isFile());
  await assert.rejects(
    withHostState(root, () => {}),
    rejected,
  );
});

test("guarded recovery persistence is drained before lock retirement and expires with its owner", async (t) => {
  const { root } = await privateFixture(t);
  let retained;
  let finish;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise((resolve) => {
    finish = resolve;
  });
  const owner = withHostState(root, async (store) => {
    assert.equal(typeof store.guardPersistence, "function");
    retained = store;
    void store.guardPersistence(async () => {
      entered();
      await waiting;
      await writeFile(join(root, "recovery-proof"), "durable-work-finished");
    });
  });
  await Promise.race([started, owner]);
  await assert.rejects(
    withHostState(root, () => {}),
    rejected,
  );
  finish();
  await owner;
  assert.equal(await readFile(join(root, "recovery-proof"), "utf8"), "durable-work-finished");
  await assert.rejects(lstat(join(root, ".deploy.lock")), { code: "ENOENT" });
  await assert.rejects(
    retained.guardPersistence(async () => {
      await writeFile(join(root, "escaped"), "bad");
    }),
    rejected,
  );
  await assert.rejects(lstat(join(root, "escaped")), { code: "ENOENT" });
});

test("held host capability rejects forgery and expiry while allowing one guarded producer", async (t) => {
  const { withHeldHostState } = await import("../host/state.mjs");
  assert.equal(typeof withHeldHostState, "function");
  const { root } = await privateFixture(t);
  await assert.rejects(withHeldHostState({}, () => {}));
  let retained;
  await withHostState(root, async (store) => {
    await store.begin(hostIdentity());
    await store.fail();
    await store.guardPersistence(async (capability) => {
      retained = capability;
      await withHeldHostState(capability, async (held) => {
        assert.equal(held.root, root);
        assert.equal(held.state.current.status, "recovery-required");
        await assert.rejects(withHostState(root, () => {}));
        held.state.current.status = "completed";
      });
      await assert.rejects(withHeldHostState(capability, () => {}));
    });
    assert.equal((await store.read()).current.status, "recovery-required");
  });
  await assert.rejects(withHeldHostState(retained, () => {}));
});

test("unawaited held producer uncertainty drains and retains the original lock", async (t) => {
  const { withHeldHostState } = await import("../host/state.mjs");
  assert.equal(typeof withHeldHostState, "function");
  const { root } = await privateFixture(t);
  await assert.rejects(
    withHostState(root, async (store) => {
      await store
        .guardPersistence(async (capability) => {
          void withHeldHostState(capability, async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw Object.assign(new Error("private producer failure"), {
              durabilityUncertain: true,
            });
          }).catch(() => {});
        })
        .catch(() => {});
    }),
    (error) => rejected(error) && error.durabilityUncertain === true,
  );
  assert.ok((await lstat(join(root, ".deploy.lock"))).isFile());
});

test("producer failure cannot hide earlier guarded persistence uncertainty", async (t) => {
  const { withHeldHostState } = await import("../host/state.mjs");
  const { root } = await privateFixture(t);
  await assert.rejects(
    withHostState(root, async (store) => {
      await store
        .guardPersistence(async (capability) => {
          void withHeldHostState(capability, async () => {
            throw new Error("later producer failure");
          }).catch(() => {});
          throw Object.assign(new Error("earlier persistence failure"), {
            durabilityUncertain: true,
          });
        })
        .catch(() => {});
    }),
    (error) => rejected(error) && error.durabilityUncertain === true,
  );
  assert.ok((await lstat(join(root, ".deploy.lock"))).isFile());
});

for (const caught of [false, true])
  test(`detached unreaped producer latches owner uncertainty with guard rejection ${caught ? "caught" : "uncaught"}`, async (t) => {
    const { withHeldHostState } = await import("../host/state.mjs");
    const { root } = await privateFixture(t);
    let durable;
    await assert.rejects(
      withHostState(root, async (store) => {
        await store.begin(hostIdentity());
        durable = await readFile(join(root, "state.json"));
        const pending = store.guardPersistence(async (capability) => {
          void withHeldHostState(capability, async () => {
            throw Object.assign(new Error("fixture detached process still running"), {
              terminationConfirmed: false,
            });
          }).catch(() => {});
        });
        if (caught) {
          await assert.rejects(pending);
          await assert.rejects(store.complete("admitted"));
        } else await pending;
      }),
      { durabilityUncertain: true },
    );
    await lstat(join(root, ".deploy.lock"));
    assert.deepEqual(await readFile(join(root, "state.json")), durable);
  });

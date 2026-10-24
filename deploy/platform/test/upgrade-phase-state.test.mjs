import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { withUpgradePhaseState, withHeldUpgradeState } from "../host/upgrade-state.mjs";
import { upgradeBytes, upgradeHash } from "./upgrade-fixture.mjs";

import { phaseFixture } from "./upgrade-phase-fixture.mjs";

const open = (f, input, callback, now = () => f.phaseNow) =>
  withUpgradePhaseState(f.root, input, callback, { now });
const activationPhases = [
  "activation-admitted",
  "migration-entered",
  "migrated",
  "api-started",
  "edge-started",
  "healthy",
];
const returnPhases = ["return-admitted", "old-api-started", "old-edge-started", "returned-old"];
async function finish(s, phases) {
  for (let i = 0; i < phases.length; i++) {
    if (i) await s.enter(phases[i]);
    await s.complete(phases[i]);
  }
}

test("fresh activation binds expired prepare, durable receipt and original bytes", async (t) => {
  const f = await phaseFixture(t);
  const input = await f.phaseInput("activate");
  const before = await readFile(f.journal);
  await open(f, input, async (s) => {
    const state = await s.read();
    assert.equal(state.phase, "activation-admitted");
    assert.equal(state.sequence, 7);
    assert.deepEqual(await readFile(join(f.directory, "before-activate.json")), before);
    assert.deepEqual(
      JSON.parse(await readFile(join(f.directory, "activate-consumption.json"))).dispatch,
      input.dispatch,
    );
    await s.guard((cap) =>
      withHeldUpgradeState(cap, async (h) => assert.deepEqual(h.state.decision, input)),
    );
    await finish(s, activationPhases);
  });
  const state = JSON.parse(await readFile(f.journal));
  assert.equal(state.sequence, 18);
  assert.equal(state.migrationEntered, true);
  await assert.rejects(open(f, input, () => assert.fail("activation replay")));
  await assert.rejects(
    open(f, await f.phaseInput("return-old"), () => assert.fail("postmigration return")),
  );
});

test("migration latch and index are durable before any producer, even spawn failure", async (t) => {
  const f = await phaseFixture(t);
  const a = await f.phaseInput("activate");
  await assert.rejects(
    open(f, a, async (s) => {
      await s.complete("activation-admitted");
      await s.enter("migration-entered");
      await s.guard((cap) =>
        withHeldUpgradeState(cap, async (h) => {
          assert.equal(h.state.migrationEntered, true);
          assert.equal(JSON.parse(await readFile(f.journal)).migrationEntered, true);
          assert.equal(
            JSON.parse(await readFile(join(f.root, "upgrade-index.json"))).stateSha256,
            upgradeHash(await readFile(f.journal)),
          );
          throw Error("spawn failed before child exists");
        }),
      );
    }),
  );
  await assert.rejects(
    open(f, await f.phaseInput("return-old"), () => assert.fail("latched return")),
  );
});
for (const failed of [undefined, "admitted", "old-stopped", "backup-verified"])
  test(`separate fresh return from ${failed ?? "completed preparation"} is terminal and one-shot`, async (t) => {
    const f = await phaseFixture(t, failed);
    const r = await f.phaseInput("return-old");
    await open(f, r, (s) => finish(s, returnPhases));
    const result = JSON.parse(await readFile(f.journal));
    assert.equal(result.phase, "returned-old");
    assert.equal(result.migrationEntered, false);
    await assert.rejects(open(f, r, () => assert.fail("lost response replay")));
    await assert.rejects(
      open(f, await f.phaseInput("activate"), () => assert.fail("activate after return")),
    );
  });

test("known activation failure before latch allows fresh checked return only", async (t) => {
  const f = await phaseFixture(t);
  const a = await f.phaseInput("activate");
  await assert.rejects(
    open(f, a, async () => {
      throw Error("fresh physical check denied");
    }),
  );
  await assert.rejects(open(f, await f.phaseInput("activate"), () => assert.fail("retry")));
  await open(f, await f.phaseInput("return-old"), (s) => finish(s, returnPhases));
});

test("activate/return compete for one target lock and stale prior cannot win later", async (t) => {
  const f = await phaseFixture(t);
  const a = await f.phaseInput("activate"),
    r = await f.phaseInput("return-old");
  await open(f, r, async (s) => {
    await assert.rejects(open(f, a, () => assert.fail("concurrent")));
    await finish(s, returnPhases);
  });
  await assert.rejects(open(f, a, () => assert.fail("stale prior")));
});
for (const mutation of [
  "prior",
  "identity",
  "dispatch",
  "executorCi",
  "plan",
  "expiry",
  "phase",
  "unknown",
])
  test(`phase rejects changed ${mutation} before consumption`, async (t) => {
    const f = await phaseFixture(t);
    const a = await f.phaseInput("activate");
    if (mutation === "prior") a.prior.sha256 = "f".repeat(64);
    if (mutation === "identity")
      a.identity = { ...a.identity, configurationSha256: "b".repeat(64) };
    if (mutation === "dispatch") a.dispatch = f.input.dispatch;
    if (mutation === "executorCi") a.executorCi = { ...a.executorCi, runId: "99" };
    if (mutation === "plan") a.reviewedPlanSha256 = "b".repeat(64);
    if (mutation === "expiry") a.expiresAt = new Date(f.phaseNow).toISOString();
    if (mutation === "phase") a.phase = "prepare";
    if (mutation === "unknown") a.bypass = true;
    await assert.rejects(open(f, a, () => assert.fail("invalid admission")));
    await assert.rejects(lstat(join(f.directory, "activate-consumption.json")), { code: "ENOENT" });
  });
for (const mutation of ["archive", "prepare-consumption", "phase-consumption", "expiry"])
  test(`live phase guard fences changed ${mutation}`, async (t) => {
    const f = await phaseFixture(t);
    const a = await f.phaseInput("activate");
    let now = f.phaseNow;
    await assert.rejects(
      open(
        f,
        a,
        async (s) => {
          if (mutation === "expiry") now = Date.parse(a.expiresAt);
          else {
            const name =
              mutation === "archive"
                ? "before-activate.json"
                : mutation === "prepare-consumption"
                  ? "prepare-consumption.json"
                  : "activate-consumption.json";
            const path = join(f.directory, name);
            await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(" ")]));
          }
          await s.guard(() => assert.fail("changed evidence"));
        },
        () => now,
      ),
    );
  });

test("unknown producer termination retains target lock and forbids return", async (t) => {
  const f = await phaseFixture(t);
  const a = await f.phaseInput("activate");
  await assert.rejects(
    open(f, a, (s) =>
      s.guard(() => {
        throw Object.assign(Error("unreaped"), { terminationConfirmed: false });
      }),
    ),
  );
  assert.ok(await lstat(join(f.root, ".deploy.lock")));
  await assert.rejects(
    open(f, await f.phaseInput("return-old"), () => assert.fail("unknown return")),
  );
});

test("phase callback cannot retain store or held verifier", async (t) => {
  const f = await phaseFixture(t);
  let retained, verify;
  await open(f, await f.phaseInput("return-old"), async (s) => {
    retained = s;
    await s.guard((cap) =>
      withHeldUpgradeState(cap, async (h) => {
        verify = h.verify;
      }),
    );
    await assert.rejects(verify());
    await finish(s, returnPhases);
  });
  await assert.rejects(retained.read());
  await assert.rejects(verify());
});

test("failed return cannot be retried even with a new dispatch and fresh prior", async (t) => {
  const f = await phaseFixture(t);
  await assert.rejects(
    open(f, await f.phaseInput("return-old"), async (s) => {
      await s.complete("return-admitted");
      await s.enter("old-api-started");
      throw Error("known start failure");
    }),
  );
  const r = await f.phaseInput("return-old");
  r.dispatch.runId = "987654325";
  await assert.rejects(open(f, r, () => assert.fail("repeated return")));
});

for (const fault of [
  "archive-link",
  "archive-sync",
  "receipt-link",
  "receipt-sync",
  "phase-replace",
  "phase-sync",
  "index-replace",
  "latch-replace",
  "latch-sync",
])
  test(`phase publication failure retains lock at ${fault}`, async (t) => {
    const { fork } = await import("node:child_process");
    const { once } = await import("node:events");
    const f = await phaseFixture(t);
    const a = await f.phaseInput("activate");
    const inputPath = join(f.directory, "test-input.json");
    await writeFile(inputPath, upgradeBytes(a), { mode: 0o600 });
    const moduleUrl = new URL("../host/upgrade-state.mjs", import.meta.url).href;
    const child = fork(
      "--input-type=module",
      [
        "--eval",
        `
 import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
 const root=process.argv[1],inputPath=process.argv[2],fault=${JSON.stringify(fault)};
 const link=fs.link.bind(fs),open=fs.open.bind(fs),rename=fs.rename.bind(fs);let published,entered=false,migrationSpawned=false;
 fs.link=async(a,b)=>{const kind=b.endsWith('/before-activate.json')?'archive':b.endsWith('/activate-consumption.json')?'receipt':null;
 if(fault===kind+'-link')throw Error('test EIO');const result=await link(a,b);if(kind)published=kind;return result;};
 fs.rename=async(a,b)=>{let kind=null;if(b.endsWith('/state.json')){const next=JSON.parse(await fs.readFile(a));kind=next.migrationEntered?'latch':'phase';}else if(b.endsWith('/upgrade-index.json'))kind='index';
 if(fault===kind+'-replace')throw Error('test EIO');const result=await rename(a,b);if(kind)published=kind;return result;};
 fs.open=async(...a)=>{const h=await open(...a),sync=h.sync.bind(h);h.sync=async()=>{if((await h.stat()).isDirectory()&&fault===published+'-sync')throw Error('test fsync');return sync();};return h;};
 syncBuiltinESMExports();const {withUpgradePhaseState}=await import(${JSON.stringify(moduleUrl)});
 try{await withUpgradePhaseState(root,JSON.parse(await fs.readFile(inputPath)),async s=>{entered=true;await s.complete('activation-admitted');await s.enter('migration-entered');migrationSpawned=true;},{now:()=>${f.phaseNow}});process.send({ok:true,entered,migrationSpawned});}
 catch(e){process.send({uncertain:e.durabilityUncertain,entered,migrationSpawned});}process.disconnect();
 `,
        f.root,
        inputPath,
      ],
      { silent: true, env: { PATH: "/usr/bin:/bin" } },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    const [result] = await once(child, "message", { signal: AbortSignal.timeout(15000) });
    assert.equal(result.uncertain, true);
    assert.equal(result.migrationSpawned, false);
    assert.equal(result.entered, fault.startsWith("latch"));
    assert.ok(await lstat(join(f.root, ".deploy.lock")));
    await assert.rejects(
      open(f, await f.phaseInput("return-old"), () => assert.fail("uncertain bypass")),
    );
  });

test("expiry after durable phase consumption publishes a known failure eligible for fresh return", async (t) => {
  const f = await phaseFixture(t);
  const a = await f.phaseInput("activate");
  let count = 0;
  await assert.rejects(
    open(
      f,
      a,
      () => assert.fail("expired owner callback"),
      () => (++count === 1 ? f.phaseNow : Date.parse(a.expiresAt)),
    ),
  );
  assert.equal(JSON.parse(await readFile(f.journal)).status, "recovery-required");
  await open(f, await f.phaseInput("return-old"), (s) => finish(s, returnPhases));
});

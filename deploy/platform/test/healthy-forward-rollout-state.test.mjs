import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest } from "../backup/schemas.mjs";
import {
  withHealthyForwardBackupState,
  withHealthyForwardRollout,
} from "../host/healthy-forward-rollout-state.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "markiro-healthy-forward-state-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const operationId = "10000000-0000-4000-8000-000000000001";
  const predecessorOperationId = "10000000-0000-4000-8000-000000000002";
  const head = join(root, "upgrade-index.json");
  const prior = Buffer.from(
    `${JSON.stringify({
      kind: "platform-forward-recovery-index",
      operationId: predecessorOperationId,
    })}\n`,
  );
  await writeFile(head, prior, { mode: 0o600 });
  const calls = [];
  const result = {
    api: "d".repeat(64),
    edge: "e".repeat(64),
    postgres: "f".repeat(64),
  };
  const observe = async (name, value) => {
    calls.push(name);
    return value;
  };
  const input = {
    root,
    operationId,
    predecessorOperationId,
    predecessorIndexSha256: digest(prior),
    operationSha256: "a".repeat(64),
    executorSha: "b".repeat(40),
    backupRuntimeSha256: "c".repeat(64),
    postgresId: result.postgres,
  };
  const adapters = {
    verifyAuthority: () => observe("authority"),
    preflight: () => observe("preflight"),
    stopSource: () => observe("stop-source"),
    verifySourceStopped: () => observe("source-stopped"),
    verifyBackup: (capability) =>
      withHealthyForwardBackupState(capability, async (held) => {
        assert.equal(held.operation.operationId, operationId);
        await held.verify();
        return observe("backup", "b".repeat(64));
      }),
    activateApi: () => observe("api", result.api),
    activateEdge: () => observe("edge", result.edge),
    verifyHealth: () => observe("health", result),
  };
  const directory = join(root, "healthy-forward-rollouts", operationId);
  return { input, adapters, calls, result, prior, head, directory };
}

test("a fresh verified backup and healthy observed replacement are required to move ownership", async (t) => {
  const f = await fixture(t);
  const result = await withHealthyForwardRollout(f.input, f.adapters);
  assert.deepEqual(result, f.result);
  assert.equal(f.calls.filter((name) => name === "backup").length, 1);
  assert.ok(f.calls.lastIndexOf("preflight") < f.calls.indexOf("stop-source"));
  assert.ok(f.calls.indexOf("source-stopped") < f.calls.indexOf("backup"));
  assert.ok(f.calls.lastIndexOf("source-stopped") > f.calls.indexOf("backup"));
  assert.ok(f.calls.lastIndexOf("source-stopped") < f.calls.indexOf("api"));
  assert.deepEqual(await readFile(join(f.directory, "predecessor-index.json")), f.prior);
  const state = await readFile(join(f.directory, "state.json"));
  assert.equal(JSON.parse(state).phase, "healthy");
  assert.equal(JSON.parse(await readFile(f.head)).stateSha256, digest(state));
  await assert.rejects(withHealthyForwardRollout(f.input, f.adapters));
  assert.equal(f.calls.filter((name) => name === "api").length, 1);
});

test("a successor archives a completed rollout before publishing its own healthy index", async (t) => {
  const f = await fixture(t);
  await withHealthyForwardRollout(f.input, f.adapters);
  const predecessor = await readFile(f.head);
  const predecessorState = await readFile(join(f.directory, "state.json"));
  const operationId = "10000000-0000-4000-8000-000000000003";
  const next = {
    ...f.input,
    operationId,
    operationSha256: "9".repeat(64),
    predecessorOperationId: f.input.operationId,
    predecessorIndexSha256: digest(predecessor),
  };
  const result = { ...f.result, api: "7".repeat(64), edge: "8".repeat(64) };
  const adapters = {
    ...f.adapters,
    verifyBackup: (capability) =>
      withHealthyForwardBackupState(capability, async (held) => {
        assert.equal(held.operation.operationId, operationId);
        await held.verify();
        return "a".repeat(64);
      }),
    activateApi: async () => result.api,
    activateEdge: async () => result.edge,
    verifyHealth: async () => result,
  };
  await assert.rejects(withHealthyForwardRollout(next, adapters), {
    durabilityUncertain: false,
  });
  assert.deepEqual(await readFile(f.head), predecessor);

  const successor = { ...next, predecessorKind: "platform-healthy-forward-rollout-index" };
  assert.deepEqual(await withHealthyForwardRollout(successor, adapters), result);

  const directory = join(f.input.root, "healthy-forward-rollouts", operationId);
  assert.deepEqual(await readFile(join(directory, "predecessor-index.json")), predecessor);
  assert.deepEqual(await readFile(join(f.directory, "state.json")), predecessorState);
  const state = await readFile(join(directory, "state.json"));
  assert.equal(JSON.parse(state).phase, "healthy");
  assert.deepEqual(JSON.parse(await readFile(f.head)), {
    version: 1,
    kind: "platform-healthy-forward-rollout-index",
    operationId,
    predecessorIndexSha256: digest(predecessor),
    stateSha256: digest(state),
  });
});

test("successor state guards require the matching live predecessor kind", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    withHealthyForwardRollout(
      { ...f.input, predecessorKind: "platform-healthy-forward-rollout-index" },
      f.adapters,
    ),
    { durabilityUncertain: false },
  );
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readFile(f.head), f.prior);
  await assert.rejects(readFile(join(f.input.root, ".deploy.lock")), { code: "ENOENT" });
});

test("a backup refusal cannot start either application or move ownership", async (t) => {
  const f = await fixture(t);
  f.adapters.verifyBackup = async () => {
    throw new Error("Unverified backup");
  };
  await assert.rejects(withHealthyForwardRollout(f.input, f.adapters), {
    durabilityUncertain: true,
  });
  assert.equal(f.calls.includes("api"), false);
  assert.equal(f.calls.includes("edge"), false);
  assert.deepEqual(await readFile(f.head), f.prior);
  assert.equal(JSON.parse(await readFile(join(f.directory, "state.json"))).phase, "source-stopped");
  assert.ok((await readFile(join(f.input.root, ".deploy.lock"))).length > 0);
});

test("a refused live preflight does not stop services or retain the operation lock", async (t) => {
  const f = await fixture(t);
  f.adapters.preflight = async () => {
    throw new Error("Live runtime differs");
  };
  await assert.rejects(withHealthyForwardRollout(f.input, f.adapters), {
    durabilityUncertain: false,
  });
  assert.equal(f.calls.includes("stop-source"), false);
  await assert.rejects(readFile(join(f.input.root, ".deploy.lock")), { code: "ENOENT" });
});

test("a backup capability cannot be forged, reused, or retained across the guarded stage", async (t) => {
  const f = await fixture(t);
  const verify = f.adapters.verifyBackup;
  let saved;
  f.adapters.verifyBackup = async (capability) => {
    saved = capability;
    const proof = await verify(capability);
    await assert.rejects(withHealthyForwardBackupState(capability, async () => {}));
    return proof;
  };
  await assert.rejects(withHealthyForwardBackupState({}, async () => {}));
  await withHealthyForwardRollout(f.input, f.adapters);
  await assert.rejects(withHealthyForwardBackupState(saved, async () => {}));
});

test("an uncertain API replacement preserves the predecessor and retains the lock", async (t) => {
  const f = await fixture(t);
  f.adapters.activateApi = async () => {
    throw new Error("Could not establish final container identity");
  };
  await assert.rejects(withHealthyForwardRollout(f.input, f.adapters), {
    durabilityUncertain: true,
  });
  assert.equal(f.calls.includes("edge"), false);
  assert.deepEqual(await readFile(f.head), f.prior);
  const state = JSON.parse(await readFile(join(f.directory, "state.json")));
  assert.equal(state.phase, "api-entered");
  assert.ok((await readFile(join(f.input.root, ".deploy.lock"))).length > 0);
});

test("an observed change of PostgreSQL prevents ownership handoff even after both apps start", async (t) => {
  const f = await fixture(t);
  f.adapters.verifyHealth = async () => ({ ...f.result, postgres: "9".repeat(64) });
  await assert.rejects(withHealthyForwardRollout(f.input, f.adapters), {
    durabilityUncertain: true,
  });
  assert.deepEqual(await readFile(f.head), f.prior);
  assert.equal(JSON.parse(await readFile(join(f.directory, "state.json"))).phase, "edge-started");
});

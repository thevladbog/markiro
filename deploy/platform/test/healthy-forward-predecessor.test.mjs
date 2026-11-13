import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { digest } from "../backup/schemas.mjs";
import { fingerprintHostConfiguration } from "../host/config.mjs";
import { readPrivateFile } from "../host/files.mjs";
import { withForwardActivationState, withForwardPreparationState } from "../host/forward-state.mjs";
import {
  isHealthyRolloutPredecessor,
  readHealthyRolloutPredecessor,
} from "../host/healthy-forward-predecessor.mjs";
import { validateHealthyForwardRolloutOperation } from "../host/healthy-forward-rollout-runtime.mjs";
import { forwardEdgeSuccessorFixture } from "./forward-edge-successor-fixture.mjs";
import { forwardDecision, forwardPrepared } from "./forward-fixture.mjs";
import { jsonBytes, writeCompletedHealthyRollout } from "./healthy-forward-predecessor-fixture.mjs";

const readPinned = async (root, path, sha256) => {
  const bytes = await readPrivateFile(root, path);
  assert.equal(digest(bytes), sha256);
  return bytes;
};

async function fixture(t) {
  const f = await forwardEdgeSuccessorFixture(t);
  const prepared = forwardPrepared(f);
  await withForwardPreparationState(
    f.root,
    f.input,
    async (store) => {
      await store.complete("admitted", prepared.sourceRuntime);
      await store.enter("source-held");
      await store.complete("source-held");
      await store.enter("backup-verified");
      await store.complete("backup-verified", prepared.backup, prepared.preparation);
    },
    f.options,
  );
  const operationId = f.input.identity.operationId;
  const directory = join(f.root, "forward-recovery-operations", operationId);
  const decision = forwardDecision(f, JSON.parse(await readFile(join(directory, "state.json"))));
  delete decision.expiresAt;
  decision.version = 2;
  decision.authority = "protected-dispatch-once";
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
  const fileHash = async (name) => digest(await readFile(join(directory, name)));
  const predecessor = {
    operationId,
    indexSha256: digest(await readFile(join(f.root, "upgrade-index.json"))),
    stateSha256: await fileHash("state.json"),
    beforeActivationSha256: await fileHash("before-post-migration-activate.json"),
    prepareConsumptionSha256: await fileHash("prepare-consumption.json"),
    activateConsumptionSha256: await fileHash("activate-consumption.json"),
  };
  const identity = { ...f.input.identity, operationId: randomUUID() };
  const observationPolicy = structuredClone(
    JSON.parse(f.failedActivationBytes.activationOperation).observationPolicy,
  );
  const containers = Object.fromEntries(
    ["api", "edge", "postgres"].map((service, i) => [
      service,
      {
        id:
          service === "postgres" ? f.input.baseline.containers.postgres : String(i + 1).repeat(64),
        imageId:
          service === "postgres"
            ? observationPolicy.postgresImageId
            : identity.admission.registry[service].imageId,
        recipeSha256: String(i + 4).repeat(64),
      },
    ]),
  );
  const runtime = {
    path: "manual-configurations/reviewed-drift/runtime.env",
    sha256: "e".repeat(64),
    containers,
    observationPolicy,
    schema: f.input.baseline.schema,
  };
  const completed = await writeCompletedHealthyRollout(f, {
    identity,
    runtime,
    predecessor,
    containers,
    runtimeBytes: Buffer.from("SERVER_PROFILE=platform-only\n"),
  });
  const candidate = { ...identity, operationId: randomUUID() };
  const verify = (runtime = completed.runtime, predecessor = completed.predecessor) =>
    readHealthyRolloutPredecessor(f.root, predecessor, runtime, candidate, readPinned);
  return { f, completed, candidate, operationId, verify };
}

test("uses the completed rollout candidate and retains the original recovery custody identity", async (t) => {
  const { f, completed, operationId, verify } = await fixture(t);
  assert.equal(isHealthyRolloutPredecessor(completed.predecessor), true);
  const expected = { identity: completed.identity, custodyOperationId: operationId };
  assert.deepEqual(await verify(), expected);

  const operation = Buffer.from(JSON.stringify(completed.record, null, 2) + "\n");
  await f.put(completed.operationPath, operation);
  const state = { ...completed.state, operationSha256: digest(operation) };
  const index = { ...completed.index, stateSha256: digest(jsonBytes(state)) };
  await f.put(completed.statePath, jsonBytes(state));
  await f.put(completed.head, jsonBytes(index));
  const pinned = {
    ...completed.predecessor,
    stateSha256: index.stateSha256,
    indexSha256: digest(jsonBytes(index)),
  };
  assert.deepEqual(await verify(completed.runtime, pinned), expected);
});

test("checks the state, previous operation, archive, source runtime and all observed workload identities", async (t) => {
  const { f, completed, verify } = await fixture(t);
  for (const path of [
    completed.statePath,
    completed.operationPath,
    completed.archive,
    join(f.root, "candidates", completed.identity.operationId, "runtime.env"),
    completed.record.operation.configuration.migrationSnapshot.path,
  ]) {
    const old = await readFile(path);
    await f.put(path, Buffer.concat([old, Buffer.from("\n")]));
    await assert.rejects(verify());
    await f.put(path, old);
  }
  for (const service of ["api", "edge", "postgres"]) {
    const bad = structuredClone(completed.runtime);
    bad.containers[service].id = "0".repeat(64);
    await assert.rejects(verify(bad));
  }
});

test("refuses a re-pinned intermediate rollout or a noncanonical active index", async (t) => {
  const { f, completed, verify } = await fixture(t);
  const repin = async (index, state, indexBytes = jsonBytes(index)) => {
    await f.put(completed.statePath, jsonBytes(state));
    await f.put(completed.head, indexBytes);
    return {
      ...completed.predecessor,
      stateSha256: index.stateSha256,
      indexSha256: digest(indexBytes),
    };
  };
  const state = { ...completed.state, phase: "edge-started", sequence: 8 };
  const index = { ...completed.index, stateSha256: digest(jsonBytes(state)) };
  await assert.rejects(verify(completed.runtime, await repin(index, state)));
  const noncanonical = Buffer.from(JSON.stringify(completed.index, null, 2) + "\n");
  await assert.rejects(
    verify(completed.runtime, await repin(completed.index, completed.state, noncanonical)),
  );
});

test("walks more than one healthy rollout back to the original recovery anchor", async (t) => {
  const { f, completed, candidate, operationId } = await fixture(t);
  const containers = structuredClone(completed.runtime.containers);
  containers.api.id = "a".repeat(64);
  containers.edge.id = "b".repeat(64);
  const second = await writeCompletedHealthyRollout(f, {
    identity: candidate,
    runtime: completed.runtime,
    predecessor: completed.predecessor,
    containers,
    runtimeBytes: Buffer.from(
      "SERVER_PROFILE=platform-only\nRELEASE_CATALOG_WRITERS_ENABLED=true\n",
    ),
  });
  const third = { ...candidate, operationId: randomUUID() };
  assert.deepEqual(
    await readHealthyRolloutPredecessor(
      f.root,
      second.predecessor,
      second.runtime,
      third,
      readPinned,
    ),
    { identity: second.identity, custodyOperationId: operationId },
  );
  const parentState = await readFile(completed.statePath);
  await f.put(completed.statePath, Buffer.concat([parentState, Buffer.from("\n")]));
  await assert.rejects(
    readHealthyRolloutPredecessor(f.root, second.predecessor, second.runtime, third, readPinned),
  );
});

test("the runtime validates either predecessor and returns the original recovery custody ID", async (t) => {
  const { f, completed, candidate, operationId } = await fixture(t);
  const root = f.root;
  const host = dirname(root);
  const record = structuredClone(completed.record);
  const op = record.operation;
  const { runtimeSnapshot, migrationSnapshot } = op.configuration;
  const candidateDirectory = join(root, "candidates", candidate.operationId);
  runtimeSnapshot.path = join(candidateDirectory, "runtime.env");
  migrationSnapshot.path = join(candidateDirectory, "migration.env");
  runtimeSnapshot.interpolation.MARKIRO_PLATFORM_ENV_FILE = runtimeSnapshot.path;
  op.configuration.candidateId = candidate.operationId;
  await f.put(
    runtimeSnapshot.path,
    await readFile(join(root, "candidates", completed.identity.operationId, "runtime.env")),
  );
  await f.put(
    migrationSnapshot.path,
    await readFile(join(root, "candidates", completed.identity.operationId, "migration.env")),
  );
  op.admission.identity = {
    ...candidate,
    configurationSha256: (await fingerprintHostConfiguration({ root, ...op.configuration }))
      .configurationSha256,
  };
  op.pinnedPublisherConfig = {
    repository: "thevladbog/markiro",
    repositoryId: "11",
    ownerId: "12",
    workflows: [],
  };
  op.catalogCustody = { workers: [], guards: [] };
  const backupRuntime = Buffer.from("fixture backup runtime\n");
  const backupConnection = Buffer.from("fixture backup connection\n");
  await f.put(
    join(root, `healthy-forward-backup-runtime-${candidate.operationId}.json`),
    backupRuntime,
  );
  await f.put(
    join(root, `healthy-forward-backup-connection-${candidate.operationId}.json`),
    backupConnection,
  );
  op.backupPolicy = {
    runtimeSha256: digest(backupRuntime),
    connectionSha256: digest(backupConnection),
    roleMapping: { version: 1, roles: [], allowedDeltas: [] },
  };
  let installedSourceChecks = 0;
  const loaded = {
    record,
    verifyInstalledSources: async () => {
      installedSourceChecks += 1;
    },
  };
  const candidateRuntime = {
    path: join(basename(root), "candidates", candidate.operationId, "runtime.env"),
    sha256: runtimeSnapshot.sha256,
  };
  const expected = { custodyOperationId: operationId, candidateRuntime };
  const activeHealthyIndex = await readFile(completed.head);

  await t.test("accepts the original recovery index with the pinned drift receipt", async () => {
    const sourceBytes = Buffer.from("fixture manually reviewed runtime\n");
    op.runtime.sha256 = digest(sourceBytes);
    await f.put(join(host, op.runtime.path), sourceBytes);
    const receiptPath = op.runtime.path.replace(/runtime\.env$/u, "result.json");
    const receipt = jsonBytes({
      runtimePath: join(host, op.runtime.path),
      runtimeSha256: op.runtime.sha256,
    });
    await f.put(join(host, receiptPath), receipt);
    op.drift = { receiptPath, receiptSha256: digest(receipt) };
    await f.put(completed.head, await readFile(completed.archive));
    const verify = await validateHealthyForwardRolloutOperation(loaded);
    assert.deepEqual(await verify(), { ...expected, predecessorIdentity: f.input.identity });
  });

  await t.test("uses the prior healthy candidate and rechecks its archive on demand", async () => {
    delete op.drift;
    op.predecessor = completed.predecessor;
    op.runtime = completed.runtime;
    await f.put(completed.head, activeHealthyIndex);
    const verify = await validateHealthyForwardRolloutOperation(loaded);
    assert.deepEqual(await verify(), { ...expected, predecessorIdentity: completed.identity });
    assert.equal(installedSourceChecks, 8);
    await f.put(completed.archive, Buffer.from("{}\n"));
    await assert.rejects(verify());
  });
});

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { digest } from "../backup/schemas.mjs";
import { interpolationKeys } from "../host/config.mjs";

export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);

export async function writeCompletedHealthyRollout(
  f,
  { identity, runtime, predecessor, containers, runtimeBytes },
) {
  const root = f.root;
  const host = dirname(root);
  const operationId = identity.operationId;
  const runtimePath = join("candidates", operationId, "runtime.env");
  const runtimeSha256 = digest(runtimeBytes);
  const migrationBytes = Buffer.from("DATABASE_URL=postgresql://fixture@db.test/markiro\n");
  const migrationSha256 = digest(migrationBytes);
  const runtimeAbsolutePath = join(root, runtimePath);
  const { manifest } = identity.admission;
  const interpolation = {
    ...Object.fromEntries(interpolationKeys.map((key) => [key, "fixture"])),
    MARKIRO_PLATFORM_ENV_FILE: runtimeAbsolutePath,
    MARKIRO_SOURCE_SHA: manifest.sourceSha,
    MARKIRO_API_IMAGE_DIGEST: manifest.api.split("@")[1],
    MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: manifest.edge.split("@")[1],
  };
  const observationPolicy = runtime.observationPolicy;
  const configuration = {
    candidateId: operationId,
    runtimeSnapshot: { path: runtimeAbsolutePath, sha256: runtimeSha256, interpolation },
    migrationSnapshot: {
      path: join(root, "candidates", operationId, "migration.env"),
      sha256: migrationSha256,
    },
  };
  identity = {
    ...identity,
    configurationSha256: digest({
      version: 1,
      kind: "platform-host-configuration",
      candidateId: operationId,
      runtimeSha256,
      migrationSha256,
    }),
  };
  const dispatch = { toolingSha: identity.executorSha, runId: "90210", runAttempt: "1" };
  const record = {
    version: 1,
    kind: "platform-healthy-forward-rollout-host-operation",
    phase: "healthy-forward-rollout",
    installedRoot: join(host, "upgrade-bootstrap", identity.executorSha),
    dispatch,
    authorization: {
      actorId: "11",
      actorLogin: "actor",
      reviewerId: "12",
      reviewerLogin: "reviewer",
      environmentId: "44",
    },
    operation: {
      root,
      dockerConfig: join(root, "docker"),
      admission: {
        version: 2,
        authority: "protected-dispatch-once",
        identity,
        executorCi: { runId: "90211", runAttempt: "1" },
        dispatch,
      },
      predecessor,
      drift: null,
      runtime,
      configuration,
      composeHashes: { api: "a".repeat(64), edge: "e".repeat(64) },
      pinnedPublisherConfig: {},
      backupPolicy: {},
      catalogCustody: {},
    },
    observationPolicy,
  };
  const operationPath = join(
    host,
    "upgrade-operations",
    operationId,
    "healthy-forward-rollout",
    "operation.json",
  );
  const head = join(root, "upgrade-index.json");
  const directory = join(root, "healthy-forward-rollouts", operationId);
  const archive = join(directory, "predecessor-index.json");
  const statePath = join(directory, "state.json");
  const state = {
    version: 1,
    kind: "platform-healthy-forward-rollout-state",
    operationId,
    operationSha256: digest(jsonBytes(record)),
    predecessorOperationId: predecessor.operationId,
    predecessorIndexSha256: predecessor.indexSha256,
    phase: "healthy",
    sequence: 9,
    backupProofSha256: "b".repeat(64),
    api: containers.api.id,
    edge: containers.edge.id,
    postgres: containers.postgres.id,
  };
  const index = {
    version: 1,
    kind: "platform-healthy-forward-rollout-index",
    operationId,
    predecessorIndexSha256: state.predecessorIndexSha256,
    stateSha256: digest(jsonBytes(state)),
  };
  await f.put(archive, await readFile(head));
  await f.put(operationPath, jsonBytes(record));
  await f.put(statePath, jsonBytes(state));
  await f.put(runtimeAbsolutePath, runtimeBytes);
  await f.put(configuration.migrationSnapshot.path, migrationBytes);
  await f.put(head, jsonBytes(index));
  return {
    identity,
    record,
    operationPath,
    index,
    state,
    head,
    archive,
    statePath,
    predecessor: {
      kind: index.kind,
      operationId,
      indexSha256: digest(jsonBytes(index)),
      stateSha256: index.stateSha256,
    },
    runtime: {
      ...runtime,
      path: join(basename(root), runtimePath),
      sha256: runtimeSha256,
      containers,
    },
  };
}

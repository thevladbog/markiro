// Imported by the protected loader after checking the complete source bundle.
import { basename, dirname, join } from "node:path";
import { canonical, digest, ensure, hash, keys } from "../backup/schemas.mjs";
import { canonicalId } from "../release-admission.mjs";
import {
  assertNoCatalogPeers,
  validateUpgradeDispatch,
  verifyUpgradeDispatch,
} from "../upgrade-dispatch.mjs";
import { readProtectedEnv } from "../preflight.mjs";
import { verifyAdmission, verifyPlatformSmoke } from "./command.mjs";
import { fingerprintHostConfiguration } from "./config.mjs";
import { validateConfigurationContainer } from "./configuration-plan.mjs";
import { createHealthyForwardFailureRecorder } from "./failure-diagnostic.mjs";
import { readPrivateFile } from "./files.mjs";
import { extractProductMigrationProof } from "./forward-product.mjs";
import { observeHealthyForwardCatalogCustody } from "./healthy-forward-backup.mjs";
import { createHealthyForwardCandidateObserver } from "./healthy-forward-candidate.mjs";
import {
  verifyHealthyForwardPreflight,
  withStoppedHealthyForwardSource,
} from "./healthy-forward-preflight.mjs";
import { withHealthyForwardRollout } from "./healthy-forward-rollout-state.mjs";
import { createHealthyForwardWorkloads } from "./healthy-forward-workloads.mjs";
import { createDockerCommand, validateObservationPolicy } from "./observe.mjs";
import { validateOperationAuthority } from "./operation-authority.mjs";
import { runHostArchiveProcess, runHostProcess } from "./process.mjs";
import { sameTarget, validateIdentity } from "./state-validation.mjs";
import { createHeldHealthyForwardBackup } from "./target-backup.mjs";
import { validateUpgradeSchema } from "./upgrade-proofs.mjs";

const same = (a, b) => ensure(canonical(a) === canonical(b));
const direct = (_boundary, action) => action();
const phase = "healthy-forward-rollout";
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);

export async function validateHealthyForwardRolloutOperation(loaded) {
  const { record, verifyInstalledSources } = loaded;
  const op = record.operation;
  ensure(
    record.kind === "platform-healthy-forward-rollout-host-operation" &&
      record.phase === phase &&
      typeof verifyInstalledSources === "function",
  );
  keys(op, [
    "root",
    "dockerConfig",
    "admission",
    "predecessor",
    "drift",
    "runtime",
    "configuration",
    "composeHashes",
    "pinnedPublisherConfig",
    "backupPolicy",
    "catalogCustody",
  ]);
  const { admission, predecessor, drift, runtime, configuration } = op;
  keys(admission, ["version", "authority", "identity", "executorCi", "dispatch"]);
  ensure(admission.version === 2);
  validateOperationAuthority(admission);
  validateUpgradeDispatch(admission.dispatch);
  const identity = validateIdentity(admission.identity);
  same(record.dispatch, admission.dispatch);
  ensure(admission.dispatch.toolingSha === identity.executorSha);
  keys(admission.executorCi, ["runId", "runAttempt"]);
  ensure(Object.values(admission.executorCi).every(canonicalId));
  ensure(op.dockerConfig === join(op.root, "docker"));
  keys(predecessor, [
    "operationId",
    "indexSha256",
    "stateSha256",
    "beforeActivationSha256",
    "prepareConsumptionSha256",
    "activateConsumptionSha256",
  ]);
  const { operationId, ...predecessorPins } = predecessor;
  ensure(uuid(operationId) && operationId !== identity.operationId);
  ensure(Object.values(predecessorPins).every(hash));
  keys(drift, ["receiptPath", "receiptSha256"]);
  ensure(
    typeof drift.receiptPath === "string" &&
      /^manual-configurations\/[a-zA-Z0-9_-]+\/result\.json$/u.test(drift.receiptPath) &&
      hash(drift.receiptSha256),
  );
  keys(runtime, ["path", "sha256", "containers", "observationPolicy", "schema"]);
  ensure(
    runtime.path === drift.receiptPath.replace(/result\.json$/u, "runtime.env") &&
      hash(runtime.sha256),
  );
  same(runtime.observationPolicy, record.observationPolicy);
  const policy = validateObservationPolicy(record.observationPolicy);
  ensure(
    policy.machineId === identity.target.hostId && policy.volume.name === identity.target.volumeId,
  );
  keys(runtime.containers, ["api", "edge", "postgres"]);
  for (const descriptor of Object.values(runtime.containers))
    validateConfigurationContainer(descriptor);
  ensure(new Set(Object.values(runtime.containers).map(({ id }) => id)).size === 3);
  ensure(policy.postgresImageId === runtime.containers.postgres.imageId);
  validateUpgradeSchema(runtime.schema, identity);
  keys(configuration, ["candidateId", "runtimeSnapshot", "migrationSnapshot"]);
  ensure(configuration.candidateId === identity.operationId);
  keys(op.composeHashes, ["api", "edge"]);
  ensure(Object.values(op.composeHashes).every(hash));
  keys(op.pinnedPublisherConfig, ["repository", "repositoryId", "ownerId", "workflows"]);
  ensure(op.pinnedPublisherConfig.repository === "thevladbog/markiro");
  const backup = op.backupPolicy;
  keys(backup, ["runtimeSha256", "connectionSha256", "roleMapping"]);
  ensure(hash(backup.runtimeSha256) && hash(backup.connectionSha256));
  keys(backup.roleMapping, ["version", "roles", "allowedDeltas"]);
  ensure(
    backup.roleMapping.version === 1 &&
      Array.isArray(backup.roleMapping.roles) &&
      Array.isArray(backup.roleMapping.allowedDeltas),
  );
  for (const item of backup.roleMapping.roles) keys(item, ["source", "target"]);
  keys(op.catalogCustody, ["workers", "guards"]);
  ensure(Array.isArray(op.catalogCustody.workers) && op.catalogCustody.workers.length <= 29);
  ensure(
    Array.isArray(op.catalogCustody.guards) &&
      op.catalogCustody.guards.length === 4 * op.catalogCustody.workers.length,
  );
  for (const worker of op.catalogCustody.workers) validateConfigurationContainer(worker);
  const guardPaths = new Set();
  for (const guard of op.catalogCustody.guards) {
    keys(guard, ["path", "sha256"]);
    const parts = typeof guard.path === "string" ? guard.path.split("/") : [];
    ensure(
      parts.length === 3 &&
        parts[0] === "catalog-bootstrap-operations" &&
        uuid(parts[1]) &&
        [
          "operation.json",
          "completed.json",
          "worker-created.json",
          "worker-terminal.json",
        ].includes(parts[2]) &&
        hash(guard.sha256) &&
        !guardPaths.has(guard.path),
    );
    guardPaths.add(guard.path);
  }

  const read = async (directory, relative, expected) => {
    const bytes = await readPrivateFile(directory, relative);
    ensure(digest(bytes) === expected);
    return bytes;
  };
  const verify = async () => {
    await verifyInstalledSources();
    const root = op.root;
    const host = dirname(root);
    const predecessorDir = `forward-recovery-operations/${operationId}`;
    const index = JSON.parse(await read(root, "upgrade-index.json", predecessor.indexSha256));
    ensure(index.kind === "platform-forward-recovery-index" && index.operationId === operationId);
    ensure(index.stateSha256 === predecessor.stateSha256);
    const previous = JSON.parse(
      await read(root, `${predecessorDir}/state.json`, predecessor.stateSha256),
    );
    ensure(
      previous.phase === "healthy" &&
        previous.status === "completed" &&
        previous.admission.identity.operationId === operationId &&
        sameTarget(previous.admission.identity.target, identity.target),
    );
    for (const [file, sha256] of [
      ["before-post-migration-activate.json", predecessor.beforeActivationSha256],
      ["prepare-consumption.json", predecessor.prepareConsumptionSha256],
      ["activate-consumption.json", predecessor.activateConsumptionSha256],
    ])
      await read(root, `${predecessorDir}/${file}`, sha256);
    const receipt = JSON.parse(await read(host, drift.receiptPath, drift.receiptSha256));
    ensure(
      receipt.runtimePath === join(host, runtime.path) && receipt.runtimeSha256 === runtime.sha256,
    );
    await read(host, runtime.path, runtime.sha256);
    await read(
      root,
      `healthy-forward-backup-runtime-${identity.operationId}.json`,
      backup.runtimeSha256,
    );
    await read(
      root,
      `healthy-forward-backup-connection-${identity.operationId}.json`,
      backup.connectionSha256,
    );
    ensure(
      (await fingerprintHostConfiguration({ root, ...configuration })).configurationSha256 ===
        identity.configurationSha256,
    );
    await verifyInstalledSources();
    return {
      predecessorIdentity: previous.admission.identity,
      candidateRuntime: {
        path: `${basename(root)}/candidates/${identity.operationId}/runtime.env`,
        sha256: configuration.runtimeSnapshot.sha256,
      },
    };
  };
  await verify();
  return verify;
}

export async function executeHealthyForwardRolloutOperation(loaded, options = {}) {
  const { record, receipt, operationDirectory, verifySources } = loaded;
  const op = record.operation;
  const { root, dockerConfig, predecessor, runtime, configuration } = op;
  const { identity } = op.admission;
  const preflightCheck = createHealthyForwardFailureRecorder(
    operationDirectory,
    identity.operationId,
  );
  const { predecessorIdentity, candidateRuntime } = await preflightCheck("validation", async () =>
    (await validateHealthyForwardRolloutOperation(loaded))(),
  );
  const operation = { root, dockerConfig, identity, configuration };
  const tokenBytes = await preflightCheck("verifyDispatch", async () => {
    const bytes = await readPrivateFile(operationDirectory, "github-token");
    ensure(bytes.length > 0 && !/\s/u.test(bytes.toString()));
    return bytes;
  });
  const token = tokenBytes.toString();
  const verifyAuthority = async () => {
    await verifySources();
    ensure((await readPrivateFile(operationDirectory, "github-token")).equals(tokenBytes));
  };
  const runProcess = async (request, recheck) => {
    await verifyAuthority();
    const run =
      options.runProcess ??
      (request.outputLimitBytes === 16 * 1048576 ? runHostArchiveProcess : runHostProcess);
    const result = await run(request, recheck);
    await verifyAuthority();
    return result;
  };
  const verifyDispatch = async (check = direct) => {
    await check("verifyDispatch", async () => {
      await verifyAuthority();
      same(
        await verifyUpgradeDispatch(record.dispatch, token, {
          actorLogin: record.authorization.actorLogin,
          request: options.request,
        }),
        record.authorization,
      );
    });
    await check("verifyCatalogPeers", () =>
      assertNoCatalogPeers(record.dispatch, token, options.request),
    );
  };
  const operationSha256 = digest(await readPrivateFile(operationDirectory, "operation.json"));
  const verifyMutation = async (enteredPhase) => {
    await verifyDispatch();
    const state = JSON.parse(
      await readPrivateFile(root, `healthy-forward-rollouts/${identity.operationId}/state.json`),
    );
    ensure(
      state.operationId === identity.operationId &&
        state.operationSha256 === operationSha256 &&
        state.phase === enteredPhase,
    );
  };
  const command = createDockerCommand(operation, runProcess);
  const candidate = await preflightCheck("inspectCandidate", () =>
    createHealthyForwardCandidateObserver(operation, runtime.observationPolicy, op.composeHashes, {
      verifyAuthority,
      runProcess,
      ambient: options.ambient,
    }),
  );
  const observation = { verifyAuthority, runProcess, readMachineId: options.readMachineId };
  let preflightInput;
  async function initialize() {
    await verifyDispatch(preflightCheck);
    await preflightCheck("verifyAdmission", () =>
      verifyAdmission(
        {
          operationDirectory,
          receipt,
          record: { installedRoot: record.installedRoot, deployment: operation },
        },
        runProcess,
        options.request,
      ),
    );
    const migrationProof = (selected) =>
      extractProductMigrationProof({
        root,
        identity: selected,
        verifySources: verifyAuthority,
        runProcess,
      });
    const predecessorMigrationProof = await preflightCheck("extractPredecessorMigrations", () =>
      migrationProof(predecessorIdentity),
    );
    const candidateMigrationProof = await preflightCheck("extractCandidateMigrations", () =>
      migrationProof(identity),
    );
    preflightInput = {
      root,
      predecessor,
      drift: op.drift,
      runtime,
      candidateRuntime,
      pinnedPublisherConfig: op.pinnedPublisherConfig,
      candidateIdentity: identity,
      predecessorMigrationProof,
      candidateMigrationProof,
    };
    await preflightCheck("verifyCompose", () => candidate.verifyCompose());
  }
  const custody = async (api) => {
    const env = await readProtectedEnv(join(dirname(root), runtime.path));
    await observeHealthyForwardCatalogCustody(
      {
        hostRoot: dirname(root),
        acceptedOperationId: predecessor.operationId,
        api,
        postgres: runtime.containers.postgres,
        observationPolicy: runtime.observationPolicy,
        workers: op.catalogCustody.workers,
        guards: new Map(op.catalogCustody.guards.map(({ path, sha256 }) => [path, sha256])),
        catalogEnvironment: {
          RELEASE_CATALOG_CACHE_DIR: env.RELEASE_CATALOG_CACHE_DIR,
          RELEASE_CATALOG_JOURNAL_DIR: env.RELEASE_CATALOG_JOURNAL_DIR,
        },
      },
      command,
    );
  };
  const observe = async (workload, check = direct) => {
    const result = await check("inspectSource", () => {
      ensure(preflightInput);
      return verifyHealthyForwardPreflight(preflightInput, observation, workload);
    });
    await check("verifyCatalogCustody", () => custody(result.containers.api));
    return result;
  };
  const sourceContainers = Object.fromEntries(
    Object.entries(runtime.containers).map(([service, container]) => [service, container.id]),
  );
  const workloads = await preflightCheck("inspectCandidate", () =>
    createHealthyForwardWorkloads(
      { root, dockerConfig, sourceContainers: runtime.containers },
      { candidate, observe, verifyAuthority, verifyMutation, runProcess },
    ),
  );
  return withHealthyForwardRollout(
    {
      root,
      operationId: identity.operationId,
      predecessorOperationId: predecessor.operationId,
      predecessorIndexSha256: predecessor.indexSha256,
      operationSha256,
      executorSha: identity.executorSha,
      backupRuntimeSha256: op.backupPolicy.runtimeSha256,
      postgresId: sourceContainers.postgres,
    },
    {
      verifyAuthority,
      preflight: async () => {
        if (!preflightInput) await initialize();
        await observe({ phase: "source-healthy" }, preflightCheck);
      },
      stopSource: workloads.stopSource,
      verifySourceStopped: workloads.verifySourceStopped,
      verifyBackup: async (capability) => {
        const observeSource = async () => {
          let inventory;
          await withStoppedHealthyForwardSource(preflightInput, observation, (value) => {
            inventory = value;
          });
          await custody(runtime.containers.api);
          return inventory;
        };
        const { owned } = await observeSource();
        const postgres = owned.find(({ service }) => service === "postgres").container;
        const hbaPath = postgres.Mounts.find(
          ({ Destination }) => Destination === "/etc/postgresql/pg_hba.conf",
        ).Source;
        const result = await createHeldHealthyForwardBackup(
          {
            operation,
            observationPolicy: runtime.observationPolicy,
            hbaPath,
            hbaSha256: receipt.files["deploy/platform/postgres/pg_hba.conf"],
            connectionFile: join(
              root,
              `healthy-forward-backup-connection-${identity.operationId}.json`,
            ),
            roleMapping: op.backupPolicy.roleMapping,
            verifySources: verifyAuthority,
          },
          capability,
          { observeSource, sourceContainers, runProcess },
        );
        return result.backupProofSha256;
      },
      activateApi: workloads.activateApi,
      activateEdge: workloads.activateEdge,
      verifyHealth: async (expected) => {
        await workloads.verifyWorkloads(expected);
        await verifyPlatformSmoke(operation, options.httpsRequest);
        return workloads.verifyWorkloads(expected);
      },
    },
  );
}

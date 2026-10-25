// Loaded only after upgrade-command authenticates the entire installed closure.
import { dirname, join } from "node:path";
import { canonical, digest, ensure, keys, runtime as validateRuntime } from "../backup/schemas.mjs";
import { readPrivateFile, assertPrivateRootSync, assertBindFileSync } from "./files.mjs";
import { readFile, lstat } from "node:fs/promises";
import { fingerprintHostConfiguration, hostChildEnvironment } from "./config.mjs";
import { readUpgradePredecessor } from "./upgrade-state.mjs";
import {
  readFailedUpgradePredecessor,
  validateForwardAdmission,
  validateForwardDecision,
} from "./forward-admission.mjs";
import { validateForwardJournal, withHeldForwardState } from "./forward-state.mjs";
import { captureForwardRetained, readForwardRetained } from "./forward-retained.mjs";
import { extractProductMigrationProof } from "./forward-product.mjs";
import { createForwardObservers, createForwardBaselineVerifier } from "./forward-observation.mjs";
import { validateObservationPolicy } from "./observe.mjs";
import { readProtectedEnv, validateConfig } from "../preflight.mjs";
import { validateCatalogConfig } from "../catalog-config.mjs";
import { validateUpgradeDispatch, verifyUpgradeDispatch } from "../upgrade-dispatch.mjs";
import { verifyAdmission } from "./command.mjs";
import { executeForwardPreparation } from "./forward-preparation.mjs";
import { executeForwardActivation } from "./forward-activation.mjs";
import { createForwardActivationAdapters } from "./forward-activation-adapters.mjs";
import { createHeldForwardBackup } from "./target-backup.mjs";
import { readVerifiedBackup } from "./backup-gate.mjs";
import { withHostState } from "./state.mjs";
import { carryHostFailure, sanitizeHostFailure, writeHostFailure } from "./failure-diagnostic.mjs";
import { runHostProcess, runHostArchiveProcess } from "./process.mjs";
const validated = new WeakMap();
const same = (a, b) => ensure(canonical(a) === canonical(b));
const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const preparing = (r) => r.phase === "post-migration-prepare";
async function failedHistory(root, admission) {
  const result = await readFailedUpgradePredecessor(root, admission.failed.identity.operationId);
  const index = JSON.parse(result.index);
  if (index.kind === "platform-forward-recovery-index") {
    ensure(index.operationId === admission.identity.operationId);
    result.index = await readPrivateFile(
      root,
      `forward-recovery-operations/${admission.identity.operationId}/predecessor-index.json`,
    );
  }
  return result;
}
async function historicalInstallation(root, kind, identity, expected, ci, dispatch) {
  ensure(hash(expected));
  const path = `${kind}-installed-executor-${identity.operationId}.json`;
  const bytes = await readPrivateFile(root, path);
  ensure(digest(bytes) === expected);
  const receipt = JSON.parse(bytes);
  keys(receipt, [
    "version",
    "kind",
    "operationId",
    "executorSha",
    "ci",
    "installationDispatch",
    "files",
  ]);
  ensure(
    receipt.version === 1 &&
      receipt.kind === `platform-${kind}-installed-executor` &&
      receipt.operationId === identity.operationId &&
      receipt.executorSha === identity.executorSha,
  );
  same(receipt.ci, ci);
  validateUpgradeDispatch(receipt.installationDispatch);
  ensure(receipt.installationDispatch.toolingSha === identity.executorSha);
  if (dispatch) same(receipt.installationDispatch, dispatch);
  const installed = join(dirname(root), `${kind}-bootstrap`, identity.executorSha);
  assertPrivateRootSync(installed);
  ensure(receipt.files && typeof receipt.files === "object" && !Array.isArray(receipt.files));
  const entries = Object.entries(receipt.files);
  ensure(entries.length > 0 && entries.length <= 256);
  const verify = async () => {
    ensure((await readPrivateFile(root, path)).equals(bytes));
    for (const [relative, sha] of entries) {
      ensure(
        /^deploy\/[a-zA-Z0-9_./-]+$/u.test(relative) &&
          !relative.split("/").some((p) => !p || p === "." || p === "..") &&
          hash(sha),
      );
      let content;
      if (relative === "deploy/platform/postgres/pg_hba.conf") {
        const p = join(installed, relative);
        assertBindFileSync(p);
        const st = await lstat(p);
        ensure([0, process.getuid()].includes(st.uid) && (st.mode & 0o7777) === 0o644);
        content = await readFile(p);
        assertBindFileSync(p);
      } else content = await readPrivateFile(installed, relative);
      ensure(digest(content) === sha);
    }
  };
  await verify();
  return verify;
}
export async function validateForwardOperation(loaded, options = {}) {
  const { record } = loaded,
    op = record.operation,
    admission = op.admission;
  ensure(
    record.kind === "platform-forward-recovery-host-operation" &&
      ["post-migration-prepare", "post-migration-activate"].includes(record.phase),
  );
  ensure(typeof loaded.verifyInstalledSources === "function");
  keys(record.historicalSources, ["recoveryReceiptSha256", "failedReceiptSha256"]);
  const original = await readUpgradePredecessor(op.root, admission.originalPredecessor.identity);
  const failed = await failedHistory(op.root, admission);
  for (const name of Object.keys(original))
    ensure(digest(original[name]) === admission.originalPredecessor.hashes[name]);
  for (const name of Object.keys(failed))
    ensure(digest(failed[name]) === admission.failed.hashes[name]);
  const predecessor = JSON.parse(original.activationOperation);
  same(record.observationPolicy, predecessor.observationPolicy);
  const policy = validateObservationPolicy(record.observationPolicy);
  ensure(
    policy.machineId === admission.identity.target.hostId &&
      policy.volume.name === admission.identity.target.volumeId,
  );
  same(op.predecessorContainers, admission.baseline.containers);
  const histories = await Promise.all([
    historicalInstallation(
      op.root,
      "recovery",
      admission.originalPredecessor.identity,
      record.historicalSources.recoveryReceiptSha256,
      predecessor.operation.activation.admission.executorCi,
    ),
    historicalInstallation(
      op.root,
      "upgrade",
      admission.failed.identity,
      record.historicalSources.failedReceiptSha256,
      JSON.parse(failed.prepareOperation).operation.admission.executorCi,
      JSON.parse(failed.prepareOperation).dispatch,
    ),
  ]);
  const retained = new Map();
  const retain = async (path) => {
    const b = await readPrivateFile(op.root, path);
    retained.set(path, b);
    return b;
  };
  for (const [path, executor] of [
    ["backup-runtime.json", JSON.parse(original.original).current.identity.executorSha],
    [
      `recovery-backup-runtime-${admission.originalPredecessor.identity.operationId}.json`,
      admission.originalPredecessor.identity.executorSha,
    ],
    [
      `upgrade-backup-runtime-${admission.failed.identity.operationId}.json`,
      admission.failed.identity.executorSha,
    ],
    [
      `forward-backup-runtime-${admission.identity.operationId}.json`,
      admission.identity.executorSha,
    ],
  ]) {
    const config = validateRuntime(JSON.parse(await retain(path)));
    ensure(
      config.executorSha === executor &&
        config.provenance === "live-source" &&
        config.dockerExecutable === "/usr/bin/docker" &&
        config.endpoint === "unix:///var/run/docker.sock",
    );
  }
  let prior, priorBytes, retainedRuntime;
  if (preparing(record)) {
    ensure(typeof op.connectionFile === "string" && op.connectionFile.startsWith(`${op.root}/`));
    await retain(op.connectionFile.slice(op.root.length + 1));
    keys(op.roleMapping, ["version", "roles", "allowedDeltas"]);
    ensure(
      op.roleMapping.version === 1 &&
        Array.isArray(op.roleMapping.roles) &&
        Array.isArray(op.roleMapping.allowedDeltas),
    );
    for (const r of op.roleMapping.roles) keys(r, ["source", "target"]);
    ensure(admission.phase === record.phase && Date.parse(admission.expiresAt) > Date.now());
  } else {
    retainedRuntime = (await readForwardRetained(op.root, admission)).bytes;
    priorBytes = await readPrivateFile(
      op.root,
      `forward-recovery-operations/${admission.identity.operationId}/state.json`,
    );
    prior = JSON.parse(priorBytes);
    validateForwardJournal(prior);
    same(prior.admission, admission);
    validateForwardDecision(op.decision, { priorBytes, prior, now: Date.now() });
    ensure(
      op.decision.phase === record.phase &&
        op.preparedTarget.version === 2 &&
        op.preparedTarget.provenance === "live-source" &&
        op.preparedPolicy.provenance === "live-source",
    );
    same(
      (
        await readVerifiedBackup({
          root: op.root,
          identity: admission.identity,
          ...op.preparedPolicy,
        })
      ).backupProof,
      prior.backup,
    );
  }
  const verify = async () => {
    await loaded.verifyInstalledSources();
    if (retainedRuntime)
      ensure((await readForwardRetained(op.root, admission)).bytes.equals(retainedRuntime));
    const currentOriginal = await readUpgradePredecessor(
        op.root,
        admission.originalPredecessor.identity,
      ),
      currentFailed = await failedHistory(op.root, admission);
    for (const key of Object.keys(original)) ensure(currentOriginal[key].equals(original[key]));
    for (const key of Object.keys(failed)) ensure(currentFailed[key].equals(failed[key]));
    for (const fn of histories) await fn();
    for (const [path, bytes] of retained)
      ensure((await readPrivateFile(op.root, path)).equals(bytes));
    for (const [configuration, sha] of [
      [op.configuration, admission.candidateConfigurationSha256],
      [
        JSON.parse(failed.activateOperation).operation.configuration,
        admission.failedConfigurationSha256,
      ],
      [predecessor.operation.activation.configuration, admission.oldConfigurationSha256],
    ]) {
      keys(configuration, ["candidateId", "runtimeSnapshot", "migrationSnapshot"]);
      ensure(
        (await fingerprintHostConfiguration({ root: op.root, ...configuration }))
          .configurationSha256 === sha,
      );
    }
    const env = await readProtectedEnv(op.configuration.runtimeSnapshot.path);
    validateConfig(env, admission.identity.admission.manifest);
    if (validateCatalogConfig(env)) ensure(env.RELEASE_CATALOG_WRITERS_ENABLED === "false");
    const interpolation = {
      ...op.configuration.runtimeSnapshot.interpolation,
      MARKIRO_PLATFORM_MIGRATION_ENV_FILE: op.configuration.migrationSnapshot.path,
    };
    for (const [key, value] of Object.entries(interpolation))
      same(
        value,
        key === "MARKIRO_PLATFORM_ENV_FILE"
          ? op.configuration.runtimeSnapshot.path
          : key === "MARKIRO_PLATFORM_MIGRATION_ENV_FILE"
            ? op.configuration.migrationSnapshot.path
            : env[key],
      );
    hostChildEnvironment({
      interpolation,
      dockerConfig: op.dockerConfig,
      ambient: options.ambient ?? process.env,
    });
  };
  await verify();
  const authorize = async () => {
    const token = String(await readPrivateFile(loaded.operationDirectory, "github-token")).trim();
    same(
      await verifyUpgradeDispatch(record.dispatch, token, {
        actorLogin: record.authorization.actorLogin,
        request: options.request,
      }),
      record.authorization,
    );
    await verifyAdmission(
      {
        operationDirectory: loaded.operationDirectory,
        receipt: loaded.receipt,
        record: {
          installedRoot: record.installedRoot,
          deployment: {
            root: op.root,
            dockerConfig: op.dockerConfig,
            identity: admission.identity,
            configuration: op.configuration,
          },
        },
      },
      async (request) => {
        await verify();
        const result = await (options.runProcess ?? runHostProcess)(request);
        await verify();
        return result;
      },
      options.request,
    );
    await verify();
    return admission.identity;
  };
  const initialize = async (recordFailure) => {
    ensure(typeof recordFailure === "function");
    let boundary = "verifyRelease",
      category = "validation";
    try {
      await authorize();
      let terminated = true;
      const runProcess = async (request, recheck) => {
        ensure(terminated);
        await verify();
        recheck?.();
        try {
          const archive =
            request.executable === "/usr/bin/docker" &&
            request.outputLimitBytes === 16 * 1024 * 1024 &&
            request.args.length === 5 &&
            request.args[2] === "cp" &&
            /^[a-f0-9]{64}:\/app\/node_modules\/@markiro\/db\/migrations\/(?:meta\/_journal\.json|[0-9]{4}_[a-z0-9_]{1,100}\.sql)$/u.test(
              request.args[3],
            ) &&
            request.args[4] === "-";
          const result = await (
            options.runProcess ?? (archive ? runHostArchiveProcess : runHostProcess)
          )(request, recheck);
          ensure(terminated);
          await verify();
          return result;
        } catch (e) {
          if (e?.terminationConfirmed === false) terminated = false;
          throw e;
        }
      };
      boundary = "verifyImages";
      category = "image-check";
      const productMigrationProof = await extractProductMigrationProof({
        root: op.root,
        identity: admission.identity,
        verifySources: verify,
        runProcess,
        beforeFailureCleanup: (error) => recordFailure(error, boundary, category),
      });
      boundary = "validation";
      category = "validation";
      validateForwardAdmission(admission, {
        failedBytes: failed,
        originalPredecessorBytes: original,
        productMigrationProof,
        now: preparing(record) ? Date.now() : Date.parse(admission.expiresAt) - 1,
      });
      await verify();
      const oldOperation = {
        root: op.root,
        dockerConfig: op.dockerConfig,
        identity: admission.originalPredecessor.identity,
        configuration: predecessor.operation.activation.configuration,
      };
      const candidateOperation = {
        root: op.root,
        dockerConfig: op.dockerConfig,
        identity: admission.identity,
        configuration: op.configuration,
      };
      const authority = {
        oldOperation,
        candidateOperation,
        retainedIds: admission.baseline.containers,
        baseline: admission.baseline,
        productMigrationProof,
        policy,
      };
      const dependencies = {
        runProcess,
        verifySources: verify,
        hbaSha256: loaded.receipt.files["deploy/platform/postgres/pg_hba.conf"],
      };
      const verifyBaseline = createForwardBaselineVerifier(authority, dependencies);
      return {
        productMigrationProof,
        verifyBaseline,
        oldOperation,
        candidateOperation,
        authority,
        dependencies,
        authorize,
        runProcess,
        captureRetained: async (cap) => {
          const result = await captureForwardRetained(
            { root: op.root, admission, postgresImageId: policy.postgresImageId, runProcess },
            cap,
          );
          retainedRuntime = result.bytes;
          await verify();
        },
      };
    } catch (error) {
      await recordFailure(error, boundary, category);
      throw error;
    }
  };
  validated.set(loaded, initialize);
  return verify;
}
export async function executeForwardOperation(loaded, options = {}) {
  const initialize = validated.get(loaded);
  ensure(typeof initialize === "function");
  const { record } = loaded,
    op = record.operation,
    admission = op.admission;
  let diagnosticAttempted = false;
  const recordFailure = async (error, boundary, commandCategory) => {
    if (diagnosticAttempted) return;
    diagnosticAttempted = true;
    try {
      await writeHostFailure(
        loaded.operationDirectory,
        sanitizeHostFailure(error, {
          operationId: admission.identity.operationId,
          phase: preparing(record) ? "admitted" : "activation-admitted",
          boundary,
          commandCategory,
        }),
      );
    } catch {
      const failure = carryHostFailure(
        error,
        new Error("Forward initializer diagnostic publication failed."),
      );
      failure.code = "ERR_UPGRADE_COMMAND";
      failure.durabilityUncertain = true;
      throw failure;
    }
  };
  // Delivery/fence/token publication precedes initialization. The common lock
  // covers all admission/image children; uncertain exit or diagnostics retain it.
  // Release it before the typed store takes the same lock and rechecks baseline.
  const trusted = await withHostState(op.root, async () => {
    try {
      await loaded.verifySources();
      return await initialize(recordFailure);
    } catch (error) {
      await recordFailure(error, "validation", "validation");
      throw error;
    }
  });
  await loaded.verifySources();
  const {
    productMigrationProof,
    verifyBaseline,
    oldOperation,
    candidateOperation,
    dependencies,
    authorize,
    runProcess,
  } = trusted;
  const observers = createForwardObservers(trusted.authority, dependencies);
  const storeOptions = { productMigrationProof, verifyBaseline };
  const verifyReleaseHeld = async (held) => {
    await held.verify();
    const identity = await authorize();
    await held.verify();
    return identity;
  };
  if (!preparing(record))
    return executeForwardActivation(
      {
        root: op.root,
        dockerConfig: op.dockerConfig,
        decision: op.decision,
        configuration: op.configuration,
        preparedTarget: op.preparedTarget,
        preparedPolicy: op.preparedPolicy,
      },
      {
        ...createForwardActivationAdapters(
          loaded,
          oldOperation,
          verifyReleaseHeld,
          await readVerifiedBackup({
            root: op.root,
            identity: admission.identity,
            ...op.preparedPolicy,
          }),
          {
            ...dependencies,
            ...(options.httpsRequest ? { httpsRequest: options.httpsRequest } : {}),
          },
        ),
        runProcess,
        ...(options.signal ? { signal: options.signal } : {}),
        inspectCandidate: (_context, cap) => observers.inspectCandidate(cap),
        inspectSchema: (_context, cap) => observers.inspectSchema(cap),
      },
      storeOptions,
    );
  return executeForwardPreparation(
    { root: op.root, admission, configuration: op.configuration },
    {
      verifyAdmission: async (_context, cap) => {
        const identity = await withHeldForwardState(cap, verifyReleaseHeld);
        await trusted.captureRetained(cap);
        return identity;
      },
      inspectSource: (_context, cap) => observers.inspectSource(cap),
      inspectSchema: (_context, cap) => observers.inspectSchema(cap),
      createBackup: (_context, cap, beforeFailureCleanup) =>
        withHeldForwardState(cap, async (held) => {
          await held.verify();
          const response = await runProcess({
            executable: "/usr/bin/docker",
            args: [
              "--host",
              "unix:///var/run/docker.sock",
              "container",
              "inspect",
              admission.baseline.containers.postgres,
            ],
            cwd: op.root,
            env: {
              PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
              LANG: "C.UTF-8",
              DOCKER_CONFIG: op.dockerConfig,
            },
            timeoutMs: 30000,
            outputLimitBytes: 1048576,
          });
          const rows = JSON.parse(String(response.stdout));
          ensure(
            Array.isArray(rows) &&
              rows.length === 1 &&
              rows[0].Id === admission.baseline.containers.postgres,
          );
          const mounts = rows[0].Mounts.filter(
            (m) => m.Destination === "/etc/postgresql/pg_hba.conf",
          );
          ensure(mounts.length === 1 && typeof mounts[0].Source === "string");
          await held.verify();
          const result = await createHeldForwardBackup(
            {
              operation: candidateOperation,
              observationPolicy: record.observationPolicy,
              hbaPath: mounts[0].Source,
              hbaSha256: dependencies.hbaSha256,
              connectionFile: op.connectionFile,
              roleMapping: op.roleMapping,
              verifySources: loaded.verifySources,
            },
            cap,
            admission,
            { ...dependencies, productMigrationProof, beforeFailureCleanup },
          );
          return {
            backup: result.backup,
            restoreEvidence: result.restoreEvidence,
            fence: result.fence,
          };
        }),
    },
    storeOptions,
  );
}

// Evaluated only after the separate upgrade loader verifies all installed bytes.
import { canonical, ensure, keys, runtime as validateRuntime } from "../backup/schemas.mjs";
import { readPrivateFile } from "./files.mjs";
import { fingerprintHostConfiguration, hostChildEnvironment } from "./config.mjs";
import { validateUpgradeAdmission } from "./upgrade-admission.mjs";
import { readUpgradePredecessor } from "./upgrade-state.mjs";
import {
  validateUpgradePhaseAdmission,
  validateUpgradeJournal,
} from "./upgrade-phase-admission.mjs";
import { validateObservationPolicy } from "./observe.mjs";
import { readVerifiedBackup } from "./backup-gate.mjs";
import { readProtectedEnv, validateConfig } from "../preflight.mjs";
import { validateCatalogConfig } from "../catalog-config.mjs";
import { withHeldUpgradeState } from "./upgrade-state.mjs";
import { createUpgradeObservers } from "./upgrade-observation.mjs";
import { createUpgradeSchemaObserver } from "./upgrade-schema.mjs";
import { createUpgradeWorkloadCommands } from "./upgrade-workloads.mjs";
import { executeUpgradeActivation } from "./upgrade-activation.mjs";
import { createUpgradeActivationAdapters } from "./upgrade-activation-adapters.mjs";
import { executeUpgradeReturn } from "./upgrade-return.mjs";
import { executeUpgradePreparation } from "./upgrade-preparation.mjs";
import { createHeldUpgradeBackup } from "./target-backup.mjs";
import { verifyAdmission, verifyPlatformSmoke } from "./command.mjs";
import { verifyUpgradeDispatch } from "../upgrade-dispatch.mjs";
import { runHostProcess } from "./process.mjs";
const validated = new WeakSet();
const same = (a, b) => ensure(canonical(a) === canonical(b));
export async function validateUpgradeOperation(loaded, options = {}) {
  const { record } = loaded,
    op = record.operation,
    admission = op.admission;
  const predecessorBytes = await readUpgradePredecessor(op.root, admission.predecessor.identity);
  const historicalNow = Date.parse(admission.expiresAt) - 1;
  validateUpgradeAdmission(admission, {
    predecessorBytes,
    now: record.phase === "prepare" ? Date.now() : historicalNow,
  });
  const predecessor = JSON.parse(predecessorBytes.activationOperation);
  same(record.observationPolicy, predecessor.observationPolicy);
  const policy = validateObservationPolicy(record.observationPolicy);
  ensure(
    policy.machineId === admission.identity.target.hostId &&
      policy.volume.name === admission.identity.target.volumeId,
  );
  keys(op.predecessorContainers, ["postgres", "api", "edge"]);
  ensure(
    new Set(Object.values(op.predecessorContainers)).size === 3 &&
      Object.values(op.predecessorContainers).every(
        (v) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v),
      ),
  );
  const retained = new Map();
  const retain = async (path) => {
    const bytes = await readPrivateFile(op.root, path);
    retained.set(path, bytes);
    return bytes;
  };
  for (const [path, executor] of [
    ["backup-runtime.json", JSON.parse(predecessorBytes.original).current.identity.executorSha],
    [
      `recovery-backup-runtime-${admission.predecessor.identity.operationId}.json`,
      admission.predecessor.identity.executorSha,
    ],
    [
      `upgrade-backup-runtime-${admission.identity.operationId}.json`,
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
  if (record.phase === "prepare") {
    ensure(typeof op.connectionFile === "string" && op.connectionFile.startsWith(`${op.root}/`));
    await retain(op.connectionFile.slice(op.root.length + 1));
    keys(op.roleMapping, ["version", "roles", "allowedDeltas"]);
    ensure(
      op.roleMapping.version === 1 &&
        Array.isArray(op.roleMapping.roles) &&
        Array.isArray(op.roleMapping.allowedDeltas),
    );
    for (const role of op.roleMapping.roles) keys(role, ["source", "target"]);
  } else {
    const priorBytes = await readPrivateFile(
      op.root,
      `upgrade-operations/${admission.identity.operationId}/state.json`,
    );
    const prior = JSON.parse(priorBytes);
    // The guarded store validates archived history before any transition. Here
    // bind this exact current state and fresh decision without consuming either.
    validateUpgradePhaseAdmission(op.decision, { priorBytes, prior, now: Date.now() });
    same(prior.admission, admission);
    same(prior.oldRuntime.containers, op.predecessorContainers);
    if (!prior.decision) validateUpgradeJournal(prior);
    ensure(op.decision.phase === record.phase);
    if (record.phase === "activate") {
      ensure(
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
  }
  const verify = async () => {
    const current = await readUpgradePredecessor(op.root, admission.predecessor.identity);
    for (const key of Object.keys(predecessorBytes))
      ensure(current[key].equals(predecessorBytes[key]));
    for (const [path, bytes] of retained)
      ensure((await readPrivateFile(op.root, path)).equals(bytes));
    for (const [configuration, expected] of [
      [op.configuration, admission.candidateConfigurationSha256],
      [predecessor.operation.activation.configuration, admission.oldConfigurationSha256],
    ]) {
      keys(configuration, ["candidateId", "runtimeSnapshot", "migrationSnapshot"]);
      ensure(
        (await fingerprintHostConfiguration({ root: op.root, ...configuration }))
          .configurationSha256 === expected,
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
  validated.add(loaded);
  return verify;
}

export async function executeUpgradeOperation(loaded, options = {}) {
  ensure(validated.has(loaded));
  const { record } = loaded,
    op = record.operation,
    admission = op.admission;
  ensure(["prepare", "activate", "return-old"].includes(record.phase));
  const predecessor = JSON.parse(
    (await readUpgradePredecessor(op.root, admission.predecessor.identity)).activationOperation,
  );
  const oldOperation = {
    root: op.root,
    dockerConfig: op.dockerConfig,
    identity: admission.predecessor.identity,
    configuration: predecessor.operation.activation.configuration,
  };
  const candidateOperation = {
    root: op.root,
    dockerConfig: op.dockerConfig,
    identity: admission.identity,
    configuration: op.configuration,
  };
  let terminated = true,
    hbaPath;
  const check = async () => {
    ensure(terminated);
    await loaded.verifySources();
  };
  const runProcess = async (request, recheck) => {
    await check();
    recheck?.();
    try {
      const result = await (options.runProcess ?? runHostProcess)(request, recheck);
      await check();
      return result;
    } catch (error) {
      if (error?.terminationConfirmed === false) terminated = false;
      throw error;
    }
  };
  const dependencies = { ...options, runProcess, verifySources: check };
  const authority = {
    oldOperation,
    candidateOperation,
    predecessorContainers: op.predecessorContainers,
    policy: record.observationPolicy,
  };
  const observers = createUpgradeObservers(authority, dependencies);
  const commands = createUpgradeWorkloadCommands(authority, dependencies);
  const schema = createUpgradeSchemaObserver(
    { postgresId: op.predecessorContainers.postgres },
    dependencies,
  );
  const verifyReleaseHeld = async (held) => {
    await held.verify();
    await check();
    const token = String(await readPrivateFile(loaded.operationDirectory, "github-token")).trim();
    same(
      await verifyUpgradeDispatch(record.dispatch, token, {
        actorLogin: record.authorization.actorLogin,
        request: options.request,
      }),
      record.authorization,
    );
    await held.verify();
    await check();
    await verifyAdmission(
      {
        operationDirectory: loaded.operationDirectory,
        receipt: loaded.receipt,
        record: { installedRoot: record.installedRoot, deployment: candidateOperation },
      },
      async (request) => {
        await held.verify();
        const result = await runProcess(request);
        await held.verify();
        return result;
      },
      options.request,
    );
    await held.verify();
    await check();
    return admission.identity;
  };
  const verifyRelease = (cap) => withHeldUpgradeState(cap, verifyReleaseHeld);
  if (record.phase === "activate")
    return executeUpgradeActivation(
      {
        root: op.root,
        dockerConfig: op.dockerConfig,
        decision: op.decision,
        configuration: op.configuration,
        preparedTarget: op.preparedTarget,
        preparedPolicy: op.preparedPolicy,
      },
      {
        ...createUpgradeActivationAdapters(
          loaded,
          oldOperation,
          verifyReleaseHeld,
          await readVerifiedBackup({
            root: op.root,
            identity: admission.identity,
            ...op.preparedPolicy,
          }),
          dependencies,
        ),
        runProcess,
        ...(options.signal ? { signal: options.signal } : {}),
        inspectStoppedOld: (_context, cap) => observers.inspectStoppedOld(cap),
        inspectCandidate: (_context, cap) => observers.inspectCandidate(cap),
        inspectSchema: (_context, cap) => schema(cap),
      },
    );
  if (record.phase === "return-old")
    return executeUpgradeReturn(
      { root: op.root, decision: op.decision },
      {
        verifyAdmission: (_context, cap) => verifyRelease(cap),
        inspectReturnEligibility: (_context, cap) => observers.inspectReturnEligibility(cap),
        inspectSchema: (_context, cap) => schema(cap),
        startOldApi: (_context, cap) => commands.startOldApi(cap),
        startOldEdge: (_context, cap) => commands.startOldEdge(cap),
        verifyOldHealth: (_context, cap) => commands.verifyOldHealth(cap),
        cleanupOwnedStarts: (_context, cap) => commands.cleanupOwnedStarts(cap),
        smoke: (_context, cap) =>
          withHeldUpgradeState(cap, async (held) => {
            await held.verify();
            await check();
            await verifyPlatformSmoke(oldOperation, options.httpsRequest);
            await held.verify();
            await check();
          }),
      },
    );
  return executeUpgradePreparation(
    { root: op.root, admission },
    {
      verifyAdmission: (_context, cap) => verifyRelease(cap),
      inspectOld: (_context, cap) => observers.inspectOld(cap),
      inspectStoppedOld: async (_context, cap) => {
        const source = await observers.inspectBackupSource(cap);
        if (hbaPath) ensure(hbaPath === source.hbaPath);
        hbaPath = source.hbaPath;
        return source.observation;
      },
      inspectSchema: (_context, cap) => schema(cap),
      stopOldEdge: (_context, cap) => commands.stopOldEdge(cap),
      stopOldApi: (_context, cap) => commands.stopOldApi(cap),
      createBackup: async (_context, cap) => {
        ensure(typeof hbaPath === "string");
        // This fixed HBA mount is re-observed and byte-checked by the held backup
        // producer before it can fence/read the source; no host path from JSON.
        const result = await createHeldUpgradeBackup(
          {
            operation: candidateOperation,
            observationPolicy: record.observationPolicy,
            hbaPath,
            hbaSha256: loaded.receipt.files["deploy/platform/postgres/pg_hba.conf"],
            connectionFile: op.connectionFile,
            roleMapping: op.roleMapping,
            verifySources: check,
          },
          cap,
          admission,
          dependencies,
        );
        return upgradeBackupResult(admission.identity, result);
      },
    },
  );
}

// Project the archive producer output into the journal proof contract.
export function upgradeBackupResult(identity, result) {
  return {
    backup: {
      operationId: identity.operationId,
      target: identity.target,
      archiveSha256: result.backup.archiveSha256,
      restoreEvidenceSha256: result.restoreEvidence.evidenceSha256,
    },
    fence: result.fence,
  };
}

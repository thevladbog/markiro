// Imported only by the trusted loader after all recovery source hashes match.
import { validateRecoveryBackupRuntime } from "../backup/local-runtime.mjs";
import { canonical, ensure, keys } from "../backup/schemas.mjs";
import { readPrivateFile, assertPrivateRootSync } from "./files.mjs";
import { fingerprintHostConfiguration, hostChildEnvironment } from "./config.mjs";
import { validateRecoveryAdmission } from "./recovery-admission.mjs";
import { validateRecoveryActivationAdmission } from "./recovery-activation-admission.mjs";
import { createHostObservers, validateObservationPolicy } from "./observe.mjs";
import { observePostgresAdmin } from "./probe.mjs";
import { runHostProcess } from "./process.mjs";
import { createHostAdapters, verifyAdmission } from "./command.mjs";
import { readVerifiedBackup } from "./backup-gate.mjs";
import { createHeldTargetRecoveryBackup } from "./target-backup.mjs";
import { executeRecoveryPreparation } from "./recovery-preparation.mjs";
import { executeRecoveryActivation } from "./recovery-activation.mjs";
const preparationRuntimes = new WeakMap();
const same = (a, b) => ensure(canonical(a) === canonical(b));
const admissionOf = (record) =>
  record.phase === "prepare" ? record.operation.admission : record.operation.activation.admission;
function operationOf(record) {
  const op = record.operation;
  const admission = admissionOf(record);
  return {
    root: op.root,
    identity: admission.identity,
    configuration: record.phase === "prepare" ? op.configuration : op.activation.configuration,
    dockerConfig: op.dockerConfig,
  };
}
async function checkConfiguration(op, options) {
  keys(op.configuration, ["candidateId", "runtimeSnapshot", "migrationSnapshot"]);
  ensure(
    (await fingerprintHostConfiguration({ root: op.root, ...op.configuration }))
      .configurationSha256 === op.identity.configurationSha256,
  );
  hostChildEnvironment({
    interpolation: {
      ...op.configuration.runtimeSnapshot.interpolation,
      MARKIRO_PLATFORM_MIGRATION_ENV_FILE: op.configuration.migrationSnapshot.path,
    },
    dockerConfig: op.dockerConfig,
    ambient: options.ambient ?? process.env,
  });
}
export async function validateRecoveryOperation(loaded, options = {}) {
  const { record } = loaded;
  const op = operationOf(record);
  const admission = admissionOf(record);
  const stateBytes = await readPrivateFile(op.root, "state.json");
  if (record.phase === "prepare") {
    validateRecoveryAdmission(admission, { stateBytes, now: Date.now() });
    preparationRuntimes.set(loaded, await validateRecoveryBackupRuntime(op.root, admission));
    ensure(
      typeof record.operation.connectionFile === "string" &&
        record.operation.connectionFile.startsWith(`${op.root}/`),
    );
    keys(record.operation.roleMapping, ["version", "roles", "allowedDeltas"]);
    ensure(
      record.operation.roleMapping.version === 1 &&
        Array.isArray(record.operation.roleMapping.roles) &&
        Array.isArray(record.operation.roleMapping.allowedDeltas),
    );
    for (const role of record.operation.roleMapping.roles) keys(role, ["source", "target"]);
    // Validate the actual private descriptor now; the held producer validates its
    // complete connection/role/runtime contract under the shared owner later.
    await readPrivateFile(op.root, record.operation.connectionFile.slice(op.root.length + 1));
  } else {
    const activation = validateRecoveryActivationAdmission(record.operation.activation, {
      stateBytes,
      preparationBytes: await readPrivateFile(op.root, "recovery-state.json"),
      now: Date.now(),
    });
    same(activation.dispatch, record.dispatch);
    await readVerifiedBackup({
      root: op.root,
      identity: op.identity,
      ...activation.preparedPolicy,
    });
  }
  assertPrivateRootSync(op.dockerConfig);
  const policy = validateObservationPolicy(record.observationPolicy);
  ensure(
    op.identity.target.hostId === policy.machineId &&
      op.identity.target.volumeId === policy.volume.name &&
      /^[1-9][0-9]{0,19}$/u.test(op.identity.target.databaseId),
  );
  await checkConfiguration(op, options);
}
// This internal projection is constructed from a separately verified recovery
// envelope. It reuses adapter primitives only, never loadHostOperation and never
// reads/writes the ordinary installed receipt or ordinary journal.
function adapterInput(loaded, verified) {
  const { record } = loaded;
  const op = operationOf(record);
  return {
    operationDirectory: loaded.operationDirectory,
    receipt: loaded.receipt,
    verifySources: loaded.verifySources,
    verified,
    record: {
      installedRoot: record.installedRoot,
      observationPolicy: record.observationPolicy,
      deployment: {
        ...op,
        ...(record.phase === "activate"
          ? {
              preparedTarget: record.operation.activation.preparedTarget,
              preparedPolicy: record.operation.activation.preparedPolicy,
            }
          : {}),
      },
    },
  };
}
export async function executeRecoveryOperation(loaded, options = {}) {
  const op = operationOf(loaded.record);
  const admission = admissionOf(loaded.record);
  let terminated = true;
  const admittedAt = Date.now();
  const checkIdentity = async (now) => {
    ensure(terminated);
    await loaded.verifySources();
    if (loaded.record.phase === "prepare") {
      const expected = preparationRuntimes.get(loaded);
      ensure(expected);
      const current = await validateRecoveryBackupRuntime(op.root, admission);
      ensure(current.bytes.equals(expected.bytes) && current.original.equals(expected.original));
    }
    validateRecoveryAdmission(admission, {
      stateBytes: await readPrivateFile(op.root, "state.json"),
      now: now ?? Date.now(),
    });
    await checkConfiguration(op, options);
  };
  const check = () => checkIdentity();
  const runProcess = async (request, recheck) => {
    await check();
    ensure(recheck === undefined || typeof recheck === "function");
    // Only the installed coordinator supplies this function. It cannot come
    // from JSON, and executes after every asynchronous pre-spawn check.
    recheck?.();
    try {
      const result = await (options.runProcess ?? runHostProcess)(request);
      await check();
      return result;
    } catch (error) {
      if (error?.terminationConfirmed === false) terminated = false;
      throw error;
    }
  };
  const internal = adapterInput(loaded);
  const verifyRelease = async () => {
    await check();
    await verifyAdmission(internal, runProcess, options.request);
    await check();
  };
  try {
    if (loaded.record.phase === "activate") {
      const verified = await readVerifiedBackup({
        root: op.root,
        identity: op.identity,
        ...loaded.record.operation.activation.preparedPolicy,
      });
      const adapters = await createHostAdapters(adapterInput(loaded, verified), {
        ...options,
        runProcess,
      });
      // This runner never escapes this installed cleanup closure. It can issue
      // only observer reads and the exact owned IDs collected by that observer;
      // no caller-provided runner, command or freshness flag reaches it.
      const cleanupOwnedWorkloads = async (context) => {
        await checkIdentity(admittedAt);
        const runCleanup = async (request) => {
          await checkIdentity(admittedAt);
          try {
            const result = await (options.runProcess ?? runHostProcess)(request);
            await checkIdentity(admittedAt);
            return result;
          } catch (error) {
            if (error?.terminationConfirmed === false) terminated = false;
            throw error;
          }
        };
        const cleanupObservers = createHostObservers(op, loaded.record.observationPolicy, {
          runProcess: runCleanup,
          ...(options.readMachineId ? { readMachineId: options.readMachineId } : {}),
        });
        const ownedContext = { ...context, allowedServices: ["postgres", "api", "edge"] };
        const state = await cleanupObservers.inventory(ownedContext);
        for (const service of ["edge", "api"]) {
          const owned = state.owned.find((value) => value.service === service);
          if (owned?.active)
            await cleanupObservers.command(
              ["container", "stop", "--time", "10", owned.container.Id],
              true,
            );
        }
        await cleanupObservers.inspectStoppedWorkloads({
          ...ownedContext,
          allowedServices: ["postgres"],
        });
        await checkIdentity(admittedAt);
      };
      return await executeRecoveryActivation(loaded.record.operation, {
        ...adapters,
        cleanupOwnedWorkloads,
      });
    }
    const policy = loaded.record.observationPolicy;
    const observers = createHostObservers(op, policy, { ...options, runProcess });
    let mountedHbaPath;
    const context = (allowedServices) => ({
      ...op,
      project: "markiro-platform",
      phase: "target-stopped",
      boundary: "recovery",
      allowedServices,
    });
    const inspect = async (allowedServices) => {
      await check();
      const current = await observers.inventory(context(allowedServices));
      await check();
      return current;
    };
    return await executeRecoveryPreparation(
      { root: op.root, admission },
      {
        verifyAdmission: async () => {
          await verifyRelease();
          return admission.identity;
        },
        inspectTarget: async () => {
          await inspect(["postgres", "api", "edge"]);
          return { project: "markiro-platform", target: op.identity.target };
        },
        stopOwnedWorkloads: async () => {
          const state = await inspect(["postgres", "api", "edge"]);
          // Stop exact container IDs after full inventory/ownership verification;
          // never issue a project-wide stop against unobserved resources.
          for (const service of ["edge", "api"]) {
            const owned = state.owned.find((v) => v.service === service);
            if (owned?.active) await observers.command(["container", "stop", owned.container.Id]);
          }
          await check();
        },
        inspectStoppedWorkloads: async () => {
          const state = await inspect(["postgres"]);
          await observePostgresAdmin({
            context: context(["postgres"]),
            state,
            command: observers.command,
            hbaSha256: loaded.receipt.files["deploy/platform/postgres/pg_hba.conf"],
          });
          mountedHbaPath = state.owned
            .find((v) => v.service === "postgres")
            .container.Mounts.find((m) => m.Destination === "/etc/postgresql/pg_hba.conf")?.Source;
          ensure(typeof mountedHbaPath === "string");
          await check();
          return { project: "markiro-platform", target: op.identity.target, active: [] };
        },
        createBackup: async (_context, capability) => {
          const result = await createHeldTargetRecoveryBackup(
            {
              operation: op,
              observationPolicy: policy,
              hbaPath: mountedHbaPath,
              hbaSha256: loaded.receipt.files["deploy/platform/postgres/pg_hba.conf"],
              connectionFile: loaded.record.operation.connectionFile,
              roleMapping: loaded.record.operation.roleMapping,
              verifySources: check,
            },
            capability,
            admission,
            { ...options, runProcess },
          );
          return {
            operationId: op.identity.operationId,
            target: op.identity.target,
            archiveSha256: result.backup.archiveSha256,
            restoreEvidenceSha256: result.restoreEvidence.evidenceSha256,
          };
        },
      },
    );
  } catch (error) {
    if (!terminated) error.terminationConfirmed = false;
    throw error;
  }
}

/** Trusted operator library; no serialized callbacks, observations or remote CLI. */
import { CATALOG_ROOT } from "../catalog-config.mjs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { connection, ensure, hash, keys, plain, runtime } from "../backup/schemas.mjs";
import {
  readPrivateAbsolute,
  withRecoveryBackupRuntime,
  withUpgradeBackupRuntime,
  readBackupRuntime,
} from "../backup/local-runtime.mjs";
import { createDatabaseBackup } from "../backup/archive.mjs";
import { verifyDatabaseRestore } from "../backup/restore.mjs";
import { assertBindFileSync, assertPrivateRootSync, readPrivateFile } from "./files.mjs";
import { fingerprintHostConfiguration } from "./config.mjs";
import {
  createHostObservers,
  createAcceptedRecoveryObservers,
  validateObservationPolicy,
} from "./observe.mjs";
import { observePostgresAdmin } from "./probe.mjs";
import { runHostProcess } from "./process.mjs";
import { withHostState } from "./state.mjs";
import { snapshotActivation } from "./recovery-activation-admission.mjs";
import { snapshot, sameTarget, validateIdentity } from "./state-validation.mjs";
import { canonical } from "../backup/schemas.mjs";
import { validateRecoveryAdmission } from "./recovery-admission.mjs";
import { hostFenceEnforcementSha256 } from "./command.mjs";

function targetBackupError(error, terminated, stage) {
  const result = new Error("Target recovery backup failed.");
  result.code = "ERR_TARGET_BACKUP";
  result.targetBackupStage = stage;
  result.recoveryRequired = true;
  if (!terminated || error?.terminationConfirmed === false) result.terminationConfirmed = false;
  if (error?.durabilityUncertain === true) result.durabilityUncertain = true;
  if (error?.lockRetirementUncertain === true) result.lockRetirementUncertain = true;
  return result;
}

// Deliberately matches the worker's narrow libpq file contract, with the target
// host/database/port fixed rather than accepting another valid service endpoint.
function validateConnectionFiles(serviceBytes, passwordBytes) {
  const lines = String(serviceBytes).trim().split("\n");
  ensure(lines.shift() === "[backup]");
  const fields = {};
  for (const line of lines) {
    const i = line.indexOf("=");
    ensure(i > 0 && !Object.hasOwn(fields, line.slice(0, i)));
    fields[line.slice(0, i)] = line.slice(i + 1);
  }
  keys(fields, ["host", "port", "dbname", "user", "sslmode", "sslrootcert"]);
  ensure(
    fields.host === "db.private" &&
      fields.port === "5432" &&
      fields.dbname === "markiro" &&
      fields.sslmode === "verify-full" &&
      fields.sslrootcert === "/input/ca.crt" &&
      typeof fields.user === "string" &&
      /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/u.test(fields.user),
  );
  const rows = String(passwordBytes).trim().split("\n");
  ensure(rows.length === 1);
  const parts = rows[0].split(":");
  ensure(
    parts.length === 5 &&
      parts.slice(0, 4).join(":") === `db.private:5432:markiro:${fields.user}` &&
      /^[a-zA-Z0-9_-]{24,}$/u.test(parts[4]),
  );
}

export async function createTargetRecoveryBackup(input, options = {}) {
  return produceTargetBackup(input, options, (root, action) =>
    withHostState(root, async (store) => {
      const journal = await store.read();
      ensure(
        !journal.current ||
          (journal.current.phase === "healthy" &&
            journal.current.status === "completed" &&
            sameTarget(journal.current.identity.target, input.operation.identity.target)),
      );
      return action(journal);
    }),
  );
}

export async function createHeldTargetRecoveryBackup(input, capability, admission, options = {}) {
  const admitted = snapshot(admission);
  return withRecoveryBackupRuntime(capability, async ({ root, state }, createRuntime) => {
    ensure(root === input.operation.root);
    const ledgerBytes = await readPrivateFile(root, "recovery-state.json");
    const check = async () => {
      const verified = validateRecoveryAdmission(admitted, {
        stateBytes: await readPrivateFile(root, "state.json"),
        now: Date.now(),
      });
      ensure(canonical(verified.identity) === canonical(input.operation.identity));
      ensure((await readPrivateFile(root, "recovery-state.json")).equals(ledgerBytes));
      const ledger = JSON.parse(ledgerBytes);
      keys(ledger, ["version", "admission", "sequence", "phase", "status", "backup"]);
      ensure(
        ledger.version === 1 &&
          ledger.sequence === 5 &&
          ledger.phase === "backup-verified" &&
          ledger.status === "entered" &&
          ledger.backup === null &&
          canonical(ledger.admission) === canonical(verified),
      );
    };
    await check();
    const recoveryRuntime = await createRuntime(admitted);
    return produceTargetBackup(
      {
        ...input,
        recoveryRuntime,
        verifySources: async () => {
          await check();
          await input.verifySources();
          await check();
        },
      },
      options,
      async (actualRoot, action) => {
        ensure(actualRoot === root);
        return action(state);
      },
    );
  });
}

// The old source authority comes from the held accepted-recovery chain. The new
// backup identity/runtime belongs to this upgrade; no old executor is relabeled.
export async function createHeldUpgradeBackup(input, capability, admission, options = {}) {
  const admitted = snapshotActivation(admission);
  return withUpgradeBackupRuntime(capability, async (held, recoveryRuntime) => {
    const { root, state, predecessor } = held;
    ensure(root === input.operation.root);
    ensure(canonical(admitted) === canonical(state.admission));
    ensure(canonical(input.operation.identity) === canonical(admitted.identity));
    ensure(canonical(input.observationPolicy) === canonical(predecessor.observationPolicy));
    const oldOperation = {
      root,
      dockerConfig: input.operation.dockerConfig,
      identity: admitted.predecessor.identity,
      configuration: predecessor.operation.activation.configuration,
    };
    const check = async () => {
      await held.verify();
      ensure(
        (await fingerprintHostConfiguration({ root, ...input.operation.configuration }))
          .configurationSha256 === admitted.candidateConfigurationSha256,
      );
      ensure(
        (await fingerprintHostConfiguration({ root, ...oldOperation.configuration }))
          .configurationSha256 === admitted.oldConfigurationSha256,
      );
    };
    await check();
    return produceTargetBackup(
      {
        ...input,
        recoveryRuntime,
        verifySources: async () => {
          await check();
          await input.verifySources();
          await check();
        },
      },
      {
        ...options,
        runProcess: async (request) => {
          await check();
          const result = await (options.runProcess ?? runHostProcess)(request);
          await check();
          return result;
        },
      },
      async (actualRoot, action) => {
        ensure(actualRoot === root);
        return action({ current: null });
      },
      { operation: oldOperation, containers: state.oldRuntime.containers },
    );
  });
}

async function produceTargetBackup(
  {
    operation,
    observationPolicy,
    hbaPath,
    hbaSha256,
    connectionFile,
    roleMapping,
    verifySources,
    recoveryRuntime,
  },
  options,
  withOwner,
  upgradeSource,
) {
  let terminated = true,
    uncertain = false,
    stage = "input-validation";
  try {
    const op = plain(operation);
    keys(op, ["root", "identity", "configuration", "dockerConfig"]);
    validateIdentity(op.identity);
    keys(op.configuration, ["candidateId", "runtimeSnapshot", "migrationSnapshot"]);
    assertPrivateRootSync(op.root);
    assertPrivateRootSync(op.dockerConfig);
    ensure(op.dockerConfig === join(op.root, "docker"));
    ensure(typeof verifySources === "function" && hash(hbaSha256));
    const mapping = plain(roleMapping);
    const policy = validateObservationPolicy(observationPolicy);
    ensure(
      op.identity.target.hostId === policy.machineId &&
        op.identity.target.volumeId === policy.volume.name &&
        /^[1-9][0-9]{0,19}$/u.test(op.identity.target.databaseId),
    );
    const run = async (request) => {
      // An unreaped child can still mutate Docker state; do not issue even
      // cleanup commands until an operator has resolved that uncertainty.
      ensure(terminated);
      try {
        return await (options.runProcess ?? runHostProcess)(request);
      } catch (error) {
        if (error.terminationConfirmed === false) terminated = false;
        uncertain ||= error.durabilityUncertain === true;
        throw error;
      }
    };
    stage = "host-state";
    return await withOwner(op.root, async (journal) => {
      let producerInFlight = false;
      try {
        // Snapshot the actual private files; every boundary must still read the
        // same bytes, including after isolated restore has removed its workers.
        stage = "private-inputs";
        const runtimeBytes = await readBackupRuntime(
          op.root,
          op.identity.operationId,
          recoveryRuntime,
        );
        const config = runtime(JSON.parse(runtimeBytes));
        ensure(
          config.executorSha === op.identity.executorSha &&
            config.provenance === "live-source" &&
            config.dockerExecutable === "/usr/bin/docker" &&
            config.endpoint === "unix:///var/run/docker.sock",
        );
        const connectionBytes = await readPrivateAbsolute(op.root, connectionFile);
        const descriptor = connection(
          JSON.parse(connectionBytes),
          op.identity.operationId,
          op.identity.target,
        );
        ensure(descriptor.network === policy.networks.database.name);
        const serviceBytes = await readPrivateAbsolute(op.root, descriptor.serviceFile);
        const passwordBytes = await readPrivateAbsolute(op.root, descriptor.passFile);
        const caBytes = await readPrivateAbsolute(op.root, descriptor.caFile);
        const privateInputs = [
          [connectionFile, connectionBytes],
          [descriptor.serviceFile, serviceBytes],
          [descriptor.passFile, passwordBytes],
          [descriptor.caFile, caBytes],
        ];
        validateConnectionFiles(serviceBytes, passwordBytes);
        stage = "observer-setup";
        const sourceOperation = upgradeSource?.operation ?? op;
        const observers = (upgradeSource ? createAcceptedRecoveryObservers : createHostObservers)(
          sourceOperation,
          policy,
          {
            runProcess: run,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.readMachineId ? { readMachineId: options.readMachineId } : {}),
          },
        );
        const context = {
          ...sourceOperation,
          allowedServices: ["postgres"],
          phase: "backup-verified",
          previousHealthy: journal.current,
          migration: { name: `markiro-platform-migrate-${op.identity.operationId}` },
        };
        const inspect = async (boundary) => {
          await verifySources();
          ensure(terminated && !uncertain);
          ensure(
            (
              await fingerprintHostConfiguration({
                root: op.root,
                ...sourceOperation.configuration,
              })
            ).configurationSha256 === sourceOperation.identity.configurationSha256,
          );
          ensure(
            (await readBackupRuntime(op.root, op.identity.operationId, recoveryRuntime)).equals(
              runtimeBytes,
            ),
          );
          for (const [path, bytes] of privateInputs)
            ensure((await readPrivateAbsolute(op.root, path)).equals(bytes));
          const c = { ...context, boundary };
          const state = await observers.inventory(c);
          if (upgradeSource) {
            ensure(state.owned.length === 3);
            for (const service of ["postgres", "api", "edge"]) {
              const rows = state.owned.filter((row) => row.service === service);
              ensure(
                rows.length === 1 && rows[0].container.Id === upgradeSource.containers[service],
              );
              if (service !== "postgres") ensure(!rows[0].active);
            }
          }
          const pg = state.owned.find((v) => v.service === "postgres").container;
          ensure(
            pg.Mounts.find((m) => m.Destination === "/etc/postgresql/pg_hba.conf")?.Source ===
              hbaPath,
          );
          assertBindFileSync(state.config.MARKIRO_POSTGRES_CA_FILE);
          ensure((await readFile(state.config.MARKIRO_POSTGRES_CA_FILE)).equals(caBytes));
          const images = JSON.parse(
            (await observers.command(["image", "inspect", config.image])).stdout,
          );
          ensure(
            Array.isArray(images) &&
              images.length === 1 &&
              images[0].Id === config.image &&
              images[0].Os === "linux" &&
              images[0].Architecture === "amd64",
          );
          await observePostgresAdmin({ context: c, state, command: observers.command, hbaSha256 });
          ensure(terminated && !uncertain);
        };
        stage = "entry-observation";
        await inspect("entry");
        stage = "writer-fence";
        const fence = {
          fenceId: randomUUID(),
          beganAt: new Date().toISOString(),
          enforcementSha256: hostFenceEnforcementSha256({
            target: op.identity.target,
            policy,
            hbaSha256,
          }),
        };
        producerInFlight = true;
        stage = "archive-production";
        const backup = await createDatabaseBackup({
          root: op.root,
          operationId: op.identity.operationId,
          target: op.identity.target,
          connectionFile,
          catalogJournal: { path: join(CATALOG_ROOT, "journal"), uid: 1000, optional: true },
          run,
          recoveryRuntime,
          writerFence: {
            observe: async ({ boundary }) => {
              await inspect(boundary);
              return {
                version: 1,
                kind: "platform-writer-fence",
                operationId: op.identity.operationId,
                target: op.identity.target,
                ...fence,
                boundary,
                observedAt: new Date().toISOString(),
                held: true,
              };
            },
          },
        });
        stage = "isolated-restore";
        const restoreEvidence = await verifyDatabaseRestore({
          root: op.root,
          operationId: op.identity.operationId,
          target: op.identity.target,
          backup,
          roleMapping: mapping,
          run,
          recoveryRuntime,
        });
        producerInFlight = false;
        stage = "post-restore-observation";
        await inspect("after-restore");
        return { backup, restoreEvidence, fence };
      } catch (error) {
        // A producer can lose its cleanup error when persisting failure evidence
        // also fails. Only successful completion establishes resource absence;
        // any incomplete call must retain the cooperating deployment lock.
        if (!terminated || uncertain || producerInFlight) error.durabilityUncertain = true;
        throw error;
      }
    });
  } catch (error) {
    throw targetBackupError(error, terminated, stage);
  }
}

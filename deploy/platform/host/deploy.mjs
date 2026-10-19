import { fileURLToPath } from "node:url";
import { canonical, ensure, keys, plain } from "../backup/schemas.mjs";
import { readProtectedEnv, validateConfig } from "../preflight.mjs";
import { fingerprintHostConfiguration, hostChildEnvironment } from "./config.mjs";
import { validatePreparedTarget } from "./prepared-target.mjs";
import { runHostProcess } from "./process.mjs";
import { withHostState } from "./state.mjs";
import { sameTarget, validateIdentity } from "./state-validation.mjs";

const project = "markiro-platform";
const composeFiles = ["../compose.yml", "../compose.compact.yml"].map((path) =>
  fileURLToPath(new URL(path, import.meta.url)),
);
const functions = [
  "verifyRelease",
  "verifyImages",
  "inspectTarget",
  "inspectStoppedWorkloads",
  "stopMigration",
  "inspectMigration",
  "smoke",
];
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
function failure(phase, error) {
  const result = new Error("Prepared host deployment failed.");
  result.code = "ERR_HOST_DEPLOYMENT";
  result.phase = phase;
  result.recoveryRequired = true;
  result.durabilityUncertain = error?.durabilityUncertain === true;
  if (error?.terminationConfirmed === false) result.terminationConfirmed = false;
  return result;
}
function stopped(value, identity) {
  const observed = plain(value);
  keys(observed, ["project", "target", "active"]);
  ensure(observed.project === project && canonical(observed.target) === canonical(identity.target));
  ensure(Array.isArray(observed.active) && observed.active.length === 0);
}
function migrationStopped(value, identity, name) {
  const observed = plain(value);
  keys(observed, ["name", "ownerOperationId", "containerId", "status"]);
  ensure(observed.name === name && observed.ownerOperationId === identity.operationId);
  ensure(
    (observed.status === "absent" && observed.containerId === null) ||
      (observed.status === "exited" && /^[a-f0-9]{64}$/u.test(observed.containerId)),
  );
}

function allowedServices(previous, phase, boundary) {
  if (
    previous &&
    (["admitted", "images-verified"].includes(phase) ||
      (phase === "target-stopped" && ["entry", "command", "recovery"].includes(boundary)))
  )
    return ["postgres", "api", "edge"];
  const allowed = ["postgres"];
  if (phase === "migrating") allowed.push("migrate");
  if (
    ["edge-started", "healthy"].includes(phase) ||
    (phase === "api-started" && boundary !== "entry")
  )
    allowed.push("api");
  if (phase === "healthy" || (phase === "edge-started" && boundary !== "entry"))
    allowed.push("edge");
  return allowed;
}

// input is data only. Every adapter is trusted installed code, never an operation
// JSON callback. Its observers must independently enforce ownership, source bytes
// and the phase-specific allowed workloads (including denial of outsider writers).
export async function executePreparedDeployment(input, adapters) {
  let operation;
  let phase = "admitted";
  try {
    operation = freeze(plain(input));
    keys(operation, [
      "root",
      "identity",
      "configuration",
      "dockerConfig",
      "preparedTarget",
      "preparedPolicy",
    ]);
    validateIdentity(operation.identity);
    keys(operation.configuration, ["candidateId", "runtimeSnapshot", "migrationSnapshot"]);
    keys(operation.preparedPolicy, [
      "backup",
      "restoreEvidence",
      "roleMapping",
      "postgres",
      "tls",
      "rolePolicySha256",
      "provenance",
      "maxAgeMs",
      "producers",
    ]);
    ensure(functions.every((name) => typeof adapters?.[name] === "function"));
    ensure(
      typeof adapters.writerFence?.observe === "function" &&
        typeof adapters.workload?.inspect === "function",
    );
    ensure(adapters.runProcess === undefined || typeof adapters.runProcess === "function");
    ensure(adapters.signal === undefined || adapters.signal instanceof AbortSignal);
    const { root, identity, configuration, dockerConfig, preparedTarget, preparedPolicy } =
      operation;
    const migration = freeze({
      name: `${project}-migrate-${identity.operationId}`,
      ownerOperationId: identity.operationId,
      labels: { "io.markiro.operation": identity.operationId },
    });
    const run = adapters.runProcess ?? runHostProcess;
    let deploymentFailure;
    const completed = await withHostState(root, async (store) => {
      const prior = await store.read();
      // No command (even an observer) may run for unresolved/foreign state.
      if (prior.current)
        ensure(
          prior.current.phase === "healthy" &&
            prior.current.status === "completed" &&
            prior.current.identity.operationId !== identity.operationId &&
            prior.previousHealthy?.identity.operationId !== identity.operationId &&
            sameTarget(prior.current.identity.target, identity.target),
        );
      let began = false;
      let releaseVerified = false;
      let targetOwned = false;
      let migrationEntered = false;
      let environment;
      const context = (boundary) => ({
        ...operation,
        project,
        composeFiles: [...composeFiles],
        migration,
        phase,
        boundary,
        previousHealthy: prior.current,
        // The fence excludes OTHER writers. Migration/API are authorized only
        // in their entered phases; snapshot proof remains a recovery boundary.
        allowedServices: allowedServices(prior.current, phase, boundary),
        environment,
      });
      const checkConfiguration = async () => {
        const fingerprint = await fingerprintHostConfiguration({ root, ...configuration });
        ensure(fingerprint.configurationSha256 === identity.configurationSha256);
        const runtime = await readProtectedEnv(configuration.runtimeSnapshot.path);
        validateConfig(runtime, identity.admission.manifest);
        const interpolation = {
          ...configuration.runtimeSnapshot.interpolation,
          MARKIRO_PLATFORM_MIGRATION_ENV_FILE: configuration.migrationSnapshot.path,
        };
        for (const [key, value] of Object.entries(interpolation)) {
          const expected =
            key === "MARKIRO_PLATFORM_ENV_FILE"
              ? configuration.runtimeSnapshot.path
              : key === "MARKIRO_PLATFORM_MIGRATION_ENV_FILE"
                ? configuration.migrationSnapshot.path
                : runtime[key];
          ensure(value === expected);
        }
        environment = freeze(hostChildEnvironment({ interpolation, dockerConfig }));
      };
      const observeTarget = async (name) => {
        targetOwned = false;
        const observed = plain(await adapters.inspectTarget(context(name)));
        keys(observed, ["target", "project", "serverProfile", "uiProfile", "os", "architecture"]);
        ensure(
          canonical(observed.target) === canonical(identity.target) &&
            observed.project === project &&
            observed.serverProfile === "platform-only" &&
            observed.uiProfile === "platform-only" &&
            observed.os === "linux" &&
            observed.architecture === "amd64",
        );
        targetOwned = true;
      };
      const boundary = async (name) => {
        await checkConfiguration();
        await observeTarget(name);
        const verified = await validatePreparedTarget(preparedTarget, {
          root,
          identity,
          configuration,
          ...preparedPolicy,
          writerFence: {
            ...adapters.writerFence,
            observe: (request) =>
              adapters.writerFence.observe({
                ...context(name),
                ...request,
                transitionBoundary: name,
              }),
          },
          workload: adapters.workload,
        });
        // Observers may take time or touch external state: reject changed bytes
        // again before the protected transition or command.
        await checkConfiguration();
        return verified.backupProof;
      };
      const compose = async (args, recovery = false) => {
        if (!recovery) {
          ensure(!adapters.signal?.aborted);
          await boundary("command");
        }
        await run({
          executable: "/usr/bin/docker",
          args: [
            "compose",
            "--project-name",
            project,
            "--file",
            composeFiles[0],
            "--file",
            composeFiles[1],
            ...args,
          ],
          cwd: root,
          env: environment,
          timeoutMs: args[0] === "run" ? 900000 : 300000,
          outputLimitBytes: 65536,
          ...(recovery || !adapters.signal ? {} : { signal: adapters.signal }),
        });
      };
      const enter = async (next) => {
        phase = next;
        await boundary("entry");
        await store.enter(phase);
      };
      const complete = async () => {
        const proof = await boundary("completion");
        await store.complete(phase, ...(phase === "backup-verified" ? [proof] : []));
      };
      const inspectStopped = async () =>
        stopped(await adapters.inspectStoppedWorkloads(context("stopped")), identity);
      const inspectMigration = async () =>
        migrationStopped(
          await adapters.inspectMigration(context("migration-stopped")),
          identity,
          migration.name,
        );
      try {
        ensure(!adapters.signal?.aborted);
        await boundary("entry");
        await store.begin(identity);
        began = true;
        await adapters.verifyRelease(context("release"));
        releaseVerified = true;
        await complete();
        await enter("images-verified");
        await compose(["pull", "api", "edge", "postgres"]);
        await adapters.verifyImages(context("images"));
        await complete();
        await enter("target-stopped");
        await compose(["stop", "edge", "api"]);
        await inspectStopped();
        await complete();
        await enter("backup-verified");
        await compose(["up", "-d", "--wait", "--no-deps", "postgres"]);
        await inspectStopped();
        await complete();
        await enter("migrating");
        migrationEntered = true;
        await inspectStopped();
        await compose([
          "run",
          "--rm",
          "--no-deps",
          "--name",
          migration.name,
          "--label",
          `io.markiro.operation=${identity.operationId}`,
          "migrate",
        ]);
        await inspectMigration();
        await complete();
        await enter("migrated");
        await inspectStopped();
        await complete();
        await enter("api-started");
        await compose(["up", "-d", "--wait", "--no-deps", "api"]);
        await complete();
        await enter("edge-started");
        await compose(["up", "-d", "--no-deps", "edge"]);
        await complete();
        await enter("healthy");
        await adapters.smoke(context("smoke"));
        await complete();
        return plain(identity);
      } catch (error) {
        let terminationConfirmed = error?.terminationConfirmed !== false;
        const recover = async (action) => {
          if (!terminationConfirmed) return;
          try {
            await action();
          } catch (cleanupError) {
            terminationConfirmed = cleanupError?.terminationConfirmed !== false;
          }
        };
        // Never replay prior binaries or drop volumes. Cleanup ignores the abort
        // signal, but still targets only ownership verified by trusted observers.
        if (began) {
          // Publish terminal recovery intent before attempting cleanup. A failed
          // publication latches the store/lock; the entered phase remains a fence.
          await store.fail().catch(() => {});
          // An unreaped CLI may still issue daemon commands. Never race it with
          // a second mutating process; explicit operator recovery is required.
          if (releaseVerified && terminationConfirmed) {
            await recover(() => observeTarget("recovery"));
            if (targetOwned) {
              if (migrationEntered) {
                await recover(() => adapters.stopMigration(context("recovery")));
                await recover(inspectMigration);
              }
              await recover(() => compose(["stop", "edge", "api"], true));
              await recover(inspectStopped);
            }
          }
        }
        deploymentFailure = failure(phase, error);
        if (!terminationConfirmed) deploymentFailure.terminationConfirmed = false;
        return null;
      }
    });
    if (deploymentFailure) throw deploymentFailure;
    return completed;
  } catch (error) {
    if (error?.code === "ERR_HOST_STATE" || error?.code === "ERR_HOST_LOCK_RELEASE") {
      const sanitized = new Error(
        error.code === "ERR_HOST_STATE"
          ? "Host deployment state operation failed."
          : "Host deployment lock retirement failed.",
      );
      sanitized.code = error.code;
      sanitized.durabilityUncertain = error.durabilityUncertain === true;
      if (error.code === "ERR_HOST_LOCK_RELEASE") sanitized.lockRetirementUncertain = true;
      throw sanitized;
    }
    throw failure(phase, error);
  }
}

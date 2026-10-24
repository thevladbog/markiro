import { canonical, ensure, keys } from "../backup/schemas.mjs";
import { catalogComposeFiles } from "../catalog-config.mjs";
import { snapshotActivation } from "./recovery-activation-admission.mjs";
import { withUpgradePhaseState } from "./upgrade-state.mjs";
import { preparedHostBoundary } from "./deployment-boundary.mjs";
import { readVerifiedBackup } from "./backup-gate.mjs";
import { runHostProcess } from "./process.mjs";
const same = (a, b) => ensure(canonical(a) === canonical(b));
const methods = [
  "verifyRelease",
  "verifyImages",
  "verifyRoles",
  "inspectTarget",
  "inspectStoppedOld",
  "inspectCandidate",
  "inspectSchema",
  "inspectMigration",
  "smoke",
  "cleanupOwnedWorkloads",
  "cleanupOwnedProbes",
];
function failure(phase, error) {
  const e = new Error("Protected accepted-recovery upgrade activation failed.");
  e.code = "ERR_HOST_UPGRADE_ACTIVATION";
  e.phase = phase;
  e.recoveryRequired = true;
  e.durabilityUncertain = error?.durabilityUncertain === true;
  if (error?.terminationConfirmed === false) e.terminationConfirmed = false;
  return e;
}
export async function executeUpgradeActivation(input, adapters, options) {
  let phase = "activation-admitted";
  try {
    const operation = snapshotActivation(input);
    keys(operation, [
      "root",
      "dockerConfig",
      "decision",
      "configuration",
      "preparedTarget",
      "preparedPolicy",
    ]);
    const { root, dockerConfig, decision, configuration, preparedTarget, preparedPolicy } =
      operation;
    ensure(decision.phase === "activate" && dockerConfig === `${root}/docker`);
    ensure(
      preparedTarget.version === 2 &&
        preparedTarget.provenance === "live-source" &&
        preparedPolicy.provenance === "live-source",
    );
    ensure(
      methods.every((n) => typeof adapters?.[n] === "function") &&
        typeof adapters.writerFence?.observe === "function" &&
        typeof adapters.workload?.inspect === "function",
    );
    ensure(adapters.runProcess === undefined || typeof adapters.runProcess === "function");
    ensure(adapters.signal === undefined || adapters.signal instanceof AbortSignal);
    return await withUpgradePhaseState(
      root,
      decision,
      async (store) => {
        const initial = await store.read(),
          identity = initial.admission.identity;
        same(preparedTarget.fence, initial.preparation.fence);
        for (const k of ["operationId", "target", "executorSha", "configurationSha256"])
          same(preparedTarget[k], identity[k]);
        let environment,
          composeFiles = catalogComposeFiles({}),
          migrationAttempted = false;
        const migration = { name: `markiro-platform-migrate-${identity.operationId}` };
        const context = (boundary) => ({
          root,
          dockerConfig,
          identity,
          configuration,
          preparedTarget,
          preparedPolicy,
          project: "markiro-platform",
          composeFiles: [...composeFiles],
          phase,
          boundary,
          environment,
          migration,
          allowedServices: [
            "postgres",
            ...(phase === "migration-entered" ? ["migrate"] : []),
            ...(["api-started", "edge-started", "healthy"].includes(phase) ? ["api"] : []),
            ...(["edge-started", "healthy"].includes(phase) ? ["edge"] : []),
          ],
        });
        const call = (name, boundary = name) =>
          store.guard((cap) => adapters[name](context(boundary), cap));
        const shared = preparedHostBoundary({
          root,
          identity,
          configuration,
          dockerConfig,
          preparedTarget,
          preparedPolicy,
          context,
          adapters: {
            ...adapters,
            inspectTarget: (request) => store.guard((cap) => adapters.inspectTarget(request, cap)),
            writerFence: {
              ...adapters.writerFence,
              observe: (request) =>
                store.guard((cap) => adapters.writerFence.observe(request, cap)),
            },
            workload: {
              ...adapters.workload,
              inspect: (request) =>
                store.guard((cap) =>
                  adapters.workload.inspect({ ...context("restore-cleanup"), ...request }, cap),
                ),
            },
          },
          onEnvironment: (env, files) => {
            environment = env;
            composeFiles = files;
          },
        });
        const recheck = () => {
          ensure(!adapters.signal?.aborted && Date.parse(decision.expiresAt) > Date.now());
          shared.checkPreparedFreshness();
          shared.checkActivationDeadline();
        };
        const observe = async () => {
          const old = phase === "activation-admitted";
          const v = snapshotActivation(await call(old ? "inspectStoppedOld" : "inspectCandidate"));
          keys(v, [
            "version",
            "kind",
            "operationId",
            "configurationSha256",
            "target",
            "phase",
            "containers",
          ]);
          ensure(
            v.version === 1 &&
              v.kind === "platform-upgrade-observation" &&
              v.operationId === identity.operationId &&
              v.phase === phase &&
              v.configurationSha256 ===
                (old ? initial.admission.oldConfigurationSha256 : identity.configurationSha256),
          );
          same(v.target, identity.target);
          ensure(v.containers.postgres === initial.oldRuntime.containers.postgres);
          if (old) same(v.containers, initial.oldRuntime.containers);
          return v;
        };
        const boundary = async (name) => {
          await store.read();
          same(await shared.boundary(name), initial.backup);
          await observe();
          if (!migrationAttempted) same(await call("inspectSchema"), initial.oldRuntime.schema);
          same(
            (await readVerifiedBackup({ root, identity, ...preparedPolicy })).backupProof,
            initial.backup,
          );
          await shared.checkConfiguration();
          await store.read();
          recheck();
        };
        const compose = async (args) => {
          await boundary("command");
          if (args[0] === "run") migrationAttempted = true;
          return store.guard(() => {
            recheck();
            return (adapters.runProcess ?? runHostProcess)(
              {
                executable: "/usr/bin/docker",
                args: [
                  "--host",
                  "unix:///var/run/docker.sock",
                  "compose",
                  "--project-name",
                  "markiro-platform",
                  ...composeFiles.flatMap((p) => ["--file", p]),
                  ...args,
                ],
                cwd: root,
                env: environment,
                timeoutMs: 300000,
                outputLimitBytes: 65536,
                ...(adapters.signal ? { signal: adapters.signal } : {}),
              },
              recheck,
            );
          });
        };
        const complete = async () => {
          await boundary("completion");
          await store.complete(phase);
        };
        const enter = async (next) => {
          phase = next;
          await store.enter(phase);
          await boundary("entry");
        };
        try {
          await boundary("entry");
          await call("verifyRelease");
          await boundary("release");
          await compose(["pull", "api", "edge"]);
          await call("verifyImages");
          await complete();
          // enter() durably fsyncs the monotonic latch before any possible spawn.
          await enter("migration-entered");
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
          const m = snapshotActivation(await call("inspectMigration"));
          keys(m, ["name", "ownerOperationId", "containerId", "status"]);
          ensure(
            m.name === migration.name &&
              m.ownerOperationId === identity.operationId &&
              ((m.status === "absent" && m.containerId === null) ||
                (m.status === "exited" && /^[a-f0-9]{64}$/u.test(m.containerId))),
          );
          await complete();
          await enter("migrated");
          await call("verifyRoles");
          await complete();
          for (const [next, service] of [
            ["api-started", "api"],
            ["edge-started", "edge"],
          ]) {
            await enter(next);
            await compose([
              "up",
              "-d",
              ...(service === "api" ? ["--wait"] : []),
              "--no-deps",
              service,
            ]);
            const v = await observe();
            ensure(
              typeof v.containers[service] === "string" &&
                /^[a-f0-9]{64}$/u.test(v.containers[service]) &&
                !Object.values(initial.oldRuntime.containers).includes(v.containers[service]),
            );
            await complete();
          }
          await enter("healthy");
          await call("smoke");
          await complete();
          return identity;
        } catch (error) {
          if (error?.terminationConfirmed === false || error?.durabilityUncertain === true)
            throw error;
          await store.fail();
          await store.cleanup((cap) => adapters.cleanupOwnedProbes(context("recovery"), cap));
          if (migrationAttempted)
            await store.cleanup((cap) => adapters.cleanupOwnedWorkloads(context("recovery"), cap));
          throw error;
        }
      },
      options,
    );
  } catch (error) {
    throw failure(phase, error);
  }
}

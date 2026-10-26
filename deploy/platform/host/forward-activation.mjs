import { dirname, join } from "node:path";
import { canonical, ensure, keys } from "../backup/schemas.mjs";
import { catalogComposeFiles } from "../catalog-config.mjs";
import { snapshotActivation } from "./recovery-activation-admission.mjs";
import { withForwardActivationState } from "./forward-state.mjs";
import { validateProductMigrationLedger } from "./forward-ledger.mjs";
import { preparedHostBoundary } from "./deployment-boundary.mjs";
import { readVerifiedBackup } from "./backup-gate.mjs";
import { runHostProcess } from "./process.mjs";
import { carryHostFailure, sanitizeHostFailure, writeHostFailure } from "./failure-diagnostic.mjs";
const same = (a, b) => ensure(canonical(a) === canonical(b));
const methods = [
  "verifyRelease",
  "verifyImages",
  "verifyRoles",
  "inspectTarget",
  "inspectCandidate",
  "inspectSchema",
  "smoke",
  "withPreparedCommand",
  "cleanupOwnedProbes",
  "cleanupOwnedWorkloads",
];
export async function executeForwardActivation(input, adapters, options) {
  let phase = "activation-admitted",
    lastBoundary = "validation",
    commandCategory = "validation";
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
    keys(adapters, [
      ...methods,
      "writerFence",
      "workload",
      ...["runProcess", "signal"].filter((key) => Object.hasOwn(adapters, key)),
    ]);
    ensure(
      methods.every((name) => typeof adapters[name] === "function") &&
        typeof adapters.writerFence?.observe === "function" &&
        typeof adapters.workload?.inspect === "function",
    );
    ensure(adapters.runProcess === undefined || typeof adapters.runProcess === "function");
    ensure(adapters.signal === undefined || adapters.signal instanceof AbortSignal);
    const { root, dockerConfig, decision, configuration, preparedTarget, preparedPolicy } =
      operation;
    ensure(
      decision.phase === "post-migration-activate" &&
        dockerConfig === `${root}/docker` &&
        preparedTarget.version === 2 &&
        preparedTarget.provenance === "live-source" &&
        preparedPolicy.provenance === "live-source",
    );
    return await withForwardActivationState(
      root,
      decision,
      async (store) => {
        const initial = await store.read(),
          identity = initial.admission.identity;
        same(preparedTarget.fence, initial.preparation.fence);
        for (const key of ["operationId", "target", "executorSha", "configurationSha256"])
          same(preparedTarget[key], identity[key]);
        let environment,
          composeFiles = catalogComposeFiles({}),
          apiStarted = false,
          applicationAttempted = false;
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
          previousHealthy: null,
          migration: { name: `markiro-platform-migrate-${identity.operationId}` },
          allowedServices: [
            "postgres",
            ...(["api-started", "edge-started", "healthy"].includes(phase) ? ["api"] : []),
            ...(["edge-started", "healthy"].includes(phase) ? ["edge"] : []),
          ],
        });
        let firstRecord, diagnosticError;
        const persistFailure = async (error) => {
          if (diagnosticError) throw diagnosticError;
          if (firstRecord) return firstRecord;
          let record;
          try {
            record = sanitizeHostFailure(error, {
              operationId: identity.operationId,
              phase,
              boundary: lastBoundary,
              commandCategory,
            });
            await writeHostFailure(
              join(
                dirname(root),
                "upgrade-operations",
                identity.operationId,
                "post-migration-activate",
              ),
              record,
            );
          } catch {
            const unresolved = carryHostFailure(
              error,
              new Error("Forward activation diagnostic persistence failed."),
            );
            unresolved.code = "ERR_HOST_FORWARD_ACTIVATION";
            unresolved.durabilityUncertain = true;
            diagnosticError = unresolved;
            throw unresolved;
          }
          firstRecord = record;
          return record;
        };
        const call = (name, cleanup = false) => {
          lastBoundary = name;
          commandCategory =
            name === "smoke"
              ? "smoke"
              : name === "verifyImages"
                ? "image-check"
                : cleanup
                  ? "cleanup"
                  : "validation";
          const invoke = (cap) =>
            adapters[name](context(cleanup ? "recovery" : name), cap, persistFailure);
          return cleanup ? store.cleanup(invoke) : store.guard(invoke);
        };
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
            inspectTarget: (request) =>
              store.guard((cap) => adapters.inspectTarget(request, cap, persistFailure)),
            writerFence: {
              ...adapters.writerFence,
              observe: (request) =>
                store.guard((cap) => adapters.writerFence.observe(request, cap, persistFailure)),
            },
            workload: {
              ...adapters.workload,
              inspect: (request) =>
                store.guard((cap) =>
                  adapters.workload.inspect(
                    { ...context("restore-cleanup"), ...request },
                    cap,
                    persistFailure,
                  ),
                ),
            },
          },
          onEnvironment: (env, files) => {
            environment = env;
            composeFiles = files;
          },
        });
        const checkDecision = () =>
          ensure(!adapters.signal?.aborted && Date.parse(decision.expiresAt) > Date.now());
        const recheck = () => {
          checkDecision();
          shared.checkPreparedFreshness();
          shared.checkActivationDeadline();
        };
        const observe = async () => {
          const value = snapshotActivation(await call("inspectCandidate"));
          keys(value, [
            "version",
            "kind",
            "operationId",
            "configurationSha256",
            "target",
            "phase",
            "containers",
            "schema",
            "productMigrationProofSha256",
          ]);
          ensure(
            value.version === 1 &&
              value.kind === "platform-forward-observation" &&
              value.operationId === identity.operationId &&
              value.configurationSha256 === identity.configurationSha256 &&
              value.phase === phase,
          );
          same(value.target, identity.target);
          same(value.schema, initial.admission.baseline.schema);
          same(
            value.productMigrationProofSha256,
            initial.admission.baseline.productMigrationProofSha256,
          );
          keys(value.containers, ["postgres", "api", "edge"]);
          ensure(
            Object.values(value.containers).every(
              (id) => typeof id === "string" && /^[a-f0-9]{64}$/u.test(id),
            ) && new Set(Object.values(value.containers)).size === 3,
          );
          ensure(value.containers.postgres === initial.sourceRuntime.containers.postgres);
          if (phase === "activation-admitted")
            same(value.containers, initial.sourceRuntime.containers);
          return value;
        };
        const schema = async () => {
          const value = snapshotActivation(await call("inspectSchema"));
          keys(value, ["version", "kind", "postgresId", "productProofSha256", "schema", "rows"]);
          ensure(
            value.version === 1 &&
              value.kind === "platform-forward-migration-observation" &&
              value.postgresId === initial.sourceRuntime.containers.postgres &&
              value.productProofSha256 === initial.admission.baseline.productMigrationProofSha256,
          );
          same(value.schema, initial.admission.baseline.schema);
          validateProductMigrationLedger(value.rows, options.productMigrationProof);
        };
        const boundary = async (name) => {
          await store.read();
          await observe();
          await schema();
          same(
            (await readVerifiedBackup({ root, identity, ...preparedPolicy })).backupProof,
            initial.backup,
          );
          await shared.checkConfiguration();
          await store.read();
          // Before API-up this includes the retained-job projection. Afterwards
          // phase/boundary routing never compares a now-mutable data projection.
          if (apiStarted && phase === "api-started") ensure(name === "completion");
          lastBoundary = name;
          same(await shared.boundary(name), initial.backup);
          recheck();
        };
        const enter = async (next) => {
          phase = next;
          lastBoundary = "entry";
          await store.enter(phase);
          await boundary("entry");
        };
        const complete = async () => {
          await boundary("completion");
          await store.complete(phase);
        };
        const up = async (service) => {
          ensure(["api", "edge"].includes(service) && (service !== "api" || !apiStarted));
          await boundary("command");
          lastBoundary = "command";
          commandCategory = service === "api" ? "api-up" : "edge-up";
          await store.guard((cap) =>
            adapters.withPreparedCommand(
              context("command"),
              cap,
              ({
                environment: commandEnvironment,
                composeFiles: commandFiles,
                recheckPrepared,
              }) => {
                const recheckCommand = () => {
                  checkDecision();
                  recheckPrepared();
                };
                recheckCommand();
                applicationAttempted = true;
                return (adapters.runProcess ?? runHostProcess)(
                  {
                    executable: "/usr/bin/docker",
                    args: [
                      "--host",
                      "unix:///var/run/docker.sock",
                      "compose",
                      "--project-name",
                      "markiro-platform",
                      ...commandFiles.flatMap((path) => ["--file", path]),
                      "up",
                      "-d",
                      ...(service === "api" ? ["--wait"] : []),
                      "--no-deps",
                      service,
                    ],
                    cwd: root,
                    env: commandEnvironment,
                    timeoutMs: 300000,
                    outputLimitBytes: 65536,
                    ...(adapters.signal ? { signal: adapters.signal } : {}),
                  },
                  recheckCommand,
                );
              },
              persistFailure,
            ),
          );
          if (service === "api") apiStarted = true;
          const value = await observe();
          ensure(
            !Object.values(initial.sourceRuntime.containers).includes(value.containers[service]),
          );
        };
        try {
          await boundary("entry");
          await call("verifyRelease");
          await call("verifyImages");
          await call("verifyRoles");
          await complete();
          await enter("api-started");
          await up("api");
          await complete();
          await enter("edge-started");
          await up("edge");
          await complete();
          await enter("healthy");
          await call("smoke");
          await complete();
          const final = await store.read();
          ensure(
            final.sequence === 14 &&
              final.phase === "healthy" &&
              final.status === "completed" &&
              final.migrationEntered === true,
          );
          const actual = await observe();
          for (const service of ["api", "edge"])
            ensure(
              !Object.values(initial.sourceRuntime.containers).includes(actual.containers[service]),
            );
          return identity;
        } catch (error) {
          const record = await persistFailure(error);
          const descriptor =
            error && ["object", "function"].includes(typeof error)
              ? Object.getOwnPropertyDescriptor(error, "terminationConfirmed")
              : null;
          if (
            record.durabilityUncertain ||
            error?.durabilityUncertain === true ||
            descriptor?.value === false
          )
            throw error;
          await store.fail();
          try {
            await call("cleanupOwnedProbes", true);
            if (applicationAttempted) await call("cleanupOwnedWorkloads", true);
          } catch {
            const unresolved = carryHostFailure(
              error,
              new Error("Forward activation owned cleanup could not be confirmed."),
            );
            unresolved.code = "ERR_HOST_FORWARD_ACTIVATION";
            unresolved.durabilityUncertain = true;
            throw unresolved;
          }
          throw error;
        }
      },
      options,
    );
  } catch (error) {
    const failure = new Error("Protected post-migration forward activation failed.");
    failure.code = "ERR_HOST_FORWARD_ACTIVATION";
    failure.phase = phase;
    failure.recoveryRequired = true;
    throw carryHostFailure(error, failure);
  }
}

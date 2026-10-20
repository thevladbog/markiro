import { fileURLToPath } from "node:url";
import { canonical, ensure, keys, plain } from "../backup/schemas.mjs";
import { runHostProcess } from "./process.mjs";
import { preparedHostBoundary } from "./deployment-boundary.mjs";
import { readVerifiedBackup } from "./backup-gate.mjs";
import { snapshotActivation } from "./recovery-activation-admission.mjs";
import { withRecoveryActivationState } from "./recovery-activation-state.mjs";

const project = "markiro-platform";
const composeFiles = ["../compose.yml", "../compose.compact.yml"].map((path) =>
  fileURLToPath(new URL(path, import.meta.url)),
);
const functions = [
  "verifyRelease",
  "verifyImages",
  "inspectTarget",
  "inspectStoppedWorkloads",
  "smoke",
];
function failure(phase, error) {
  const result = new Error("Recovery activation failed.");
  result.code = "ERR_HOST_RECOVERY_ACTIVATION";
  result.phase = phase;
  result.recoveryRequired = true;
  result.durabilityUncertain = error?.durabilityUncertain === true;
  if (error?.terminationConfirmed === false) result.terminationConfirmed = false;
  return result;
}
function allowedServices(phase, boundary) {
  const result = ["postgres"];
  if (
    ["edge-started", "healthy"].includes(phase) ||
    (phase === "api-started" && boundary !== "entry")
  )
    result.push("api");
  if (phase === "healthy" || (phase === "edge-started" && boundary !== "entry"))
    result.push("edge");
  return result;
}

// Data-only operation; trusted installed delivery supplies every adapter. This
// coordinator never enters the ordinary deployment journal or runs migrations.
export async function executeRecoveryActivation(input, adapters) {
  let phase = "activation-admitted";
  let terminationUnconfirmed = false;
  try {
    const operation = snapshotActivation(input);
    keys(operation, ["root", "dockerConfig", "activation"]);
    const { root, dockerConfig, activation } = operation;
    // Reject non-production evidence before even a target observer is invoked.
    ensure(
      activation.preparedTarget?.version === 2 &&
        activation.preparedTarget?.provenance === "live-source" &&
        activation.preparedPolicy?.provenance === "live-source",
    );
    ensure(functions.every((name) => typeof adapters?.[name] === "function"));
    ensure(
      typeof adapters.writerFence?.observe === "function" &&
        typeof adapters.workload?.inspect === "function",
    );
    ensure(adapters.runProcess === undefined || typeof adapters.runProcess === "function");
    ensure(adapters.signal === undefined || adapters.signal instanceof AbortSignal);
    const {
      admission: { identity },
      configuration,
      preparedTarget,
      preparedPolicy,
    } = activation;
    const run = adapters.runProcess ?? runHostProcess;
    return await withRecoveryActivationState(root, activation, async (store) => {
      const initial = await store.read();
      const preparationProof = initial.backup;
      let environment,
        targetOwned = false,
        releaseVerified = false;
      const context = (boundary) => ({
        root,
        dockerConfig,
        identity,
        configuration,
        preparedTarget,
        preparedPolicy,
        project,
        composeFiles: [...composeFiles],
        phase,
        boundary,
        allowedServices: allowedServices(phase, boundary),
        environment,
      });
      const {
        boundary: sharedBoundary,
        checkActivationDeadline,
        checkConfiguration,
        checkPreparedFreshness,
        observeTarget,
      } = preparedHostBoundary({
        root,
        identity,
        configuration,
        dockerConfig,
        preparedTarget,
        preparedPolicy,
        adapters,
        context,
        onOwnership: (value) => {
          targetOwned = value;
        },
        onEnvironment: (value) => {
          environment = value;
        },
      });
      const stopped = async () => {
        const value = plain(await adapters.inspectStoppedWorkloads(context("stopped")));
        keys(value, ["project", "target", "active"]);
        ensure(value.project === project && canonical(value.target) === canonical(identity.target));
        ensure(Array.isArray(value.active) && value.active.length === 0);
      };
      const boundary = async (name) => {
        ensure(!adapters.signal?.aborted);
        const proof = await sharedBoundary(name);
        ensure(canonical(proof) === canonical(preparationProof));
        if (allowedServices(phase, name).length === 1) await stopped();
        // Actual immutable archive/configuration bytes are checked again after
        // asynchronous observers, including the stopped-workload observation.
        const current = await readVerifiedBackup({ root, identity, ...preparedPolicy });
        ensure(canonical(current.backupProof) === canonical(preparationProof));
        await checkConfiguration();
        checkPreparedFreshness();
        checkActivationDeadline();
      };
      const guarded = (action) =>
        store.guard(async () => {
          try {
            return await action();
          } catch (error) {
            terminationUnconfirmed ||= error?.terminationConfirmed === false;
            throw error;
          }
        });
      const guardedBoundary = (name) => guarded(() => boundary(name));
      const complete = async () => {
        await guardedBoundary("completion");
        await store.complete(phase);
      };
      const enter = async (next) => {
        phase = next;
        await guardedBoundary("entry");
        await store.enter(next);
      };
      const compose = async (args, recovery = false) => {
        if (!recovery) await guardedBoundary("command");
        const command = () =>
          run({
            executable: "/usr/bin/docker",
            args: [
              "--host",
              "unix:///var/run/docker.sock",
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
            timeoutMs: 300000,
            outputLimitBytes: 65536,
            ...(recovery || !adapters.signal ? {} : { signal: adapters.signal }),
          });
        if (recovery) {
          ensure(canonical(args) === canonical(["stop", "edge", "api"]));
          await store.fail();
          await command();
        } else await guarded(command);
      };
      try {
        await guardedBoundary("entry");
        await guarded(() => adapters.verifyRelease(context("release")));
        releaseVerified = true;
        await complete();
        await enter("images-verified");
        await compose(["pull", "api", "edge", "postgres"]);
        await guarded(() => adapters.verifyImages(context("images")));
        await complete();
        await enter("api-started");
        await compose(["up", "-d", "--wait", "--no-deps", "api"]);
        await complete();
        await enter("edge-started");
        await compose(["up", "-d", "--no-deps", "edge"]);
        await complete();
        await enter("healthy");
        await guardedBoundary("smoke");
        await guarded(() => adapters.smoke(context("smoke")));
        await complete();
        return plain(identity);
      } catch (error) {
        if (error?.terminationConfirmed === false || error?.durabilityUncertain === true)
          throw error;
        await store.fail();
        if (releaseVerified) {
          try {
            await observeTarget("recovery");
            await checkConfiguration();
            if (targetOwned) {
              await compose(["stop", "edge", "api"], true);
              await store.fail();
              await stopped();
            }
          } catch (cleanupError) {
            terminationUnconfirmed ||= cleanupError?.terminationConfirmed === false;
            if (
              cleanupError?.terminationConfirmed === false ||
              cleanupError?.durabilityUncertain === true
            )
              throw cleanupError;
          }
        }
        throw failure(phase, error);
      }
    });
  } catch (error) {
    const sanitized = failure(phase, error);
    if (terminationUnconfirmed) sanitized.terminationConfirmed = false;
    throw sanitized;
  }
}

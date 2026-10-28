/** Disposable Linux fixture only; never an installed or production executor. */
import assert from "node:assert/strict";
import { mkdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { digest } from "./backup/schemas.mjs";
import { writePrivateFile } from "./host/files.mjs";
import { hostChildEnvironment } from "./host/config.mjs";
import { sanitizeHostFailure } from "./host/failure-diagnostic.mjs";
import { readFailedForwardEdgePredecessor } from "./host/forward-edge-successor-admission.mjs";
import { forwardDecision } from "./test/forward-fixture.mjs";
import { failedEdgeExecutor } from "./forward-ci-predecessor.mjs";
const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
export async function seedFailedForwardEdge({
  c,
  executor,
  admission,
  preparedState,
  successorRecord,
  verifyBaseline,
  proof,
  runProcess,
  deps,
  oldOperation,
  inputs,
}) {
  assert.equal(process.platform, "linux");
  assert.equal(executor.executorSha, failedEdgeExecutor);
  assert.equal(admission.kind, "platform-forward-activation-successor");
  assert.equal(admission.identity.executorSha, failedEdgeExecutor);
  await c.verifyIsolation();
  await executor.verify();
  const { root, parent } = c,
    id = admission.identity.operationId;
  const directory = join(parent, "upgrade-operations", id, "post-migration-activate");
  await mkdir(directory, { mode: 0o700 });
  const clock = Date.now(),
    decision = forwardDecision({ input: admission }, preparedState);
  decision.dispatch.runId = "998303";
  // Freeze only the historical state coordinator, then inject its observed
  // legacy expiry after actual API replacement. All Docker/SQL facts are real.
  decision.expiresAt = new Date(clock + 1000).toISOString();
  const activationRecord = {
    ...successorRecord,
    phase: decision.phase,
    dispatch: decision.dispatch,
    operation: {
      root,
      dockerConfig: join(root, "docker"),
      admission,
      configuration: successorRecord.operation.configuration,
      predecessorContainers: admission.baseline.containers,
      decision,
      ...inputs,
    },
  };
  await writePrivateFile(directory, "operation.json", encode(activationRecord));
  for (const [phase, dispatch, record] of [
    [admission.phase, admission.dispatch, successorRecord],
    [decision.phase, decision.dispatch, activationRecord],
  ]) {
    const path = join(parent, "upgrade-operations", id, phase);
    await writePrivateFile(path, "github-token", Buffer.from("SYNTHETIC-PRIVATE-JOB-TOKEN"));
    const marker = {
      phase,
      dispatch,
      executorSha: admission.identity.executorSha,
      operationId: id,
    };
    await writePrivateFile(
      path,
      "delivery.json",
      encode({ ...marker, bundleSha256: digest(encode(record)) }),
    );
    for (const file of ["execution-fence.json", "command-started.json"])
      await writePrivateFile(path, file, encode({ version: 1, ...marker }));
  }
  const configuration = successorRecord.operation.configuration;
  const observers = executor.observation.createForwardObservers(
    {
      oldOperation,
      candidateOperation: {
        root,
        dockerConfig: join(root, "docker"),
        identity: admission.identity,
        configuration,
      },
      retainedIds: admission.baseline.containers,
      baseline: admission.baseline,
      productMigrationProof: proof,
      policy: c.policy,
    },
    deps,
  );
  const env = hostChildEnvironment({
    interpolation: {
      ...configuration.runtimeSnapshot.interpolation,
      MARKIRO_PLATFORM_MIGRATION_ENV_FILE: configuration.migrationSnapshot.path,
    },
    dockerConfig: join(root, "docker"),
    ambient: {},
  });
  c.progress("seed exact failed edge after actual API replacement");
  const files = ["compose.yml", "compose.compact.yml"].map((name) =>
    join(executor.installedRoot, "deploy/platform", name),
  );
  // These exact historical Compose bytes also need to exist in the inner
  // live namespace. Never substitute the current recipe for the old executor.
  for (const path of files) {
    await executor.verify();
    await c.shell(["mkdir", "-p", join(executor.installedRoot, "deploy/platform")]);
    await c.outer(["cp", path, `${c.containerId}:${path}`]);
    assert.equal(
      (await c.shell(["sha256sum", path])).stdout.slice(0, 64),
      digest(await readFile(path)),
    );
    await executor.verify();
  }
  let api;
  await executor.state.withForwardActivationState(
    root,
    decision,
    async (store) => {
      await store.complete("activation-admitted");
      await store.enter("api-started");
      await store.guard(async (cap) => {
        await executor.state.withHeldForwardState(cap, async (held) => {
          await held.verify();
          await executor.verify();
          await runProcess({
            executable: "/usr/bin/docker",
            args: [
              "--host",
              "unix:///var/run/docker.sock",
              "compose",
              "--project-name",
              "markiro-platform",
              ...files.flatMap((path) => ["--file", path]),
              "up",
              "-d",
              "--wait",
              "--no-deps",
              "api",
            ],
            cwd: root,
            env,
            timeoutMs: 300000,
            outputLimitBytes: 1048576,
          });
          await executor.verify();
          await held.verify();
        });
      });
      api = await c.inspect("container", "markiro-platform-api-1");
      assert.notEqual(api.Id, admission.baseline.containers.api);
      assert.equal(api.State.Running, true);
      assert.equal(api.State.Health.Status, "healthy");
      await store.guard((cap) => observers.inspectCandidate(cap));
      await store.complete("api-started");
      await store.enter("edge-started");
      const end = Date.parse(decision.expiresAt);
      if (Date.now() <= end) await delay(end - Date.now() + 1);
      await store.fail();
    },
    { productMigrationProof: proof, verifyBaseline, now: () => clock },
  );
  const failure = sanitizeHostFailure(
    Object.assign(new Error("synthetic legacy expiry after API replacement"), {
      code: "ERR_HOST_FORWARD_ADMISSION",
      terminationConfirmed: false,
    }),
    { operationId: id, phase: "edge-started", boundary: "command", commandCategory: "edge-up" },
  );
  await writePrivateFile(directory, "failure.json", encode(failure));
  const current = await c.inspect("container", api.Id);
  assert.equal(current.Id, api.Id);
  assert.equal(current.State.Running, true);
  await runProcess({
    executable: "/usr/bin/docker",
    args: ["--host", "unix:///var/run/docker.sock", "container", "stop", api.Id],
    cwd: root,
    env,
    timeoutMs: 30000,
    outputLimitBytes: 65536,
  });
  const statePath = join(root, "forward-recovery-operations", id, "state.json"),
    bytes = await readFile(statePath),
    state = JSON.parse(bytes);
  assert.equal(state.sequence, 12);
  assert.equal(state.phase, "edge-started");
  assert.equal(state.status, "recovery-required");
  const mtime = Math.ceil((await lstat(statePath)).mtimeMs);
  if (Date.now() <= mtime) await delay(mtime - Date.now() + 1);
  const source = {
    version: 1,
    kind: "platform-forward-edge-source",
    operationId: id,
    stateSha256: digest(bytes),
    target: admission.identity.target,
    configurationSha256: admission.candidateConfigurationSha256,
    observedAt: new Date().toISOString(),
    schema: admission.baseline.schema,
    productMigrationProofSha256: proof.proofSha256,
    containers: {},
  };
  for (const service of ["postgres", "api", "edge"]) {
    const row = await c.inspect(
      "container",
      service === "api" ? api.Id : admission.baseline.containers[service],
    );
    assert.equal(row.State.Paused, false);
    assert.equal(row.State.Restarting, false);
    assert.equal(row.State.Running, service === "postgres");
    assert.equal(row.State.ExitCode, 0);
    source.containers[service] = {
      id: row.Id,
      imageId: row.Image,
      reference: row.Config.Image,
      running: row.State.Running,
      paused: row.State.Paused,
      restarting: row.State.Restarting,
      status: row.State.Status,
      health: service === "postgres" ? row.State.Health.Status : null,
      exitCode: row.State.ExitCode,
    };
  }
  await writePrivateFile(root, `forward-edge-source-${id}.json`, encode(source));
  await executor.verify();
  await c.verifyIsolation();
  return {
    admission,
    bytes: await readFailedForwardEdgePredecessor(root, id),
    sourceIds: Object.fromEntries(
      Object.entries(source.containers).map(([service, row]) => [service, row.id]),
    ),
  };
}

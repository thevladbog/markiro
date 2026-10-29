import { constants } from "node:fs";
import { lstat, open, realpath, chown, chmod, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, digest, ensure, keys } from "./backup/schemas.mjs";
import { assertPrivateRootSync, readPrivateFile, writePrivateFile } from "./host/files.mjs";
import { runHostProcess } from "./host/process.mjs";
import { withHostState } from "./host/state.mjs";
import { upgradeSchemaQuery } from "./host/upgrade-schema.mjs";
import { validateCatalogConfig, assertCatalogMounts } from "./catalog-config.mjs";
import { verifyCatalogBootstrapDispatch, assertNoCatalogPeers } from "./upgrade-dispatch.mjs";
import { fetchPlatformCi } from "./release-ci.mjs";
import { runReadBootstrapLifecycle } from "./catalog-bootstrap-lifecycle.mjs";
import {
  validateReadBootstrapOperation,
  workerEnvironment,
  postgresCaMount,
  validateBootstrapCaFile,
  readBootstrapWorkerArguments,
  sameReadBootstrap,
} from "./catalog-bootstrap-policy.mjs";
const HOST = "/opt/markiro-platform",
  STATE = `${HOST}/state`;
const CLEAN = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/nonexistent",
  LANG: "C",
  DOCKER_CONFIG: `${STATE}/docker`,
});
const delay = () => new Promise((resolve) => setTimeout(resolve, 250));
const uid = 1000;
/** Bounded no-follow read for the dedicated worker-owned IPC directory, not arbitrary customer paths. */
async function privateBytes(path, owner, mode) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    ensure(
      before.isFile() &&
        before.uid === owner &&
        before.nlink === 1 &&
        (before.mode & 0o7777) === mode &&
        before.size <= 2 * 1048576,
    );
    const bytes = await file.readFile(),
      after = await file.stat();
    ensure(
      bytes.length === before.size &&
        after.size === before.size &&
        after.ctimeMs === before.ctimeMs &&
        after.mtimeMs === before.mtimeMs,
    );
    return bytes;
  } finally {
    await file.close();
  }
}
function sortedMounts(mounts, field) {
  ensure(Array.isArray(mounts));
  const names = mounts.map((m) => m[field]);
  ensure(
    names.every((name) => typeof name === "string" && name.startsWith("/")) &&
      new Set(names).size === names.length,
  );
  return [...mounts].sort((a, b) => a[field].localeCompare(b[field]));
}
export function containerRecipe(container) {
  const host = { ...container.HostConfig };
  if (host.Mounts) host.Mounts = sortedMounts(host.Mounts, "Target");
  return digest(
    canonical({
      Image: container.Image,
      Config: container.Config,
      HostConfig: host,
      Mounts: sortedMounts(container.Mounts, "Destination"),
    }),
  );
}
export async function executeReadBootstrap({
  operationId,
  planSha256,
  dispatch,
  token,
  actorLogin,
  executorCiRunId,
  executorCiRunAttempt,
}) {
  ensure(/^[a-f0-9-]{36}$/u.test(operationId) && /^[a-f0-9]{64}$/u.test(planSha256));
  const root = `${HOST}/catalog-bootstrap-operations/${operationId}`;
  assertPrivateRootSync(root);
  const bytes = await readPrivateFile(root, "operation.json");
  ensure(digest(bytes) === planSha256);
  const operation = validateReadBootstrapOperation(JSON.parse(bytes));
  ensure(
    operation.operationId === operationId &&
      operation.executorSha === dispatch.toolingSha &&
      operation.executorCi.runId === executorCiRunId &&
      operation.executorCi.runAttempt === executorCiRunAttempt,
  );
  const moduleFile = `${root}/catalog-bootstrap.js`,
    runtimeFile = `${root}/bootstrap-runtime.mjs`;
  const rpc = `${root}/rpc`;
  const rpcStat = await lstat(rpc);
  ensure(
    rpcStat.isDirectory() &&
      rpcStat.uid === uid &&
      rpcStat.gid === uid &&
      (rpcStat.mode & 0o7777) === 0o700 &&
      (await realpath(rpc)) === rpc,
  );
  const command = async (args, input) =>
    runHostProcess({
      executable: "/usr/bin/docker",
      args,
      cwd: root,
      env: CLEAN,
      timeoutMs: 30000,
      outputLimitBytes: 1048576,
      ...(input ? { input } : {}),
    });
  const inspect = async (id) => {
    const result = JSON.parse((await command(["inspect", id])).stdout);
    ensure(Array.isArray(result) && result.length === 1 && result[0].Id === id);
    return result[0];
  };
  let authorization,
    workerId,
    workerCreateAttempted = false;
  const authorize = async () => {
    authorization = await verifyCatalogBootstrapDispatch(dispatch, token, { actorLogin });
    await assertNoCatalogPeers(dispatch, token);
  };
  const verifyFiles = async () => {
    ensure(digest(await readPrivateFile(root, "operation.json")) === planSha256);
    ensure(digest(await privateBytes(moduleFile, 0, 0o444)) === operation.bootstrapModuleSha256);
    ensure(digest(await privateBytes(runtimeFile, 0, 0o444)) === operation.runtimeScriptSha256);
    ensure(
      digest(await privateBytes(`${root}/input.json`, uid, 0o400)) === operation.inputFileSha256,
    );
    for (const guard of operation.guards)
      ensure(
        digest(await readPrivateFile(HOST, guard.path, { maxBytes: 2 * 1048576 })) === guard.sha256,
      );
  };
  let lastApi;
  const observe = async (fenced) => {
    await verifyFiles();
    const containers = {};
    for (const service of ["api", "edge", "postgres"]) {
      const expected = operation.containers[service],
        actual = await inspect(expected.id);
      ensure(
        actual.Image === expected.imageId && containerRecipe(actual) === expected.recipeSha256,
      );
      ensure(
        !actual.State.Paused &&
          !actual.State.Restarting &&
          !actual.State.Dead &&
          !actual.State.OOMKilled,
      );
      ensure(actual.State.Running === !(service === "api" && fenced));
      if (actual.State.Running && service !== "edge")
        ensure(actual.State.Health?.Status === "healthy");
      containers[service] = actual;
    }
    const processes = (
      await runHostProcess({
        executable: "/usr/bin/ps",
        args: ["-eo", "args="],
        cwd: root,
        env: CLEAN,
        timeoutMs: 30000,
        outputLimitBytes: 1048576,
      })
    ).stdout.toString();
    ensure(
      !/deploy\/platform\/(?:upgrade|recovery)-transport\.mjs (?:execute|host-command)\b/u.test(
        processes,
      ),
    );
    lastApi = containers.api;
    const ca = postgresCaMount(lastApi);
    const caInfo = await lstat(ca.Source);
    const caMetadata = validateBootstrapCaFile(caInfo);
    ensure((await realpath(ca.Source)) === ca.Source);
    ensure(
      digest(await privateBytes(ca.Source, caMetadata.owner, caMetadata.mode)) ===
        operation.postgresCaSha256,
    );
    const environment = Object.fromEntries(
      lastApi.Config.Env.map((entry) => {
        const index = entry.indexOf("=");
        return [entry.slice(0, index), entry.slice(index + 1)];
      }),
    );
    ensure(
      environment.RELEASE_CATALOG_WRITERS_ENABLED === "false" &&
        environment.SERVER_PROFILE === "platform-only",
    );
    ensure(validateCatalogConfig(environment));
    assertCatalogMounts(environment);
    const networks = Object.values(lastApi.NetworkSettings.Networks);
    ensure(networks.some((network) => network.NetworkID === operation.networkId));
    ensure(
      Object.values(containers.postgres.NetworkSettings.Networks).some(
        (network) => network.NetworkID === operation.networkId,
      ),
    );
    const running = (await command(["ps", "--no-trunc", "--format", "{{.ID}}"])).stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    const allowed = [
      operation.containers.edge.id,
      operation.containers.postgres.id,
      ...(fenced ? [] : [operation.containers.api.id]),
      ...(workerId ? [workerId] : []),
    ];
    ensure(running.every((id) => allowed.includes(id)));
    const schema = JSON.parse(
      (
        await command([
          "exec",
          "--user",
          "70:70",
          "--env",
          "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000",
          "--env",
          "PGCONNECT_TIMEOUT=10",
          operation.containers.postgres.id,
          "psql",
          "-X",
          "--no-password",
          "--username",
          "postgres",
          "--dbname",
          "markiro",
          "--tuples-only",
          "--no-align",
          "--command",
          upgradeSchemaQuery,
        ])
      ).stdout,
    );
    sameReadBootstrap(schema, operation.schemaProof);
  };
  // Exact artifact provenance is rechecked from GitHub before entering the host lock.
  await authorize();
  const ci = await fetchPlatformCi(
    {
      repository: "thevladbog/markiro",
      sourceSha: operation.executorSha,
      runId: operation.executorCi.runId,
    },
    token,
  );
  ensure(String(ci.run.run_attempt) === operation.executorCi.runAttempt);
  const artifactResponse = await fetch(
    `https://api.github.com/repos/thevladbog/markiro/actions/artifacts/${operation.artifact.id}`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  ensure(artifactResponse.ok);
  const artifact = await artifactResponse.json();
  ensure(
    String(artifact.id) === operation.artifact.id &&
      artifact.expired === false &&
      artifact.digest === `sha256:${operation.artifact.zipSha256}` &&
      artifact.name === `release-catalog-bootstrap-${operation.executorSha}` &&
      String(artifact.workflow_run?.id) === operation.executorCi.runId &&
      artifact.workflow_run?.head_sha === operation.executorSha,
  );
  return withHostState(STATE, async () => {
    let sequence = 0;
    const receipt = async (phase) =>
      writePrivateFile(
        root,
        `${phase}.json`,
        Buffer.from(
          JSON.stringify({
            schema: 1,
            operationId,
            planSha256,
            dispatch,
            authorization,
            phase,
            observedAt: new Date().toISOString(),
          }) + "\n",
        ),
      );
    const reply = async (request, approved) => {
      const temporary = join(rpc, `${randomUUID()}.reply.tmp`),
        destination = join(rpc, `${request.sequence}.reply.json`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            schema: 1,
            sequence: request.sequence,
            nonce: request.nonce,
            binding: request.binding,
            approved,
          }) + "\n",
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await chown(temporary, uid, uid);
      await chmod(temporary, 0o400);
      const published = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await published.sync();
      } finally {
        await published.close();
      }
      await link(temporary, destination);
      await unlink(temporary);
      const dir = await open(
        rpc,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    };
    return runReadBootstrapLifecycle({
      authorize,
      observe,
      receipt,
      stopApi: async () => {
        await command(["stop", "--time", "30", operation.containers.api.id]);
      },
      startApi: async () => {
        await command(["start", operation.containers.api.id]);
        for (;;) {
          const c = await inspect(operation.containers.api.id);
          ensure(c.State.Running && !c.State.OOMKilled);
          if (c.State.Health?.Status === "healthy") break;
          await delay();
        }
      },
      prepareWorker: async () => {
        const env = workerEnvironment(lastApi.Config.Env);
        await writePrivateFile(root, "worker.env", Buffer.from(env.join("\n") + "\n"));
        const args = readBootstrapWorkerArguments({ operation, root, api: lastApi });
        workerCreateAttempted = true;
        workerId = (await command(args)).stdout.toString().trim();
        ensure(/^[a-f0-9]{64}$/u.test(workerId));
        await writePrivateFile(
          root,
          "worker-created.json",
          Buffer.from(JSON.stringify({ id: workerId, operationId }) + "\n"),
        );
        await command(["start", workerId]);
        for (;;) {
          const worker = await inspect(workerId);
          ensure(
            worker.Image === operation.containers.api.imageId &&
              worker.Config.Labels?.["markiro.catalog-bootstrap"] === operationId,
          );
          ensure(worker.State.Running);
          let first;
          try {
            first = JSON.parse(await privateBytes(`${rpc}/1.request.json`, uid, 0o600));
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await delay();
            continue;
          }
          keys(first, ["schema", "sequence", "nonce", "binding"]);
          ensure(
            first.schema === 1 && first.sequence === 1 && /^[a-f0-9-]{36}$/u.test(first.nonce),
          );
          sameReadBootstrap(first.binding, operation.binding);
          // No reply before the actual API stop: the library cannot enter a write transaction.
          break;
        }
      },
      abortPreparedWorker: async () => {
        if (!workerCreateAttempted) return { terminationConfirmed: true };
        if (!workerId) {
          const rows = JSON.parse(
            (await command(["inspect", `markiro-catalog-bootstrap-${operationId}`])).stdout,
          );
          ensure(Array.isArray(rows) && rows.length === 1);
          workerId = rows[0].Id;
        }
        let worker = await inspect(workerId);
        ensure(
          worker.Name === `/markiro-catalog-bootstrap-${operationId}` &&
            worker.Image === operation.containers.api.imageId &&
            worker.Config.Labels?.["markiro.catalog-bootstrap"] === operationId,
        );
        if (worker.State.Running) await command(["stop", "--time", "30", workerId]);
        worker = await inspect(workerId);
        ensure(
          !worker.State.Running &&
            worker.State.Pid === 0 &&
            !worker.State.Restarting &&
            !worker.State.Paused &&
            !worker.State.Dead,
        );
        await writePrivateFile(
          root,
          "preflight-worker-terminal.json",
          Buffer.from(
            JSON.stringify({
              id: workerId,
              exitCode: worker.State.ExitCode,
              noMutationGuardGranted: true,
            }) + "\n",
          ),
        );
        return { terminationConfirmed: true };
      },
      runWorker: async () => {
        ensure(typeof workerId === "string");
        for (;;) {
          const worker = await inspect(workerId);
          ensure(
            worker.Image === operation.containers.api.imageId &&
              worker.Config.Labels?.["markiro.catalog-bootstrap"] === operationId,
          );
          if (!worker.State.Running) {
            ensure(
              worker.State.Pid === 0 &&
                !worker.State.Restarting &&
                !worker.State.Paused &&
                !worker.State.Dead,
            );
            let result;
            try {
              result = JSON.parse(await privateBytes(`${rpc}/result.json`, uid, 0o600)).result;
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            await writePrivateFile(
              root,
              "worker-terminal.json",
              Buffer.from(
                JSON.stringify({
                  id: workerId,
                  exitCode: worker.State.ExitCode,
                  oomKilled: worker.State.OOMKilled,
                  result: result ?? null,
                }) + "\n",
              ),
            );
            return { terminationConfirmed: true, exitCode: worker.State.ExitCode, result };
          }
          let request;
          try {
            request = JSON.parse(
              await privateBytes(`${rpc}/${sequence + 1}.request.json`, uid, 0o600),
            );
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await delay();
            continue;
          }
          keys(request, ["schema", "sequence", "nonce", "binding"]);
          ensure(
            request.schema === 1 &&
              request.sequence === sequence + 1 &&
              sequence < 256 &&
              /^[a-f0-9-]{36}$/u.test(request.nonce),
          );
          sameReadBootstrap(request.binding, operation.binding);
          let approved = false;
          try {
            await authorize();
            await observe(true);
            approved = true;
          } catch {
            /* A denied live guard is relayed fail-closed so the owned worker can drain. */
          }
          await reply(request, approved);
          sequence++;
        }
      },
    });
  });
}

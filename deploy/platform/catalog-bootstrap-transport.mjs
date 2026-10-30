import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ensure } from "./backup/schemas.mjs";
import { recoverySshArguments } from "./recovery-transport.mjs";
import { verifyCatalogBootstrapDispatch, validateUpgradeDispatch } from "./upgrade-dispatch.mjs";
import { writePrivateFile } from "./host/files.mjs";
import { runHostProcess } from "./host/process.mjs";
import { executeReadBootstrap } from "./catalog-bootstrap-host.mjs";
export function readBootstrapSshArguments(
  target,
  operationId,
  planSha256,
  dispatch,
  executorCiRunId = "1",
  executorCiRunAttempt = "1",
) {
  validateUpgradeDispatch(dispatch);
  ensure(/^[1-9][0-9]{0,19}$/u.test(executorCiRunId) && executorCiRunAttempt === "1");
  ensure(/^[a-f0-9]{64}$/u.test(planSha256));
  const args = recoverySshArguments(
    target,
    "execute",
    operationId,
    "prepare",
    dispatch.toolingSha,
    dispatch,
  );
  return [
    ...args.slice(0, -1),
    `exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent LANG=C /usr/bin/node /opt/markiro-platform/catalog-bootstrap-executors/${dispatch.toolingSha}/deploy/platform/catalog-bootstrap-transport.mjs execute ${operationId} ${planSha256} ${dispatch.toolingSha} ${dispatch.runId} ${dispatch.runAttempt} ${executorCiRunId} ${executorCiRunAttempt}`,
  ];
}
async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    ensure(size <= 65536);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function cli() {
  let temporary;
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === "execute") {
      ensure(args.length === 7);
      const [
        operationId,
        planSha256,
        toolingSha,
        runId,
        runAttempt,
        executorCiRunId,
        executorCiRunAttempt,
      ] = args;
      const dispatch = validateUpgradeDispatch({ toolingSha, runId, runAttempt });
      const { token, actorLogin } = JSON.parse((await readInput()).toString("utf8"));
      const result = await executeReadBootstrap({
        operationId,
        planSha256,
        dispatch,
        token,
        actorLogin,
        executorCiRunId,
        executorCiRunAttempt,
      });
      process.stdout.write(
        JSON.stringify({
          catalogReadBootstrap: "completed",
          revision: result.revision,
          writersMayEnable: result.writersMayEnable,
        }) + "\n",
      );
    } else {
      ensure(mode === "run" && args.length === 0);
      const values = (await readInput()).toString("utf8").split("\0");
      ensure(values.length === 16 && values.pop() === "");
      const [
        host,
        port,
        user,
        privateKey,
        knownHosts,
        token,
        actorLogin,
        toolingSha,
        runId,
        runAttempt,
        executorSha,
        executorCiRunId,
        executorCiRunAttempt,
        operationId,
        planSha256,
      ] = values;
      ensure(
        toolingSha === executorSha &&
          /^[1-9][0-9]{0,19}$/u.test(executorCiRunId) &&
          executorCiRunAttempt === "1",
      );
      const dispatch = validateUpgradeDispatch({ toolingSha, runId, runAttempt });
      await verifyCatalogBootstrapDispatch(dispatch, token, { actorLogin });
      temporary = await realpath(await mkdtemp(join(tmpdir(), "catalog-bootstrap-transport-")));
      await chmod(temporary, 0o700);
      await writePrivateFile(temporary, "identity", Buffer.from(privateKey + "\n"));
      await writePrivateFile(temporary, "known-hosts", Buffer.from(knownHosts + "\n"));
      const target = {
        host,
        port,
        user,
        identityFile: join(temporary, "identity"),
        knownHostsFile: join(temporary, "known-hosts"),
      };
      const result = await runHostProcess({
        executable: "/usr/bin/ssh",
        args: readBootstrapSshArguments(
          target,
          operationId,
          planSha256,
          dispatch,
          executorCiRunId,
          executorCiRunAttempt,
        ),
        cwd: temporary,
        env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C" },
        timeoutMs: 3600000,
        outputLimitBytes: 1048576,
        input: Buffer.from(JSON.stringify({ token, actorLogin })),
      });
      ensure(result.stderr.length === 0);
      const outcome = JSON.parse(result.stdout);
      ensure(
        outcome.catalogReadBootstrap === "completed" &&
          outcome.revision === "1" &&
          outcome.writersMayEnable === false,
      );
      process.stdout.write(
        "Initial read-only catalog channel committed; writers remain disabled.\n",
      );
    }
  } catch {
    process.stderr.write(
      "Catalog bootstrap failed; preserve evidence and reconcile before any new operation.\n",
    );
    process.exitCode = 1;
  } finally {
    if (temporary)
      await rm(temporary, { recursive: true, force: true, maxRetries: 0 }).catch(() => {
        process.exitCode = 1;
      });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cli();

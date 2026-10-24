import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  UPGRADE_BUNDLE_FILES,
  loadUpgradeOperation,
  runUpgradeHostCommand,
} from "./host/upgrade-command.mjs";
import { RECOVERY_BUNDLE_FILES } from "./host/recovery-command.mjs";
import {
  validateTransportSelection,
  recoverySshArguments,
  buildSourceBundle as buildRecoverySourceBundle,
} from "./recovery-transport.mjs";
import { validateUpgradeDispatch, verifyUpgradeDispatch } from "./upgrade-dispatch.mjs";
import { canonical, digest, ensure, keys } from "./backup/schemas.mjs";
import { canonicalId, exactKeys } from "./release-admission.mjs";
import { runHostProcess } from "./host/process.mjs";
import {
  assertPrivateRootSync,
  assertPrivateFileSync,
  createPrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from "./host/files.mjs";
import { withHostState } from "./host/state.mjs";
import { fetchPlatformCi } from "./release-ci.mjs";
import { githubTransport, REPOSITORY } from "./admission-github.mjs";
import { admitPlatformRelease } from "./admit-release.mjs";
const HOST_ROOT = "/opt/markiro-platform";
const CLEAN_ENV = Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C" });
const RECEIVED = "Platform upgrade executor bundle received.\n";
const HASH = /^[a-f0-9]{64}$/u;
const SELECTION_KEYS = [
  "executorSha",
  "executorCiRunId",
  "executorCiRunAttempt",
  "sourceSha",
  "workflowRunId",
  "workflowRunAttempt",
  "artifactId",
  "operationId",
];
const same = (a, b) => ensure(canonical(a) === canonical(b));
const matches = (v, p) => typeof v === "string" && p.exec(v)?.[0] === v;
const phaseStatus = (phase) => {
  ensure(["prepare", "activate", "return-old"].includes(phase));
  return { prepare: "backup-verified", activate: "healthy", "return-old": "returned-old" }[phase];
};
const phaseOutput = (phase) => `Platform upgrade ${phase} ${phaseStatus(phase)}.\n`;
function failure() {
  const e = new Error(
    "Platform upgrade delivery failed; preserve host state and reconcile before retry.",
  );
  e.code = "ERR_UPGRADE_TRANSPORT";
  e.recoveryRequired = true;
  return e;
}
export function upgradeSshArguments(target, mode, operationId, phase, executorSha, dispatch) {
  phaseStatus(phase);
  validateUpgradeDispatch(dispatch);
  ensure(dispatch.toolingSha === executorSha);
  // Reuse only the pure strict host/key/SSH option validator. No recovery
  // executor or command is invoked; the upgrade protocol has its own fixed path.
  const args = recoverySshArguments(
    target,
    mode,
    operationId,
    phase === "return-old" ? "prepare" : phase,
    executorSha,
    dispatch,
  );
  return [
    ...args.slice(0, -1),
    `exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent LANG=C /usr/bin/node ${HOST_ROOT}/upgrade-bootstrap/${executorSha}/deploy/platform/upgrade-transport.mjs ${mode} ${operationId} ${phase} ${executorSha} ${dispatch.toolingSha} ${dispatch.runId} ${dispatch.runAttempt}`,
  ];
}
export function upgradeOutcome(result, phase) {
  ensure(
    result.exitCode === 0 &&
      result.stdout.toString() === phaseOutput(phase) &&
      result.stderr.length === 0,
  );
  return phaseStatus(phase);
}
export function validateBundle(bundle, receipt) {
  keys(receipt, [
    "version",
    "kind",
    "operationId",
    "executorSha",
    "ci",
    "installationDispatch",
    "files",
  ]);
  ensure(receipt.version === 1 && receipt.kind === "platform-upgrade-installed-executor");
  validateUpgradeDispatch(receipt.installationDispatch);
  ensure(receipt.installationDispatch.toolingSha === receipt.executorSha);
  keys(receipt.ci, ["runId", "runAttempt"]);
  ensure(Object.values(receipt.ci).every(canonicalId));
  keys(bundle, ["version", "kind", "selection", "files"]);
  ensure(bundle.version === 1 && bundle.kind === "platform-upgrade-source-transfer");
  const s = validateTransportSelection(bundle.selection);
  ensure(
    s.executorSha === receipt.executorSha &&
      s.operationId === receipt.operationId &&
      s.executorCiRunId === receipt.ci.runId &&
      s.executorCiRunAttempt === receipt.ci.runAttempt,
  );
  keys(receipt.files, UPGRADE_BUNDLE_FILES);
  keys(bundle.files, UPGRADE_BUNDLE_FILES);
  const files = {};
  for (const p of UPGRADE_BUNDLE_FILES) {
    const text = bundle.files[p];
    ensure(typeof text === "string" && text.length <= 1048576 && matches(receipt.files[p], HASH));
    const b = Buffer.from(text, "base64");
    ensure(b.toString("base64") === text && digest(b) === receipt.files[p]);
    files[p] = b;
  }
  return files;
}
const processOptions = (cwd) => ({
  cwd,
  env: CLEAN_ENV,
  timeoutMs: 60000,
  outputLimitBytes: 1048576,
});
export async function buildSourceBundle(
  selection,
  checkoutRoot,
  workDirectory,
  dispatch,
  options = {},
) {
  validateUpgradeDispatch(dispatch);
  ensure(dispatch.toolingSha === selection.executorSha);
  assertPrivateRootSync(workDirectory);
  const original = await buildRecoverySourceBundle(selection, checkoutRoot, workDirectory, options);
  const files = { ...original.bundle.files },
    hashes = { ...original.receipt.files };
  for (const p of UPGRADE_BUNDLE_FILES.filter((p) => !RECOVERY_BUNDLE_FILES.includes(p))) {
    const b = (
      await (options.runProcess ?? runHostProcess)({
        ...processOptions(workDirectory),
        executable: "/usr/bin/git",
        args: ["-C", checkoutRoot, "show", `${selection.executorSha}:${p}`],
      })
    ).stdout;
    ensure(b.length <= 1048576);
    files[p] = b.toString("base64");
    hashes[p] = digest(b);
  }
  const bundle = { version: 1, kind: "platform-upgrade-source-transfer", selection, files };
  const receipt = {
    version: 1,
    kind: "platform-upgrade-installed-executor",
    operationId: selection.operationId,
    executorSha: selection.executorSha,
    ci: original.receipt.ci,
    installationDispatch: dispatch,
    files: hashes,
  };
  validateBundle(bundle, receipt);
  ensure(Buffer.byteLength(JSON.stringify(bundle)) <= 1048576);
  return { bundle, receipt };
}
/** All local gates precede the first SSH. No remote cleanup/retry follows failure. */
export async function runTransport(
  { selection, target, token, githubActor, checkoutRoot, workDirectory, phase, dispatch },
  options = {},
) {
  let ownedDockerConfig;
  let failed = false;
  try {
    ensure(matches(githubActor, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u));
    validateTransportSelection(selection);
    upgradeSshArguments(
      target,
      "receive",
      selection.operationId,
      phase,
      selection.executorSha,
      dispatch,
    );
    assertPrivateFileSync(target.identityFile);
    assertPrivateFileSync(target.knownHostsFile);
    const pin = (
      await readPrivateFile(dirname(target.knownHostsFile), target.knownHostsFile.split("/").at(-1))
    ).toString("utf8");
    const entry = pin.replace(/\n$/u, "").split(" ");
    const hostName = target.port === "22" ? target.host : `[${target.host}]:${target.port}`;
    ensure(
      entry.length === 3 &&
        entry[0] === hostName &&
        ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"].includes(entry[1]),
    );
    const publicKey = Buffer.from(entry[2], "base64");
    ensure(publicKey.toString("base64") === entry[2] && publicKey.length > 4);
    const algorithmLength = publicKey.readUInt32BE(0);
    ensure(
      algorithmLength === entry[1].length &&
        publicKey.length > 4 + algorithmLength &&
        publicKey.subarray(4, 4 + algorithmLength).toString() === entry[1],
    );
    ensure(
      typeof token === "string" && token.length <= 16384 && token.length > 0 && !/\s/u.test(token),
    );
    await verifyUpgradeDispatch(dispatch, token, {
      actorLogin: githubActor,
      request: options.request,
    });
    const run = options.runProcess ?? runHostProcess;
    const transport = githubTransport(token, options.request);
    const ci = await fetchPlatformCi(
      {
        repository: REPOSITORY,
        sourceSha: selection.executorSha,
        runId: selection.executorCiRunId,
      },
      token,
      transport.ciRequest,
    );
    ensure(ci.identity.ciRunAttempt === selection.executorCiRunAttempt);
    await createPrivateDirectory(workDirectory, "docker-auth");
    ownedDockerConfig = join(workDirectory, "docker-auth");
    await writePrivateFile(
      ownedDockerConfig,
      "config.json",
      Buffer.from(
        JSON.stringify({
          auths: { "ghcr.io": { auth: Buffer.from(`${githubActor}:${token}`).toString("base64") } },
        }),
      ),
    );
    // Existing admission performs exact publisher/attempt/artifact/ZIP/CI/registry checks.
    const admit = options.admit ?? admitPlatformRelease;
    await admit(
      {
        sourceSha: selection.sourceSha,
        workflowRunId: selection.workflowRunId,
        workflowRunAttempt: selection.workflowRunAttempt,
        artifactId: selection.artifactId,
        outputFile: join(workDirectory, "admission.json"),
      },
      {
        token,
        request: options.request,
        tempRoot: workDirectory,
        run: async (command, args) => {
          ensure(
            command === "docker" &&
              Array.isArray(args) &&
              args.length === 4 &&
              args[0] === "manifest" &&
              args[1] === "inspect" &&
              args[2] === "--verbose" &&
              matches(
                args[3],
                /^ghcr\.io\/thevladbog\/markiro-(?:api|platform-edge)@sha256:[a-f0-9]{64}$/u,
              ),
          );
          return (
            await run({
              ...processOptions(workDirectory),
              env: { ...CLEAN_ENV, DOCKER_CONFIG: ownedDockerConfig },
              executable: "/usr/bin/docker",
              args,
            })
          ).stdout.toString();
        },
      },
    );
    const { bundle } = await buildSourceBundle(selection, checkoutRoot, workDirectory, dispatch, {
      runProcess: run,
    });
    const invoke = (mode, input) =>
      run({
        ...processOptions(workDirectory),
        timeoutMs: mode === "execute" ? 3000000 : 120000,
        executable: "/usr/bin/ssh",
        args: upgradeSshArguments(
          target,
          mode,
          selection.operationId,
          phase,
          selection.executorSha,
          dispatch,
        ),
        input,
      });
    const receivedRaw = await invoke(
      "receive",
      Buffer.from(JSON.stringify({ bundle, phase, dispatch })),
    );
    ensure(receivedRaw.exitCode === undefined || receivedRaw.exitCode === 0);
    const received = { ...receivedRaw, exitCode: 0 };
    ensure(
      received.exitCode === 0 &&
        received.stdout.toString() === RECEIVED &&
        received.stderr.length === 0,
    );
    const executed = await invoke("execute", Buffer.from(token));
    ensure(executed.exitCode === undefined || executed.exitCode === 0);
    upgradeOutcome({ ...executed, exitCode: 0 }, phase);
  } catch {
    failed = true;
  } finally {
    if (ownedDockerConfig) {
      try {
        await rm(ownedDockerConfig, { recursive: true, force: true, maxRetries: 0 });
      } catch {
        failed = true;
      }
    }
  }
  if (failed) throw failure();
}

async function preparedUpgrade(operationId, phase, executorSha, dispatch, options = {}) {
  validateTransportSelection({
    executorSha,
    operationId,
    executorCiRunId: "1",
    executorCiRunAttempt: "1",
    sourceSha: executorSha,
    workflowRunId: "1",
    workflowRunAttempt: "1",
    artifactId: "1",
  });
  phaseStatus(phase);
  validateUpgradeDispatch(dispatch);
  ensure(dispatch.toolingSha === executorSha);
  const root = options.hostRoot ?? HOST_ROOT;
  const directory = join(root, "upgrade-operations", operationId, phase);
  const loaded = await loadUpgradeOperation(directory, options),
    { record } = loaded;
  same(record.dispatch, dispatch);
  const admission = record.operation.admission;
  ensure(
    record.phase === phase &&
      admission.identity.operationId === operationId &&
      admission.identity.executorSha === executorSha,
  );
  return { root, directory, loaded, record, admission };
}
export async function receiveUpgradeBundle(
  operationId,
  phase,
  executorSha,
  dispatch,
  bytes,
  options = {},
) {
  ensure(Buffer.isBuffer(bytes) && bytes.length <= 1048576);
  const input = JSON.parse(bytes);
  keys(input, ["bundle", "phase", "dispatch"]);
  ensure(JSON.stringify(input) === bytes.toString() && input.phase === phase);
  same(input.dispatch, dispatch);
  const { loaded, record, directory, admission } = await preparedUpgrade(
    operationId,
    phase,
    executorSha,
    dispatch,
    options,
  );
  validateBundle(input.bundle, loaded.receipt);
  const s = input.bundle.selection,
    original = admission.identity.admission;
  ensure(
    s.sourceSha === original.manifest.sourceSha &&
      s.workflowRunId === original.publisher.runId &&
      s.workflowRunAttempt === original.publisher.runAttempt &&
      s.artifactId === original.artifact.id,
  );
  await withHostState(record.operation.root, async () => {
    await preparedUpgrade(operationId, phase, executorSha, dispatch, options);
    await loaded.verifySources();
    await writePrivateFile(
      directory,
      "delivery.json",
      Buffer.from(
        JSON.stringify({ phase, dispatch, executorSha, operationId, bundleSha256: digest(bytes) }),
      ),
    );
  });
  return RECEIVED;
}
export async function executeUpgradeHost(
  operationId,
  phase,
  executorSha,
  dispatch,
  tokenBytes,
  options = {},
) {
  ensure(
    Buffer.isBuffer(tokenBytes) &&
      tokenBytes.length > 0 &&
      tokenBytes.length <= 16384 &&
      !/\s/u.test(tokenBytes.toString()),
  );
  const { directory, record, loaded } = await preparedUpgrade(
    operationId,
    phase,
    executorSha,
    dispatch,
    options,
  );
  const authorize = async () =>
    same(
      await verifyUpgradeDispatch(dispatch, tokenBytes.toString(), {
        actorLogin: record.authorization.actorLogin,
        request: options.request,
      }),
      record.authorization,
    );
  await authorize();
  const delivery = JSON.parse(await readPrivateFile(directory, "delivery.json"));
  keys(delivery, ["phase", "dispatch", "executorSha", "operationId", "bundleSha256"]);
  ensure(
    delivery.phase === phase &&
      delivery.executorSha === executorSha &&
      delivery.operationId === operationId &&
      matches(delivery.bundleSha256, HASH),
  );
  same(delivery.dispatch, dispatch);
  await withHostState(record.operation.root, async () => {
    await preparedUpgrade(operationId, phase, executorSha, dispatch, options);
    await loaded.verifySources();
    await authorize();
    await writePrivateFile(
      directory,
      "execution-fence.json",
      Buffer.from(JSON.stringify({ version: 1, phase, executorSha, operationId, dispatch })),
    );
    await writePrivateFile(directory, "github-token", tokenBytes);
  });
  const result = await (options.runProcess ?? runHostProcess)({
    ...processOptions(directory),
    timeoutMs: 2940000,
    executable: "/usr/bin/node",
    args: [
      join(record.installedRoot, "deploy/platform/upgrade-transport.mjs"),
      "host-command",
      operationId,
      phase,
      executorSha,
      dispatch.toolingSha,
      dispatch.runId,
      dispatch.runAttempt,
    ],
  });
  ensure(result.exitCode === undefined || result.exitCode === 0);
  upgradeOutcome({ ...result, exitCode: 0 }, phase);
  return phaseOutput(phase);
}
async function readInput(limit) {
  let count = 0;
  const chunks = [];
  const deadline = setTimeout(() => process.stdin.destroy(failure()), 30000);
  try {
    for await (const bytes of process.stdin) {
      count += bytes.length;
      ensure(count <= limit);
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(deadline);
  }
}
async function cli() {
  let workDirectory;
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (["receive", "execute", "host-command"].includes(mode)) {
      ensure(args.length === 6);
      const [operationId, phase, executorSha, toolingSha, runId, runAttempt] = args;
      const dispatch = { toolingSha, runId, runAttempt };
      ensure(
        fileURLToPath(import.meta.url) ===
          `${HOST_ROOT}/upgrade-bootstrap/${executorSha}/deploy/platform/upgrade-transport.mjs`,
      );
      if (mode === "host-command") {
        const { directory, admission, record } = await preparedUpgrade(
          operationId,
          phase,
          executorSha,
          dispatch,
        );
        const fence = JSON.parse(await readPrivateFile(directory, "execution-fence.json"));
        ensure(
          exactKeys(fence, ["version", "phase", "executorSha", "operationId", "dispatch"]) &&
            fence.version === 1 &&
            fence.phase === phase &&
            fence.executorSha === executorSha &&
            fence.operationId === operationId &&
            canonical(fence.dispatch) === canonical(dispatch),
        );
        const token = (await readPrivateFile(directory, "github-token")).toString();
        same(
          await verifyUpgradeDispatch(dispatch, token, {
            actorLogin: record.authorization.actorLogin,
          }),
          record.authorization,
        );
        const ci = await fetchPlatformCi(
          { repository: REPOSITORY, sourceSha: executorSha, runId: admission.executorCi.runId },
          token,
        );
        ensure(ci.identity.ciRunAttempt === admission.executorCi.runAttempt);
        // The internal CLI also consumes its own deterministic capability, so
        // invoking that entrypoint again cannot bypass the receiver fence.
        await withHostState(`${HOST_ROOT}/state`, async () => {
          await preparedUpgrade(operationId, phase, executorSha, dispatch);
          await writePrivateFile(
            directory,
            "command-started.json",
            Buffer.from(JSON.stringify(fence)),
          );
        });
        const outcome = await runUpgradeHostCommand([phase, directory]);
        ensure(outcome.phase === phase && outcome.status === phaseStatus(phase));
        process.stdout.write(phaseOutput(phase));
      } else {
        const input = await readInput(mode === "receive" ? 1048576 : 16384);
        process.stdout.write(
          mode === "receive"
            ? await receiveUpgradeBundle(operationId, phase, executorSha, dispatch, input)
            : await executeUpgradeHost(operationId, phase, executorSha, dispatch, input),
        );
      }
    } else {
      ensure(mode === "run" && args.length === 0);
      const values = (await readInput(65536)).toString().split("\0");
      ensure(values.length === 20 && values.pop() === "");
      const [
        host,
        port,
        user,
        privateKey,
        knownHosts,
        token,
        githubActor,
        phase,
        toolingSha,
        runId,
        runAttempt,
        ...selected
      ] = values;
      const selection = Object.fromEntries(
        SELECTION_KEYS.map((key, index) => [key, selected[index]]),
      );
      workDirectory = await realpath(await mkdtemp(join(tmpdir(), "platform-upgrade-transport-")));
      await chmod(workDirectory, 0o700);
      await writePrivateFile(workDirectory, "identity", Buffer.from(privateKey + "\n"));
      await writePrivateFile(workDirectory, "known-hosts", Buffer.from(knownHosts + "\n"));
      await runTransport({
        selection,
        target: {
          host,
          port,
          user,
          identityFile: join(workDirectory, "identity"),
          knownHostsFile: join(workDirectory, "known-hosts"),
        },
        token,
        githubActor,
        phase,
        dispatch: { toolingSha, runId, runAttempt },
        checkoutRoot: await realpath(process.cwd()),
        workDirectory,
      });
      process.stdout.write(phaseOutput(phase));
    }
  } catch {
    process.stderr.write(
      "Platform upgrade delivery failed; preserve host state and reconcile before retry.\n",
    );
    process.exitCode = 1;
  } finally {
    if (workDirectory)
      await rm(workDirectory, { recursive: true, force: true, maxRetries: 0 }).catch(() => {
        process.exitCode = 1;
      });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cli();

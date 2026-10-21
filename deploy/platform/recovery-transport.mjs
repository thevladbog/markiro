import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RECOVERY_BUNDLE_FILES as HOST_BUNDLE_FILES,
  loadRecoveryOperation,
  runRecoveryHostCommand,
} from "./host/recovery-command.mjs";
import { validateRecoveryAdmission } from "./host/recovery-admission.mjs";
import { validateRecoveryActivationAdmission } from "./host/recovery-activation-admission.mjs";
import { canonical } from "./backup/schemas.mjs";
import { runHostProcess } from "./host/process.mjs";
import {
  assertPrivateRootSync,
  assertPrivateFileSync,
  createPrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from "./host/files.mjs";
import { withHostState } from "./host/state.mjs";
import { digest } from "./backup/schemas.mjs";
import { canonicalId, exactKeys, validSelection } from "./release-admission.mjs";
import { fetchPlatformCi } from "./release-ci.mjs";
import { githubTransport, REPOSITORY } from "./admission-github.mjs";
import { admitPlatformRelease } from "./admit-release.mjs";

const HOST_ROOT = "/opt/markiro-platform";
const CLEAN_ENV = Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C" });
const RECEIVED = "Platform executor bundle received.\n";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{40}$/u;
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
const matches = (value, pattern) => typeof value === "string" && pattern.exec(value)?.[0] === value;
function failure() {
  const error = new Error(
    "Platform transport failed; reconcile protected host state before any retry.",
  );
  error.code = "ERR_PLATFORM_TRANSPORT";
  error.recoveryRequired = true;
  return error;
}
const ensure = (value) => {
  if (!value) throw failure();
};
const pathSafe = (value) =>
  matches(value, /^\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/u);
export function validateTransportSelection(value) {
  ensure(exactKeys(value, SELECTION_KEYS));
  ensure(matches(value.executorSha, SHA) && matches(value.operationId, UUID));
  for (const key of ["executorCiRunId", "executorCiRunAttempt", "artifactId"])
    ensure(canonicalId(value[key]));
  ensure(
    validSelection({
      sourceSha: value.sourceSha,
      workflowRunId: value.workflowRunId,
      workflowRunAttempt: value.workflowRunAttempt,
    }),
  );
  return value;
}
export function recoverySshArguments(target, mode, operationId, phase, executorSha, dispatch) {
  ensure(["prepare", "activate"].includes(phase) && SHA.test(executorSha));
  validateDispatch(dispatch);
  ensure(exactKeys(target, ["host", "port", "user", "identityFile", "knownHostsFile"]));
  ensure(
    matches(target.host, /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u) &&
      !target.host.includes(".."),
  );
  ensure(matches(target.user, /^[a-z_][a-z0-9_-]{0,31}$/u));
  ensure(canonicalId(target.port) && Number(target.port) <= 65535);
  ensure(pathSafe(target.identityFile) && pathSafe(target.knownHostsFile));
  ensure(["receive", "execute"].includes(mode) && matches(operationId, UUID));
  return [
    "-F",
    "/dev/null",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `UserKnownHostsFile=${target.knownHostsFile}`,
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "CheckHostIP=no",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "PermitLocalCommand=no",
    "-p",
    target.port,
    "-i",
    target.identityFile,
    "-l",
    target.user,
    "--",
    target.host,
    `exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent LANG=C /usr/bin/node ${HOST_ROOT}/recovery-bootstrap/${executorSha}/deploy/platform/recovery-transport.mjs ${mode} ${operationId} ${phase} ${executorSha} ${dispatch.toolingSha} ${dispatch.runId} ${dispatch.runAttempt}`,
  ];
}
const phaseOutput = (phase) =>
  phase === "prepare"
    ? "Platform recovery preparation backup-verified.\n"
    : "Platform recovery activation healthy.\n";
export function recoveryOutcome(result, phase) {
  ensure(["prepare", "activate"].includes(phase));
  ensure(
    result.exitCode === 0 &&
      result.stdout.toString() === phaseOutput(phase) &&
      result.stderr.length === 0,
  );
  return phase === "prepare" ? "backup-verified" : "healthy";
}
function validateDispatch(value) {
  ensure(
    exactKeys(value, ["toolingSha", "runId", "runAttempt"]) &&
      matches(value.toolingSha, SHA) &&
      canonicalId(value.runId) &&
      canonicalId(value.runAttempt),
  );
}
export async function verifyRecoveryDispatch(dispatch, token, request = fetch) {
  validateDispatch(dispatch);
  ensure(
    typeof token === "string" && token.length > 0 && token.length <= 16384 && !/\s/u.test(token),
  );
  const base = `https://api.github.com/repos/${REPOSITORY}/actions/runs/${dispatch.runId}`;
  for (const url of [base, `${base}/attempts/${dispatch.runAttempt}`]) {
    const response = await request(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    ensure(response.ok);
    const run = await response.json();
    ensure(
      String(run.id) === dispatch.runId &&
        String(run.run_attempt) === dispatch.runAttempt &&
        run.head_sha === dispatch.toolingSha &&
        run.head_branch === "main" &&
        run.event === "workflow_dispatch" &&
        run.path === ".github/workflows/recover-platform.yml" &&
        run.repository?.full_name === REPOSITORY &&
        run.head_repository?.full_name === REPOSITORY &&
        run.status === "in_progress",
    );
  }
}
function validateReceipt(receipt) {
  ensure(exactKeys(receipt, ["version", "kind", "executorSha", "ci", "files"]));
  ensure(
    receipt.version === 1 &&
      receipt.kind === "platform-installed-executor" &&
      matches(receipt.executorSha, SHA),
  );
  ensure(
    exactKeys(receipt.ci, ["runId", "runAttempt"]) &&
      canonicalId(receipt.ci.runId) &&
      canonicalId(receipt.ci.runAttempt),
  );
  ensure(exactKeys(receipt.files, HOST_BUNDLE_FILES));
  for (const value of Object.values(receipt.files)) ensure(matches(value, HASH));
}
export function validateBundle(bundle, receipt) {
  validateReceipt(receipt);
  ensure(
    exactKeys(bundle, ["version", "kind", "selection", "files"]) &&
      bundle.version === 1 &&
      bundle.kind === "platform-source-transfer",
  );
  const selection = validateTransportSelection(bundle.selection);
  ensure(
    selection.executorSha === receipt.executorSha &&
      selection.executorCiRunId === receipt.ci.runId &&
      selection.executorCiRunAttempt === receipt.ci.runAttempt,
  );
  ensure(exactKeys(bundle.files, HOST_BUNDLE_FILES));
  const files = {};
  for (const path of HOST_BUNDLE_FILES) {
    const text = bundle.files[path];
    ensure(typeof text === "string" && text.length <= 1024 * 1024);
    const bytes = Buffer.from(text, "base64");
    ensure(bytes.toString("base64") === text && digest(bytes) === receipt.files[path]);
    files[path] = bytes;
  }
  return files;
}
const processOptions = (cwd) => ({
  cwd,
  env: CLEAN_ENV,
  timeoutMs: 60000,
  outputLimitBytes: 1024 * 1024,
});

/** Hash immutable Git blobs selected from the checkout repository; caller hashes are never provenance. */
export async function buildSourceBundle(selection, checkoutRoot, workDirectory, options = {}) {
  validateTransportSelection(selection);
  assertPrivateRootSync(workDirectory);
  const run = options.runProcess ?? runHostProcess;
  const git = async (args) =>
    (
      await run({
        ...processOptions(workDirectory),
        executable: "/usr/bin/git",
        args: ["-C", checkoutRoot, ...args],
      })
    ).stdout;
  const files = {};
  const hashes = {};
  for (const path of HOST_BUNDLE_FILES) {
    const bytes = await git(["show", `${selection.executorSha}:${path}`]);
    ensure(bytes.length <= 1024 * 1024);
    files[path] = bytes.toString("base64");
    hashes[path] = digest(bytes);
  }
  const bundle = { version: 1, kind: "platform-source-transfer", selection, files };
  const receipt = {
    version: 1,
    kind: "platform-installed-executor",
    executorSha: selection.executorSha,
    ci: { runId: selection.executorCiRunId, runAttempt: selection.executorCiRunAttempt },
    files: hashes,
  };
  validateBundle(bundle, receipt);
  ensure(Buffer.byteLength(JSON.stringify(bundle)) <= 1024 * 1024);
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
    recoverySshArguments(
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
    await verifyRecoveryDispatch(dispatch, token, options.request);
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
    const { bundle } = await buildSourceBundle(selection, checkoutRoot, workDirectory, {
      runProcess: run,
    });
    const invoke = (mode, input) =>
      run({
        ...processOptions(workDirectory),
        timeoutMs: mode === "execute" ? 3000000 : 120000,
        executable: "/usr/bin/ssh",
        args: recoverySshArguments(
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
    recoveryOutcome({ ...executed, exitCode: 0 }, phase);
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

// Independently provisioned, immutable receiver: transfer verifies bytes; it never
// installs a loader, patches a source, or replaces any original host input.
async function preparedRecovery(operationId, phase, executorSha, dispatch, options = {}) {
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
  validateDispatch(dispatch);
  ensure(["prepare", "activate"].includes(phase));
  const root = options.hostRoot ?? HOST_ROOT;
  const directory = join(options.root ?? root, "recovery-operations", operationId, phase);
  const bytes = await readPrivateFile(directory, "operation.json");
  const record = JSON.parse(bytes);
  ensure(record.phase === phase && canonical(record.dispatch) === canonical(dispatch));
  const admission =
    phase === "prepare" ? record.operation.admission : record.operation.activation.admission;
  ensure(
    admission.identity.operationId === operationId &&
      admission.identity.executorSha === executorSha,
  );
  ensure(
    record.installedRoot ===
      (options.installedRoot ?? join(root, "recovery-bootstrap", executorSha)) &&
      record.operation.root === (options.root ?? join(root, "state")),
  );
  const stateBytes = await readPrivateFile(record.operation.root, "state.json");
  validateRecoveryAdmission(admission, { stateBytes, now: Date.now() });
  if (phase === "activate")
    validateRecoveryActivationAdmission(record.operation.activation, {
      stateBytes,
      preparationBytes: await readPrivateFile(record.operation.root, "recovery-state.json"),
      now: Date.now(),
    });
  // Loader verifies every source before importing the runtime. Receiver itself
  // and its imports were verified out of band before private preprovisioning.
  const loaded = await loadRecoveryOperation(
    directory,
    options.root
      ? options
      : options.hostRoot
        ? { root: join(root, "state"), installedRoot: record.installedRoot }
        : {},
  );
  return { root, directory, record, admission, loaded };
}
export async function receiveRecoveryBundle(
  operationId,
  phase,
  executorSha,
  dispatch,
  bytes,
  options = {},
) {
  ensure(Buffer.isBuffer(bytes) && bytes.length <= 1048576);
  const input = JSON.parse(bytes);
  ensure(
    JSON.stringify(input) === bytes.toString() && exactKeys(input, ["bundle", "phase", "dispatch"]),
  );
  ensure(input.phase === phase && canonical(input.dispatch) === canonical(dispatch));
  const prepared = await preparedRecovery(operationId, phase, executorSha, dispatch, options);
  const { admission, loaded, record, directory } = prepared;
  const receipt = {
    version: 1,
    kind: "platform-installed-executor",
    executorSha,
    ci: loaded.receipt.ci,
    files: loaded.receipt.files,
  };
  validateBundle(input.bundle, receipt);
  const selected = input.bundle.selection;
  const original = admission.identity.admission;
  ensure(
    selected.operationId === operationId &&
      selected.sourceSha === original.manifest.sourceSha &&
      selected.workflowRunId === original.publisher.runId &&
      selected.workflowRunAttempt === original.publisher.runAttempt &&
      selected.artifactId === original.artifact.id,
  );
  await withHostState(record.operation.root, async () => {
    await preparedRecovery(operationId, phase, executorSha, dispatch, options);
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
export async function executeRecoveryHost(
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
  await verifyRecoveryDispatch(dispatch, tokenBytes.toString(), options.request);
  const { directory, record, loaded } = await preparedRecovery(
    operationId,
    phase,
    executorSha,
    dispatch,
    options,
  );
  const delivery = JSON.parse(await readPrivateFile(directory, "delivery.json"));
  ensure(
    delivery.phase === phase &&
      delivery.executorSha === executorSha &&
      delivery.operationId === operationId &&
      canonical(delivery.dispatch) === canonical(dispatch),
  );
  // Permanent deterministic fence survives success, failure, token deletion and
  // unknown process outcome. Never retry or remove it automatically.
  await withHostState(record.operation.root, async () => {
    await preparedRecovery(operationId, phase, executorSha, dispatch, options);
    await loaded.verifySources();
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
      join(record.installedRoot, "deploy/platform/recovery-transport.mjs"),
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
  recoveryOutcome({ ...result, exitCode: 0 }, phase);
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
          `${HOST_ROOT}/recovery-bootstrap/${executorSha}/deploy/platform/recovery-transport.mjs`,
      );
      if (mode === "host-command") {
        const { directory, admission } = await preparedRecovery(
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
        await verifyRecoveryDispatch(dispatch, token);
        const ci = await fetchPlatformCi(
          { repository: REPOSITORY, sourceSha: executorSha, runId: admission.executorCi.runId },
          token,
        );
        ensure(ci.identity.ciRunAttempt === admission.executorCi.runAttempt);
        // The internal CLI also consumes its own deterministic capability, so
        // invoking that entrypoint again cannot bypass the receiver fence.
        await withHostState(`${HOST_ROOT}/state`, async () => {
          await preparedRecovery(operationId, phase, executorSha, dispatch);
          await writePrivateFile(
            directory,
            "command-started.json",
            Buffer.from(JSON.stringify(fence)),
          );
        });
        const outcome = await runRecoveryHostCommand([phase, directory]);
        ensure(
          outcome.phase === phase &&
            outcome.status === (phase === "prepare" ? "backup-verified" : "healthy"),
        );
        process.stdout.write(phaseOutput(phase));
      } else {
        const input = await readInput(mode === "receive" ? 1048576 : 16384);
        process.stdout.write(
          mode === "receive"
            ? await receiveRecoveryBundle(operationId, phase, executorSha, dispatch, input)
            : await executeRecoveryHost(operationId, phase, executorSha, dispatch, input),
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
      workDirectory = await realpath(await mkdtemp(join(tmpdir(), "platform-recovery-transport-")));
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
      "Platform recovery delivery failed; preserve host state and reconcile before retry.\n",
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

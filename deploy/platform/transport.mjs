import { chmod, lstat, mkdtemp, readFile, realpath, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOST_BUNDLE_FILES } from "./host/command.mjs";
import { runHostProcess } from "./host/process.mjs";
import {
  assertPrivateRootSync,
  assertPrivateFileSync,
  assertBindFileSync,
  createPrivateDirectory,
  readPrivateFile,
  writePrivateFile,
  syncPrivateDirectory,
} from "./host/files.mjs";
import { withHostState } from "./host/state.mjs";
import { validateIdentity } from "./host/state-validation.mjs";
import { digest } from "./backup/schemas.mjs";
import { canonicalId, exactKeys, validSelection } from "./release-admission.mjs";
import { fetchPlatformCi } from "./release-ci.mjs";
import { githubTransport, REPOSITORY } from "./admission-github.mjs";
import { admitPlatformRelease } from "./admit-release.mjs";

const HOST_ROOT = "/opt/markiro-platform";
const CLEAN_ENV = Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C" });
const HEALTHY = "Platform host deployment healthy.\n";
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
export function sshArguments(target, phase, operationId) {
  ensure(exactKeys(target, ["host", "port", "user", "identityFile", "knownHostsFile"]));
  ensure(
    matches(target.host, /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u) &&
      !target.host.includes(".."),
  );
  ensure(matches(target.user, /^[a-z_][a-z0-9_-]{0,31}$/u));
  ensure(canonicalId(target.port) && Number(target.port) <= 65535);
  ensure(pathSafe(target.identityFile) && pathSafe(target.knownHostsFile));
  ensure(["receive", "execute"].includes(phase) && matches(operationId, UUID));
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
    `exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent LANG=C /usr/bin/node ${HOST_ROOT}/bootstrap/deploy/platform/transport.mjs ${phase} ${operationId}`,
  ];
}
export function hostOutcome(result) {
  ensure(result.stdout.toString() === HEALTHY && result.stderr.length === 0);
  return "healthy";
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

/** Hash actual checkout bytes AND immutable Git blobs; caller hashes are never provenance. */
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
  ensure((await git(["rev-parse", "HEAD"])).toString().trim() === selection.executorSha);
  ensure((await git(["status", "--porcelain", "--untracked-files=normal"])).length === 0);
  const files = {};
  const hashes = {};
  for (const path of HOST_BUNDLE_FILES) {
    const full = join(checkoutRoot, path);
    const info = await lstat(full);
    ensure(
      info.isFile() &&
        info.nlink === 1 &&
        info.size <= 1024 * 1024 &&
        (await realpath(full)) === full,
    );
    const bytes = await readFile(full);
    const immutable = await git(["show", `${selection.executorSha}:${path}`]);
    ensure(bytes.equals(immutable));
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
  { selection, target, token, githubActor, checkoutRoot, workDirectory },
  options = {},
) {
  let ownedDockerConfig;
  let failed = false;
  try {
    ensure(matches(githubActor, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u));
    validateTransportSelection(selection);
    sshArguments(target, "receive", selection.operationId);
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
    const { bundle } = await buildSourceBundle(selection, checkoutRoot, workDirectory, {
      runProcess: run,
    });
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
    const invoke = (phase, input) =>
      run({
        ...processOptions(workDirectory),
        timeoutMs: phase === "execute" ? 3000000 : 120000,
        executable: "/usr/bin/ssh",
        args: sshArguments(target, phase, selection.operationId),
        input,
      });
    const received = await invoke("receive", Buffer.from(JSON.stringify(bundle)));
    ensure(received.stdout.toString() === RECEIVED && received.stderr.length === 0);
    hostOutcome(await invoke("execute", Buffer.from(token)));
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

async function preparedOperation(operationId, root) {
  ensure(matches(operationId, UUID));
  assertPrivateRootSync(root);
  for (const name of ["state", "operations", "bundles"]) assertPrivateRootSync(join(root, name));
  const directory = join(root, "operations", operationId);
  const record = JSON.parse(await readPrivateFile(directory, "operation.json"));
  ensure(
    exactKeys(record, ["version", "kind", "installedRoot", "deployment", "observationPolicy"]),
  );
  ensure(record.version === 1 && record.kind === "platform-host-operation");
  validateIdentity(record.deployment.identity);
  ensure(
    record.deployment.identity.operationId === operationId &&
      record.deployment.root === join(root, "state") &&
      record.installedRoot === join(root, "bundles", operationId),
  );
  const receipt = JSON.parse(
    await readPrivateFile(record.deployment.root, "installed-executor.json"),
  );
  validateReceipt(receipt);
  ensure(receipt.executorSha === record.deployment.identity.executorSha);
  return { directory, record, receipt };
}
function bindSelection(selection, identity) {
  const a = identity.admission;
  ensure(
    selection.operationId === identity.operationId &&
      selection.executorSha === identity.executorSha &&
      selection.sourceSha === a.manifest.sourceSha &&
      selection.workflowRunId === a.publisher.runId &&
      selection.workflowRunAttempt === a.publisher.runAttempt &&
      selection.artifactId === a.artifact.id,
  );
}
/** Fixed independently provisioned receiver. It never writes receipt or operation JSON. */
export async function receiveBundle(operationId, bytes, options = {}) {
  const root = options.hostRoot ?? HOST_ROOT;
  ensure(Buffer.isBuffer(bytes) && bytes.length <= 1024 * 1024);
  const bundle = JSON.parse(bytes.toString("utf8"));
  // Canonical sender encoding rejects duplicate keys and other ambiguous representations.
  ensure(JSON.stringify(bundle) === bytes.toString("utf8"));
  const { record, receipt } = await preparedOperation(operationId, root);
  const files = validateBundle(bundle, receipt);
  bindSelection(bundle.selection, record.deployment.identity);
  await withHostState(record.deployment.root, async (store) => {
    const state = await store.read();
    ensure(
      state.current === null ||
        (state.current.phase === "healthy" &&
          state.current.status === "completed" &&
          state.current.identity.operationId !== operationId),
    );
    // Exclusive root prevents overwrite/retry even after a partial transfer.
    await createPrivateDirectory(join(root, "bundles"), operationId);
    for (const [path, data] of Object.entries(files)) {
      const parts = dirname(path).split("/");
      let parent = record.installedRoot;
      for (const part of parts) {
        await createPrivateDirectory(parent, part, { exclusive: false });
        parent = join(parent, part);
      }
      await writePrivateFile(record.installedRoot, path, data);
      if (path === "deploy/platform/postgres/pg_hba.conf")
        await chmod(join(record.installedRoot, path), 0o644);
    }
  });
  return RECEIVED;
}
/** Every failure retains token and bundle. Null failure flags never permit cleanup. */
export async function executeHost(operationId, tokenBytes, options = {}) {
  const root = options.hostRoot ?? HOST_ROOT;
  const { directory, record, receipt } = await preparedOperation(operationId, root);
  // Verify the loader itself before Node can evaluate any transferred code.
  for (const path of HOST_BUNDLE_FILES) {
    let bytes;
    if (path === "deploy/platform/postgres/pg_hba.conf") {
      const full = join(record.installedRoot, path);
      assertBindFileSync(full);
      const info = await lstat(full);
      ensure([0, process.getuid()].includes(info.uid) && (info.mode & 0o7777) === 0o644);
      bytes = await readFile(full);
    } else bytes = await readPrivateFile(record.installedRoot, path);
    ensure(digest(bytes) === receipt.files[path]);
  }
  ensure(
    Buffer.isBuffer(tokenBytes) &&
      tokenBytes.length > 0 &&
      tokenBytes.length <= 16384 &&
      !/\s/u.test(tokenBytes.toString("utf8")),
  );
  // Durable exclusive token also blocks repeated execute after uncertain transport loss.
  await writePrivateFile(directory, "github-token", tokenBytes);
  const run = options.runProcess ?? runHostProcess;
  const result = await run({
    ...processOptions(directory),
    timeoutMs: 2940000,
    executable: "/usr/bin/node",
    args: [join(record.installedRoot, "deploy/platform/host/command.mjs"), directory],
  });
  hostOutcome(result); // runner confirmed host CLI process-group exit, CLI confirms healthy.
  await unlink(join(directory, "github-token"));
  await syncPrivateDirectory(directory);
  return HEALTHY;
}
async function readInput(limit) {
  const chunks = [];
  let count = 0;
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
    if (mode === "receive" || mode === "execute") {
      ensure(args.length === 1);
      // The fixed bootstrap path must be the actual executed module.
      ensure(
        fileURLToPath(import.meta.url) === `${HOST_ROOT}/bootstrap/deploy/platform/transport.mjs`,
      );
      const input = await readInput(mode === "receive" ? 1024 * 1024 : 16384);
      process.stdout.write(
        mode === "receive"
          ? await receiveBundle(args[0], input)
          : await executeHost(args[0], input),
      );
    } else {
      ensure(mode === "run" && args.length === 0);
      const values = (await readInput(65536)).toString("utf8").split("\0");
      ensure(values.length === 16 && values.pop() === "");
      const [host, port, user, privateKey, knownHosts, token, githubActor, ...selected] = values;
      const selection = Object.fromEntries(
        SELECTION_KEYS.map((key, index) => [key, selected[index]]),
      );
      workDirectory = await realpath(await mkdtemp(join(tmpdir(), "platform-transport-")));
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
        checkoutRoot: await realpath(process.cwd()),
        workDirectory,
      });
      process.stdout.write(HEALTHY);
    }
  } catch {
    process.stderr.write(
      "Platform transport failed; preserve host operation and reconcile before retry.\n",
    );
    process.exitCode = 1;
  } finally {
    // Local credentials only; remote inputs remain on every failure.
    if (workDirectory)
      await rm(workDirectory, { recursive: true, force: true, maxRetries: 0 }).catch(() => {
        process.stderr.write(
          "Platform local credential cleanup failed; reconcile private runner files.\n",
        );
        process.exitCode = 1;
      });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cli();

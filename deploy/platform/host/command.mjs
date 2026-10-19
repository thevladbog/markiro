import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rm, readFile, lstat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { canonical, digest, ensure, keys, plain } from "../backup/schemas.mjs";
import {
  assertPrivateRootSync,
  assertBindFileSync,
  createPrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from "./files.mjs";
import { fingerprintHostConfiguration, hostChildEnvironment } from "./config.mjs";
import { validateIdentity } from "./state-validation.mjs";
import { readVerifiedBackup } from "./backup-gate.mjs";
import { executePreparedDeployment } from "./deploy.mjs";
import { runHostProcess } from "./process.mjs";
import {
  createHostObservers,
  createCleanupObserver,
  validateObservationPolicy,
  observerProducer,
  guarded,
} from "./observe.mjs";
import { observePostgresAdmin, runPostgresProbe } from "./probe.mjs";
import {
  githubTransport,
  fetchPublisher,
  recheckPublisher,
  validateArtifact,
  REPOSITORY,
} from "../admission-github.mjs";
import { fetchPlatformCi } from "../release-ci.mjs";
import { validatePublishedPlatformRelease } from "../release-admission.mjs";

export const HOST_BUNDLE_FILES = Object.freeze([
  "deploy/platform/host/command.mjs",
  "deploy/platform/host/observe.mjs",
  "deploy/platform/host/probe.mjs",
  "deploy/platform/host/probe-worker.mjs",
  "deploy/platform/host/deploy.mjs",
  "deploy/platform/host/config.mjs",
  "deploy/platform/host/files.mjs",
  "deploy/platform/host/process.mjs",
  "deploy/platform/host/prepared-target.mjs",
  "deploy/platform/host/backup-gate.mjs",
  "deploy/platform/host/state.mjs",
  "deploy/platform/host/state-validation.mjs",
  "deploy/platform/backup/schemas.mjs",
  "deploy/platform/backup/files.mjs",
  "deploy/platform/backup/restore.mjs",
  "deploy/platform/backup/local-runtime.mjs",
  "deploy/platform/backup/inventory.mjs",
  "deploy/platform/backup/definitions.mjs",
  "deploy/platform/postgres/roles.mjs",
  "deploy/platform/postgres/pg_hba.conf",
  "deploy/platform/compose.yml",
  "deploy/platform/compose.compact.yml",
  "deploy/platform/preflight.mjs",
  "deploy/platform/release-manifest.mjs",
  "deploy/platform/release-evidence.mjs",
  "deploy/platform/release-admission.mjs",
  "deploy/platform/release-ci.mjs",
  "deploy/platform/admission-github.mjs",
  "deploy/platform/admission-archive.py",
  "deploy/production/release-manifest.mjs",
  "deploy/production/cli-main.mjs",
]);
const installedRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/u, "");
const same = (a, b) => ensure(canonical(a) === canonical(b));
const deploymentKeys = [
  "root",
  "identity",
  "configuration",
  "dockerConfig",
  "preparedTarget",
  "preparedPolicy",
];
function commandError(error) {
  const result = new Error("Platform host command failed.");
  result.code = "ERR_HOST_COMMAND";
  if (error?.terminationConfirmed === false) result.terminationConfirmed = false;
  if (error?.recoveryRequired === true) result.recoveryRequired = true;
  if (error?.durabilityUncertain === true) result.durabilityUncertain = true;
  return result;
}
export async function loadHostOperation(directory, options = {}) {
  try {
    assertPrivateRootSync(directory);
    const record = JSON.parse(await readPrivateFile(directory, "operation.json"));
    keys(record, ["version", "kind", "installedRoot", "deployment", "observationPolicy"]);
    ensure(
      record.version === 1 &&
        record.kind === "platform-host-operation" &&
        record.installedRoot === (options.installedRoot ?? installedRoot),
    );
    assertPrivateRootSync(record.installedRoot);
    const op = record.deployment;
    keys(op, deploymentKeys);
    validateIdentity(op.identity);
    assertPrivateRootSync(op.root);
    assertPrivateRootSync(op.dockerConfig);
    keys(op.configuration, ["candidateId", "runtimeSnapshot", "migrationSnapshot"]);
    keys(op.preparedPolicy, [
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
    ensure(
      op.preparedPolicy.provenance === "live-source" &&
        op.preparedTarget.provenance === "live-source",
    );
    record.observationPolicy = validateObservationPolicy(record.observationPolicy);
    ensure(
      op.identity.target.hostId === record.observationPolicy.machineId &&
        op.identity.target.volumeId === record.observationPolicy.volume.name &&
        /^[1-9][0-9]{0,19}$/u.test(op.identity.target.databaseId),
    );
    const receipt = JSON.parse(await readPrivateFile(op.root, "installed-executor.json"));
    keys(receipt, ["version", "kind", "executorSha", "ci", "files"]);
    ensure(
      receipt.version === 1 &&
        receipt.kind === "platform-installed-executor" &&
        receipt.executorSha === op.identity.executorSha,
    );
    keys(receipt.ci, ["runId", "runAttempt"]);
    for (const value of Object.values(receipt.ci))
      ensure(
        typeof value === "string" &&
          /^[1-9][0-9]*$/u.test(value) &&
          Number.isSafeInteger(Number(value)),
      );
    keys(receipt.files, HOST_BUNDLE_FILES);
    for (const value of Object.values(receipt.files))
      ensure(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
    const verifySources = async () => {
      same(JSON.parse(await readPrivateFile(op.root, "installed-executor.json")), receipt);
      for (const path of HOST_BUNDLE_FILES) {
        let bytes;
        if (path === "deploy/platform/postgres/pg_hba.conf") {
          const file = join(record.installedRoot, path);
          assertBindFileSync(file);
          const info = await lstat(file);
          ensure([0, process.getuid()].includes(info.uid) && (info.mode & 0o7777) === 0o644);
          bytes = await readFile(file);
          assertBindFileSync(file);
        } else bytes = await readPrivateFile(record.installedRoot, path);
        ensure(digest(bytes) === receipt.files[path]);
      }
    };
    await verifySources();
    ensure(
      (await fingerprintHostConfiguration({ root: op.root, ...op.configuration }))
        .configurationSha256 === op.identity.configurationSha256,
    );
    hostChildEnvironment({
      interpolation: {
        ...op.configuration.runtimeSnapshot.interpolation,
        MARKIRO_PLATFORM_MIGRATION_ENV_FILE: op.configuration.migrationSnapshot.path,
      },
      dockerConfig: op.dockerConfig,
      ambient: options.ambient ?? process.env,
    });
    const verified = await readVerifiedBackup({
      root: op.root,
      identity: op.identity,
      ...op.preparedPolicy,
    });
    return {
      operationDirectory: directory,
      record: plain(record),
      receipt: plain(receipt),
      verified,
      verifySources,
    };
  } catch (error) {
    throw commandError(error);
  }
}

async function verifyAdmission(loaded, runProcess, request) {
  const { record, receipt } = loaded,
    op = record.deployment,
    admission = op.identity.admission;
  const token = String(await readPrivateFile(loaded.operationDirectory, "github-token")).trim();
  ensure(token && !/\s/u.test(token));
  const transport = githubTransport(token, request);
  const expected = {
    sourceSha: admission.manifest.sourceSha,
    workflowRunId: admission.publisher.runId,
    workflowRunAttempt: admission.publisher.runAttempt,
  };
  const publisher = await fetchPublisher(expected, transport);
  const artifact = validateArtifact(
    await transport.json(`/artifacts/${admission.artifact.id}`),
    publisher,
    admission.artifact.id,
  );
  ensure(artifact.sha256 === admission.artifact.sha256);
  const archive = await transport.download(admission.artifact.id);
  ensure(archive.length === artifact.size && digest(archive) === artifact.sha256);
  const name = `release-check-${randomUUID()}`;
  await createPrivateDirectory(op.root, name);
  const temp = join(op.root, name);
  let terminated = true;
  try {
    await writePrivateFile(temp, "release.zip", archive);
    const result = await runProcess({
      executable: "/usr/bin/python3",
      args: [
        "-I",
        join(record.installedRoot, "deploy/platform/admission-archive.py"),
        join(temp, "release.zip"),
      ],
      cwd: op.root,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      timeoutMs: 30000,
      outputLimitBytes: 1048576,
    });
    const texts = JSON.parse(result.stdout);
    keys(texts, ["platform-manifest.json", "release-evidence.json"]);
    const actual = validatePublishedPlatformRelease({
      manifestText: texts["platform-manifest.json"],
      evidenceText: texts["release-evidence.json"],
      expected,
    });
    same(actual.manifest, admission.manifest);
    same(actual.verified, admission.verified);
    for (const [sha, ci] of [
      [admission.manifest.sourceSha, admission.ci],
      [receipt.executorSha, receipt.ci],
    ]) {
      const current = await fetchPlatformCi(
        { repository: REPOSITORY, sourceSha: sha, runId: ci.runId },
        token,
        transport.ciRequest,
      );
      ensure(
        current.identity.ciRunAttempt === ci.runAttempt && current.identity.ciRunId === ci.runId,
      );
    }
    await recheckPublisher(expected, publisher, transport);
  } catch (error) {
    terminated = error.terminationConfirmed !== false;
    throw error;
  } finally {
    if (terminated) await rm(temp, { recursive: true });
  }
}

function smokeRequest(host, path, sha, status, request = httpsRequest) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: 443,
        servername: host,
        path,
        method: "GET",
        headers: { Host: host },
        rejectUnauthorized: true,
        timeout: 10000,
      },
      (response) => {
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1048576) response.destroy(new Error("Smoke response too large."));
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            ensure(
              response.statusCode === status &&
                !response.headers.location &&
                response.headers["x-markiro-server-profile"] === "platform-only" &&
                response.headers["x-markiro-release-sha"] === sha,
            );
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("Smoke deadline exceeded.")), 15000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Smoke timeout.")));
    req.end();
  });
}

// Shared physical fence binding for host admission and target-local recovery copies.
export function hostFenceEnforcementSha256({ target, policy, hbaSha256 }) {
  return digest({
    version: 1,
    kind: "platform-docker-private-database-fence",
    target,
    dockerId: policy.dockerId,
    network: policy.networks.database,
    volume: policy.volume,
    postgresImageId: policy.postgresImageId,
    hbaSha256,
  });
}

export async function createHostAdapters(loaded, options = {}) {
  const { record, receipt, verified, verifySources } = loaded;
  const op = record.deployment,
    policy = record.observationPolicy;
  const runProcess = options.runProcess ?? runHostProcess;
  const observers = createHostObservers(op, policy, {
    runProcess,
    signal: options.signal,
    readMachineId: options.readMachineId,
  });
  const hbaSha256 = receipt.files["deploy/platform/postgres/pg_hba.conf"];
  const enforcementSha256 = hostFenceEnforcementSha256({
    target: op.identity.target,
    policy,
    hbaSha256,
  });
  ensure(op.preparedTarget.fence.enforcementSha256 === enforcementSha256);
  ensure(
    op.preparedPolicy.rolePolicySha256 === receipt.files["deploy/platform/postgres/roles.mjs"],
  );
  let admitted = false;
  const inspect = async (context) => {
    await verifySources();
    const state = await observers.inventory(context);
    const database = await observePostgresAdmin({
      context,
      state,
      command: observers.command,
      hbaSha256,
    });
    return { state, database };
  };
  const verifyMeasured = async (context) => {
    const result = await runPostgresProbe({
      context,
      policy,
      command: observers.command,
      workerPath: join(record.installedRoot, "deploy/platform/host/probe-worker.mjs"),
      verifySources,
    });
    same(result.tls, op.preparedTarget.observations.tls.value);
    same(
      {
        image: op.preparedPolicy.postgres.image,
        architecture: "amd64",
        os: "linux",
        uid: 70,
        gid: 70,
        postgresVersion: result.postgresVersion,
      },
      op.preparedTarget.observations.postgres.value,
    );
    await inspect(context);
  };
  return {
    ...observers,
    runProcess,
    ...(options.signal ? { signal: options.signal } : {}),
    verifyRelease: (context) =>
      guarded(async () => {
        await verifySources();
        await verifyAdmission(loaded, runProcess, options.request);
        admitted = true;
        await verifyMeasured(context);
      }),
    inspectTarget: (context) =>
      guarded(async () => {
        await inspect(context);
        return {
          target: plain(op.identity.target),
          project: "markiro-platform",
          serverProfile: "platform-only",
          uiProfile: "platform-only",
          os: "linux",
          architecture: "amd64",
        };
      }),
    writerFence: {
      producerId: observerProducer,
      executorSha: op.identity.executorSha,
      observe: (context) =>
        guarded(async () => {
          await inspect(context);
          if (admitted) await verifyMeasured(context);
          return {
            version: 1,
            kind: "platform-writer-fence",
            operationId: op.identity.operationId,
            target: plain(op.identity.target),
            ...op.preparedTarget.fence,
            enforcementSha256,
            boundary: context.boundary,
            observedAt: new Date().toISOString(),
            held: true,
            producerId: observerProducer,
            executorSha: op.identity.executorSha,
          };
        }),
    },
    workload: createCleanupObserver(
      op.identity,
      verified.evidence.cleanup.resources,
      observers.command,
    ),
    smoke: (context) =>
      guarded(async () => {
        const values = context.configuration.runtimeSnapshot.interpolation;
        for (const [host, path, status] of [
          [values.MARKIRO_LANDING_DOMAIN, "/", 200],
          [values.MARKIRO_SAAS_ADMIN_DOMAIN, "/login", 200],
          [values.MARKIRO_SAAS_ADMIN_DOMAIN, "/api/platform/tenants", 401],
          [values.MARKIRO_SAAS_ADMIN_DOMAIN, "/station/sync", 404],
          [values.MARKIRO_RETIRED_ADMIN_DOMAIN, "/api/auth/get-session", 410],
          [values.MARKIRO_RETIRED_KIOSK_DOMAIN, "/kiosk/sync", 410],
        ])
          await smokeRequest(
            host,
            path,
            context.identity.admission.manifest.sourceSha,
            status,
            options.httpsRequest,
          );
      }),
  };
}
export async function runHostCommand(args, options = {}) {
  try {
    ensure(Array.isArray(args) && args.length === 1 && typeof args[0] === "string");
    const loaded = await loadHostOperation(args[0], options);
    const adapters = await createHostAdapters(loaded, options);
    return await executePreparedDeployment(loaded.record.deployment, adapters);
  } catch (error) {
    throw commandError(error);
  }
}
/** Stable sanitized process-boundary protocol; null makes no termination claim. */
export async function runHostCommandCli(args, options = {}) {
  try {
    await runHostCommand(args, options);
    process.stdout.write("Platform host deployment healthy.\n");
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        version: 1,
        kind: "platform-host-command-failure",
        code: "ERR_HOST_COMMAND",
        terminationConfirmed: error.terminationConfirmed === false ? false : null,
        recoveryRequired: error.recoveryRequired === true,
        durabilityUncertain: error.durabilityUncertain === true,
      }) + "\n",
    );
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runHostCommandCli(process.argv.slice(2));

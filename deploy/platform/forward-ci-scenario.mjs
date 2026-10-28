/** Fixed synthetic scenario constructors, callable only by local rehearsal code. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { randomUUID, X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile, lstat, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { digest } from "./backup/schemas.mjs";
import { validateWorkerManifest, recoveryRoleMapping } from "./recovery-ci-helpers.mjs";
import { hashArchive } from "./backup/files.mjs";
import {
  stageForwardPredecessor,
  stageFailedActivationExecutor,
  stageFailedEdgeExecutor,
} from "./forward-ci-predecessor.mjs";
import { seedFailedForwardEdge } from "./forward-ci-failed-edge.mjs";
import { readFailedForwardEdgePredecessor } from "./host/forward-edge-successor-admission.mjs";
import { seedExpiredForwardActivation } from "./forward-ci-expired-activation.mjs";
import { readFailedForwardPredecessor } from "./host/forward-successor-admission.mjs";
import { readFailedForwardActivationPredecessor } from "./host/forward-activation-successor-admission.mjs";
import { loadUpgradeOperation, UPGRADE_BUNDLE_FILES } from "./host/upgrade-command.mjs";
import { extractProductMigrationProof } from "./host/forward-product.mjs";
import { observeForwardMigrationLedger } from "./host/forward-ledger.mjs";
import { withUpgradePhaseState } from "./host/upgrade-state.mjs";
import { forwardFixture, forwardDecision } from "./test/forward-fixture.mjs";
import { readFailedUpgradePredecessor } from "./host/forward-admission.mjs";
import {
  createForwardObservers,
  createForwardBaselineVerifier,
} from "./host/forward-observation.mjs";
import { executeForwardPreparation } from "./host/forward-preparation.mjs";
import { executeForwardActivation } from "./host/forward-activation.mjs";
import { createForwardActivationAdapters } from "./host/forward-activation-adapters.mjs";
import { captureForwardRetained } from "./host/forward-retained.mjs";
import { withHeldForwardState } from "./host/forward-state.mjs";
import { createHeldForwardBackup } from "./host/target-backup.mjs";
import { readVerifiedBackup } from "./host/backup-gate.mjs";
import { observerProducer } from "./host/observe.mjs";
import { measureActivationProjection } from "./host/command.mjs";
import { productionAuthorization } from "./test/production-activation-fixture.mjs";
import { stageRehearsalTree } from "./upgrade-ci.mjs";
import { rehearsalInspectPath } from "./rehearsal-inspect-channel.mjs";
import { readProtectedEnv } from "./preflight.mjs";
import { sanitizeHostFailure, hostFailureSites } from "./host/failure-diagnostic.mjs";
// Inclusive aggregate costs only. No arguments, paths, results or errors enter
// evidence. Transport includes its isolation guards; categories are not additive.
export function createForwardTiming() {
  const totals = { dockerMs: 0, isolationMs: 0, sourceMs: 0 };
  return Object.freeze({
    measure: async (category, action) => {
      assert.ok(Object.hasOwn(totals, category) && typeof action === "function");
      const started = performance.now();
      try {
        return await action();
      } finally {
        totals[category] += performance.now() - started;
      }
    },
    snapshot: () =>
      Object.fromEntries(Object.entries(totals).map(([key, ms]) => [key, Math.ceil(ms)])),
  });
}
// Start before constructing live activation proofs/projection; the returned
// stopwatch continues through application commands and owned failure cleanup.
export async function prepareTimedForwardActivation(build) {
  assert.equal(typeof build, "function");
  const started = performance.now();
  const inputs = await build();
  return Object.freeze({
    inputs,
    elapsedMs: () => Math.max(1, Math.ceil(performance.now() - started)),
  });
}
export const forwardActivationPhases = Object.freeze([
  "activation-admitted",
  "api-started",
  "edge-started",
  "healthy",
]);
export function forwardActivationFailure(error, operationId, record) {
  const own = (key) =>
    record && typeof record === "object"
      ? Object.getOwnPropertyDescriptor(record, key)?.value
      : undefined;
  const fallback = {
    operationId,
    phase: "activation-admitted",
    boundary: "validation",
    commandCategory: "validation",
  };
  try {
    assert.ok(forwardActivationPhases.includes(own("phase")));
    return sanitizeHostFailure(error, {
      operationId,
      phase: own("phase"),
      boundary: own("boundary"),
      commandCategory: own("commandCategory"),
    });
  } catch {
    return sanitizeHostFailure(error, fallback);
  }
}
export const forwardBackupStages = Object.freeze([
  "input-validation",
  "host-state",
  "private-inputs",
  "observer-setup",
  "entry-observation",
  "writer-fence",
  "archive-production",
  "isolated-restore",
  "post-restore-observation",
]);
export function forwardBackupFailure(error) {
  const stage =
    error && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "targetBackupStage")?.value
      : undefined;
  const safe = sanitizeHostFailure(error, {
    operationId: "11111111-1111-4111-8111-111111111111",
    phase: "backup-verified",
    boundary: "createBackup",
    commandCategory: "validation",
  });
  return {
    stage: forwardBackupStages.includes(stage) ? stage : "unclassified",
    code: safe.code,
    errorName: safe.errorName,
    exitStatus: safe.exitStatus,
    executable: safe.executable,
    terminationConfirmed: safe.terminationConfirmed,
    durabilityUncertain: safe.durabilityUncertain,
  };
}
export const forwardProduct = "6e32b3bf5970ed8793293bcc7e80aef342836e53";
const images = Object.freeze({
  api: {
    reference:
      "ghcr.io/thevladbog/markiro-api@sha256:ea87a7237c0753c067d7b8f115857d88c2b36fefa7c041c7029c182a41ae8629",
    id: "sha256:8ec59901e3ffca497555df96dff65e5262d3e70ca8056a14c86fb557253d1d4f",
  },
  edge: {
    reference:
      "ghcr.io/thevladbog/markiro-platform-edge@sha256:aa50359218764bfb534bf77937038eaea7c220ebea3655007391f7a6bd946efa",
    id: "sha256:ed5c7f000b8068906756749d4f0f62237117a75dc8b76a7aef068d3d943a8ad2",
  },
});
const put = async (path, value, mode = 0o600) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    Buffer.isBuffer(value)
      ? value
      : typeof value === "string"
        ? value
        : `${JSON.stringify(value)}\n`,
    { mode, flag: "wx" },
  );
};
/** DinD dynamically mounts /tmp; stage on the captured daemon volume so the
 * outer archive API and the live process namespace observe the same bytes. */
export async function loadForwardWorkerArchive({
  archivePath,
  sha256,
  containerId,
  outer,
  shell,
  nested,
  progress,
}) {
  progress("copy current ICU worker archive");
  await outer(["cp", archivePath, `${containerId}:/var/lib/docker/markiro-forward-worker.tar`], {
    timeout: 900000,
  });
  progress("verify copied ICU worker archive");
  const copied = await shell(["sha256sum", "/var/lib/docker/markiro-forward-worker.tar"]);
  assert.equal(copied.stdout.trim(), `${sha256}  /var/lib/docker/markiro-forward-worker.tar`);
  progress("load current ICU worker archive");
  await nested(["load", "--input", "/var/lib/docker/markiro-forward-worker.tar"], {
    timeout: 900000,
  });
}
async function stage(context) {
  const {
    parent,
    root,
    repository,
    command,
    nested,
    outer,
    containerId,
    shell,
    stdinOuter,
    inspect,
    progress,
  } = context;
  progress("verify current ICU worker source closure");
  assert.ok(
    process.env.RUNNER_TEMP && process.env.GITHUB_SHA,
    "Exact current ICU worker export is required",
  );
  const sha = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
  assert.equal(sha, process.env.GITHUB_SHA);
  const exportRoot = join(process.env.RUNNER_TEMP, "platform-recovery-image-icu");
  const manifest = validateWorkerManifest(
    JSON.parse(await readFile(join(exportRoot, "recovery-image.json"))),
    sha,
  );
  const expected = (
    await command("git", [
      "ls-tree",
      "-r",
      "--name-only",
      sha,
      "--",
      "deploy/platform/backup",
      "deploy/platform/host",
      "deploy/platform/postgres",
      "packages/db/migrations",
      "packages/db/src/runtime-migrate.ts",
    ])
  ).stdout
    .trim()
    .split("\n")
    .sort();
  assert.deepEqual(manifest.sources.files.map((file) => file.path).sort(), expected);
  for (const file of manifest.sources.files) {
    assert.match(file.path, /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u);
    assert.equal(
      file.path.split("/").some((part) => part === ".." || part === "."),
      false,
    );
    const bytes = await readFile(join(repository, file.path));
    assert.equal(digest(bytes), file.sha256);
    assert.deepEqual(
      bytes,
      (await command("git", ["show", `${sha}:${file.path}`], { encoding: "buffer" })).stdout,
    );
  }
  assert.equal(manifest.sources.generated.path, "packages/db/dist/runtime-migrate.js");
  assert.equal(
    digest(await readFile(join(repository, manifest.sources.generated.path))),
    manifest.sources.generated.sha256,
  );
  progress("verify current ICU worker archive");
  const archive = await hashArchive(exportRoot, join(exportRoot, "recovery-image.tar"));
  assert.equal(archive.sha256, manifest.archive.sha256);
  assert.equal(archive.bytes, manifest.archive.bytes);
  await loadForwardWorkerArchive({
    archivePath: join(exportRoot, "recovery-image.tar"),
    sha256: manifest.archive.sha256,
    containerId,
    outer,
    shell,
    nested,
    progress,
  });
  progress("verify current ICU worker image");
  const worker = await inspect("image", manifest.image.id);
  assert.equal(worker.Id, manifest.image.id);
  assert.equal(worker.Os, "linux");
  assert.equal(worker.Architecture, "amd64");
  assert.equal(worker.Config.User, "postgres");
  for (const [service, selected] of Object.entries(images)) {
    progress(service === "api" ? "stage accepted API image" : "stage accepted edge image");
    await nested(["pull", "--platform", "linux/amd64", selected.reference], { timeout: 900000 });
    const actual = await inspect("image", selected.reference);
    assert.equal(actual.Id, selected.id);
    assert.equal(actual.Os, "linux");
    assert.equal(actual.Architecture, "amd64");
    assert.ok(actual.RepoDigests.includes(selected.reference));
  }
  // Only declared source bytes enter the nested namespace, never host bind mounts.
  progress("stage current executor source closure");
  const current = join(parent, "current-sources");
  await mkdir(current, { mode: 0o700 });
  for (const path of UPGRADE_BUNDLE_FILES)
    await put(
      join(current, path),
      await readFile(join(repository, path)),
      path.endsWith("pg_hba.conf") ? 0o644 : 0o600,
    );
  await shell(["mkdir", "-p", repository]);
  const tar = (await command("tar", ["-C", current, "-cf", "-", "."], { encoding: "buffer" }))
    .stdout;
  await stdinOuter(
    ["exec", "-i", containerId, "tar", "--no-same-owner", "-xpf", "-", "-C", repository],
    tar,
  );
  for (const path of UPGRADE_BUNDLE_FILES) {
    const actual = (await shell(["sha256sum", join(repository, path)])).stdout;
    assert.equal(actual.slice(0, 64), digest(await readFile(join(repository, path))));
  }
  return {
    workerImage: manifest.image.id,
    priorForward: await stageForwardPredecessor({ parent, command }),
    failedActivation: await stageFailedActivationExecutor({ parent, command }),
    failedEdge: await stageFailedEdgeExecutor({ parent, command }),
    sourceSha: sha,
    root,
    sourceFiles: Object.fromEntries(
      await Promise.all(
        UPGRADE_BUNDLE_FILES.map(async (path) => [
          path,
          digest(await readFile(join(repository, path))),
        ]),
      ),
    ),
  };
}
export function createForwardScenario(mode) {
  assert.ok(["healthy", "replacement-failure"].includes(mode));
  const checks = {};
  return {
    kind: "synthetic-forward",
    checks,
    stage,
    values: () => ({
      MARKIRO_API_IMAGE_DIGEST: images.api.reference.split("@")[1],
      MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: images.edge.reference.split("@")[1],
      MARKIRO_SOURCE_SHA: forwardProduct,
      MARKIRO_TOOLING_SHA: forwardProduct,
    }),
    candidate: async (candidate) => {
      candidate.executorSha = "c".repeat(40); // synthetic failed predecessor executor, never production authorization
      const admission = candidate.admission;
      const old = admission.manifest.sourceSha;
      admission.manifest.sourceSha = forwardProduct;
      admission.manifest.toolingSha = forwardProduct;
      admission.verified.sourceSha = forwardProduct;
      admission.verified.toolingSha = forwardProduct;
      for (const service of ["api", "edge"]) {
        const selected = images[service];
        admission.manifest[service] = selected.reference;
        admission.registry[service] = {
          reference: selected.reference,
          imageId: selected.id,
          platform: "linux/amd64",
        };
        admission.verified.images[service].id = selected.id;
        admission.verified.images[service].tag = admission.verified.images[service].tag.replace(
          old,
          forwardProduct,
        );
      }
    },
    run: async (c) => runScenario(c, mode, checks),
  };
}
function runtimeInterpolation(configuration, values) {
  const names = [
    "MARKIRO_API_IMAGE_DIGEST",
    "MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST",
    "MARKIRO_SAAS_ADMIN_DOMAIN",
    "MARKIRO_LANDING_DOMAIN",
    "MARKIRO_RETIRED_ADMIN_DOMAIN",
    "MARKIRO_RETIRED_KIOSK_DOMAIN",
    "MARKIRO_RELEASES_DOMAIN",
    "MARKIRO_RELEASES_BUCKET",
    "MARKIRO_SOURCE_SHA",
    "S3_PUBLIC_ORIGIN",
    "ACME_EMAIL",
    "MARKIRO_POSTGRES_IMAGE_DIGEST",
    "MARKIRO_POSTGRES_CA_FILE",
    "MARKIRO_POSTGRES_SERVER_CERT_FILE",
    "MARKIRO_POSTGRES_SERVER_KEY_FILE",
    "MARKIRO_POSTGRES_PASSWORD_FILE",
  ];
  configuration.runtimeSnapshot.interpolation = {
    ...Object.fromEntries(names.map((name) => [name, values[name]])),
    MARKIRO_PLATFORM_ENV_FILE: configuration.runtimeSnapshot.path,
  };
}
// This is a compiled harness binding, not a caller-selectable bypass. Source
// bytes/environment remain fresh on every call; physical isolation belongs to
// createForwardRehearsalProcess on both sides of each actual Docker request.
export function forwardRehearsalDependencies(c, duration, timing = createForwardTiming()) {
  assert.equal(typeof c.verifySourceBytes, "function");
  return {
    ...c.deps,
    verifySources: async () => {
      duration.sourceVerifications++;
      await timing.measure("sourceMs", () => c.verifySourceBytes());
    },
  };
}
export function createForwardRehearsalProcess(c, trace = [], timing = createForwardTiming()) {
  const privatePath = (path) => {
    assert.equal(typeof path, "string");
    assert.ok(path.startsWith(`${c.root}/`));
    assert.ok(!path.split("/").includes(".."));
    return path;
  };
  const copyInput = async (path) => {
    const source = path.replace(/\/\.$/u, "");
    privatePath(source);
    const stat = await lstat(source);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.uid, process.getuid());
    if (stat.isDirectory()) {
      await c.shell(["mkdir", "-p", "-m", "700", source]);
      await c.shell(["chmod", "700", source]);
      await stageRehearsalTree(source, {
        // The regular-rootfs archive boundary is probed before staging. Keep
        // database dumps out of the control runner's 1 MiB stdin contract.
        copyDirectory: (directory) =>
          c.outer(["cp", `${directory}/.`, `${c.containerId}:${directory}`]),
        inspectDirectory: async (relative) => {
          const [mode, type] = (
            await c.shell(["stat", "-c", "%a:%F", join(source, relative)])
          ).stdout
            .trim()
            .split(":");
          return { mode: Number.parseInt(mode, 8), type };
        },
        inspectFile: async (relative) => {
          const p = join(source, relative);
          const sha = (await c.shell(["sha256sum", p])).stdout.slice(0, 64);
          const [mode, size] = (await c.shell(["stat", "-c", "%a:%s", p])).stdout.trim().split(":");
          return { sha256: sha, mode: Number.parseInt(mode, 8), size: Number(size) };
        },
      });
    } else {
      assert.equal(stat.isFile(), true);
      assert.equal(stat.nlink, 1);
      assert.equal(stat.mode & 0o777, 0o600);
      await c.shell(["mkdir", "-p", dirname(source)]);
      await c.outer(["cp", source, `${c.containerId}:${source}`]);
    }
  };
  return async (request, recheck) => {
    await timing.measure("isolationMs", () => c.verifyIsolation());
    for (const [path, sha] of Object.entries(c.forwardStage?.sourceFiles ?? {}))
      assert.equal(digest(await readFile(join(c.repository, path))), sha);
    assert.equal(request.executable, "/usr/bin/docker");
    assert.deepEqual(request.args.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
    const args = request.args.slice(2);
    assert.equal(request.env.DOCKER_CONFIG, join(c.root, "docker"));
    for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "NODE_OPTIONS", "NODE_PATH"])
      assert.equal(request.env[key], undefined);
    assert.equal(
      args.some((a) => ["--privileged", "--pid", "--ipc", "--publish", "-p"].includes(a)),
      false,
    );
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--network")
        assert.ok(
          ["none", "markiro-platform_database", c.policy?.networks.database.id].includes(
            args[i + 1],
          ),
        );
      if (args[i] !== "--mount") continue;
      const parts = Object.fromEntries(
        args[i + 1].split(",").map((part) => {
          const n = part.indexOf("=");
          return [n === -1 ? part : part.slice(0, n), n === -1 ? true : part.slice(n + 1)];
        }),
      );
      if (parts.type !== "bind") continue;
      const source = parts.source ?? parts.src;
      const worker = join(c.parent, "current-sources", "deploy/platform/host/probe-worker.mjs");
      const historical = [c.forwardStage?.failedActivation, c.forwardStage?.failedEdge]
        .filter(Boolean)
        .find(
          (executor) =>
            source === join(executor.installedRoot, "deploy/platform/host/probe-worker.mjs"),
        );
      const isWorker = source === worker || Boolean(historical);
      assert.ok(isWorker || (typeof source === "string" && source.startsWith(`${c.root}/`)));
      assert.equal(
        source.split("/").some((part) => part === ".."),
        false,
      );
      if (!isWorker) await copyInput(source);
      else if (historical) {
        await historical.verify();
        await c.shell(["mkdir", "-p", dirname(source)]);
        await c.outer(["cp", source, `${c.containerId}:${source}`]);
        const actual = (await c.shell(["sha256sum", source])).stdout.slice(0, 64);
        assert.equal(actual, digest(await readFile(source)));
        await historical.verify();
      } else
        assert.equal(
          digest(await readFile(source)),
          digest(await readFile(new URL("./host/probe-worker.mjs", import.meta.url))),
        );
      const st = await lstat(source);
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.isFile(), true);
      assert.equal(st.mode & 0o777, 0o600);
      await c.shell(["chown", `${st.uid}:${st.gid}`, source]);
    }
    trace.push([...args]);
    // Only the exact allowlisted reads use the owned Engine channel. Archive
    // bytes and ordered IDs are unchanged; info retains every server field.
    // Keep every logical freshness/source/recheck boundary; only reuse the wire.
    if (
      c.inspectChannel &&
      rehearsalInspectPath(args) &&
      request.input === undefined &&
      Object.keys(request.env).sort().join(",") === "DOCKER_CONFIG,LANG,PATH"
    ) {
      for (const value of Object.values(request.env)) {
        assert.equal(typeof value, "string");
        assert.equal(/[\r\n\0]/u.test(value), false);
      }
      recheck?.();
      const output = await c.inspectChannel.read({ ...request, args });
      await timing.measure("isolationMs", () => c.verifyIsolation());
      return output;
    }
    // Never pass generated credential values in an OS argv. Docker reads this
    // private local env-file and conveys the fixed child environment directly.
    const envFile = join(c.parent, `forward-child-env-${randomUUID()}`);
    await put(
      envFile,
      Object.entries(request.env)
        .map(([key, value]) => {
          assert.match(key, /^[A-Z_][A-Z0-9_]*$/u);
          assert.equal(/[\r\n\0]/u.test(value), false);
          return `${key}=${value}\n`;
        })
        .join(""),
    );
    if (args[0] === "cp" && args[2] !== "-" && !args[1].includes(":")) {
      if (args[1] === join(c.repository, "deploy/platform/host/probe-worker.mjs")) {
        assert.equal(
          digest(await readFile(args[1])),
          digest(await readFile(new URL("./host/probe-worker.mjs", import.meta.url))),
        );
      } else await copyInput(args[1]);
    }
    if (args[0] === "cp" && args[2] !== "-" && args[1].includes(":")) {
      const dest = privatePath(args[2]);
      const st = await lstat(dest).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (st) {
        assert.equal(st.isDirectory(), true);
        assert.equal((await readdir(dest)).length, 0);
        await c.shell(["mkdir", "-p", dest]);
      } else await c.shell(["mkdir", "-p", dirname(dest)]);
    }
    let output;
    const invocation = [
      "exec",
      ...(request.input ? ["-i"] : []),
      "--env-file",
      envFile,
      c.containerId,
      // The logical host PATH is forwarded unchanged; the pinned DinD image
      // installs its transport CLI outside some callers' restricted PATHs.
      "/usr/local/bin/docker",
      ...request.args,
    ];
    recheck?.();
    if (request.outputLimitBytes > 1048576) {
      assert.equal(request.outputLimitBytes, 16 * 1024 * 1024);
      assert.equal(args[0], "cp");
      assert.equal(args[2], "-");
      output = await c.outer(invocation, {
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        timeout: request.timeoutMs,
      });
    } else output = await c.stdinOuter(invocation, request.input, request.timeoutMs);
    if (args[0] === "cp" && args[2] !== "-" && args[1].includes(":")) {
      const dest = privatePath(args[2]);
      const st = await lstat(dest).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (st) {
        assert.equal(st.isDirectory(), true);
        assert.equal((await readdir(dest)).length, 0);
      }
      await c.outer(["cp", `${c.containerId}:${dest}${st ? "/." : ""}`, dest], { timeout: 120000 });
    }
    await timing.measure("isolationMs", () => c.verifyIsolation());
    return output;
  };
}
// Accept only our exact injected failure; earlier runtime errors must survive.
export async function expectSyntheticMigrationFailure(withState, action) {
  const expected = new Error("synthetic failure after actual migrations before API-up");
  let initiating;
  try {
    await withState(async (store) => {
      try {
        await action(store, expected);
      } catch (error) {
        initiating = error;
        throw error;
      }
    });
  } catch (error) {
    if (error?.durabilityUncertain !== false || error?.terminationConfirmed === false) throw error;
    if (initiating !== expected) throw initiating ?? error;
    return;
  }
  assert.fail("The synthetic migration failure was not reached.");
}
async function runScenario(c, mode, checks) {
  const {
    root,
    parent,
    repository,
    candidateOperation,
    candidate,
    identity,
    f,
    predecessorContainers,
    policy,
    oldOperation,
  } = c;
  const duration = {
    productProofMs: 0,
    prepareMs: 0,
    activationMs: 0,
    dockerCalls: 0,
    sourceVerifications: 0,
    activationDockerCalls: 0,
    activationSourceVerifications: 0,
    activationDockerTransportMs: 0,
    activationIsolationMs: 0,
    activationSourceVerificationMs: 0,
  };
  const timing = createForwardTiming();
  c.deps = forwardRehearsalDependencies(c, duration, timing);
  const trace = [],
    run = createForwardRehearsalProcess(c, trace, timing),
    runProcess = async (...args) => {
      duration.dockerCalls++;
      return timing.measure("dockerMs", () => run(...args));
    };
  await put(
    join(parent, "forward-retained-containers.json"),
    await Promise.all(Object.values(predecessorContainers).map((id) => c.inspect("container", id))),
  );
  const candidateValues = {
    ...c.values,
    MARKIRO_RELEASES_DOMAIN: "releases.localhost",
    MARKIRO_RELEASES_BUCKET: "synthetic-releases",
    ...createForwardScenario(mode).values(),
  };
  runtimeInterpolation(candidateOperation.configuration, candidateValues);
  const env = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    DOCKER_CONFIG: join(root, "docker"),
    COMPOSE_DISABLE_ENV_FILE: "1",
    ...candidateOperation.configuration.runtimeSnapshot.interpolation,
    MARKIRO_PLATFORM_MIGRATION_ENV_FILE: candidateOperation.configuration.migrationSnapshot.path,
  };
  const composeFiles = [
    join(repository, "deploy/platform/compose.yml"),
    join(repository, "deploy/platform/compose.compact.yml"),
  ];
  const journal = join(root, "upgrade-operations", candidate.operationId, "state.json");
  const beforeBytes = await readFile(journal),
    before = JSON.parse(beforeBytes);
  const failedDecision = {
    version: 1,
    kind: "platform-upgrade-phase",
    phase: "activate",
    identity: candidate,
    prior: { sequence: 6, sha256: digest(beforeBytes) },
    executorCi: f.input.executorCi,
    reviewedPlanSha256: f.input.reviewedPlanSha256,
    dispatch: { toolingSha: candidate.executorSha, runId: "987654333", runAttempt: "1" },
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
  };
  const authorization = {
    actorId: "11",
    actorLogin: "synthetic-actor",
    reviewerId: "12",
    reviewerLogin: "synthetic-reviewer",
    environmentId: "44",
  };
  const base = {
    version: 1,
    kind: "platform-upgrade-host-operation",
    installedRoot: join(parent, "upgrade-bootstrap", candidate.executorSha),
    authorization,
    observationPolicy: policy,
  };
  const operation = {
    root,
    dockerConfig: join(root, "docker"),
    admission: f.input,
    configuration: candidateOperation.configuration,
    predecessorContainers,
  };
  for (const phase of ["prepare", "activate"])
    await put(join(parent, "upgrade-operations", candidate.operationId, phase, "operation.json"), {
      ...base,
      phase,
      dispatch: phase === "prepare" ? f.input.dispatch : failedDecision.dispatch,
      operation: {
        ...operation,
        ...(phase === "prepare"
          ? {
              connectionFile: join(root, "historical-connection.json"),
              roleMapping: { version: 1, roles: [], allowedDeltas: [] },
            }
          : {
              decision: failedDecision,
              preparedTarget: {
                version: 2,
                provenance: "live-source",
                operationId: candidate.operationId,
                executorSha: candidate.executorSha,
                configurationSha256: candidate.configurationSha256,
                target: candidate.target,
                fence: before.preparation.fence,
              },
              preparedPolicy: { provenance: "live-source" },
            }),
      },
    });
  c.progress("apply candidate migrations once, then fail canonically before API-up");
  let migrations = 0;
  await expectSyntheticMigrationFailure(
    (callback) => withUpgradePhaseState(root, failedDecision, callback),
    async (store, expected) => {
      c.progress("complete synthetic activation admission");
      await store.complete("activation-admitted");
      c.progress("enter synthetic migration latch");
      await store.enter("migration-entered");
      migrations++;
      c.progress("execute exact candidate migrations");
      await runProcess({
        executable: "/usr/bin/docker",
        args: [
          "--host",
          "unix:///var/run/docker.sock",
          "compose",
          "--project-name",
          "markiro-platform",
          ...composeFiles.flatMap((file) => ["--file", file]),
          "run",
          "--rm",
          "--no-deps",
          "migrate",
        ],
        cwd: root,
        env,
        timeoutMs: 300000,
        outputLimitBytes: 65536,
      });
      c.progress("complete synthetic migration latch");
      await store.complete("migration-entered");
      await store.enter("migrated");
      await store.complete("migrated");
      await store.enter("api-started");
      throw expected;
    },
  );
  c.progress("verify exact failed synthetic migration state");
  const failedState = JSON.parse(await readFile(journal));
  assert.equal(failedState.sequence, 14);
  assert.equal(failedState.migrationEntered, true);
  assert.equal(failedState.phase, "api-started");
  assert.equal(failedState.status, "recovery-required");
  const forwardIdentity = {
    ...structuredClone(candidate),
    operationId: randomUUID(),
    executorSha: c.forwardStage.sourceSha,
  };
  const proofStarted = performance.now();
  const proof = await extractProductMigrationProof({
    root,
    identity: forwardIdentity,
    verifySources: c.deps.verifySources,
    runProcess,
  });
  duration.productProofMs = Math.max(1, Math.ceil(performance.now() - proofStarted));
  const ledger = await observeForwardMigrationLedger({
    postgresId: predecessorContainers.postgres,
    proof,
    root,
    runProcess,
  });
  const built = forwardFixture({
    root,
    upgrade: f,
    newIdentity: forwardIdentity,
    retainedIds: predecessorContainers,
    failedConfiguration: candidateOperation.configuration,
    candidateConfigurationSha256: candidate.configurationSha256,
  });
  let admission = built.input;
  admission.failed.hashes = Object.fromEntries(
    Object.entries(await readFailedUpgradePredecessor(root, candidate.operationId)).map(
      ([key, bytes]) => [key, digest(bytes)],
    ),
  );
  admission.baseline = {
    containers: predecessorContainers,
    schema: ledger.schema,
    productMigrationProofSha256: proof.proofSha256,
  };
  admission.expiresAt = new Date(Date.now() + 3600000).toISOString();
  const forwardOperation = { ...candidateOperation, identity: forwardIdentity };
  const descriptors = [
    ["backup-runtime.json", JSON.parse(f.predecessorBytes.original).current.identity.executorSha],
    [`recovery-backup-runtime-${identity.operationId}.json`, identity.executorSha],
    [`upgrade-backup-runtime-${candidate.operationId}.json`, candidate.executorSha],
    [`forward-backup-runtime-${forwardIdentity.operationId}.json`, forwardIdentity.executorSha],
  ];
  for (const [name, executorSha] of descriptors)
    await put(join(root, name), {
      version: 1,
      executorSha,
      dockerExecutable: "/usr/bin/docker",
      endpoint: "unix:///var/run/docker.sock",
      image: c.forwardStage.workerImage,
      provenance: "live-source",
    });
  const historical = new Map();
  for (const name of [
    "state.json",
    "recovery-state.json",
    "recovery-preparation.json",
    `recovery-activation-${identity.operationId}.json`,
    `upgrade-operations/${candidate.operationId}/state.json`,
  ])
    historical.set(name, await readFile(join(root, name)));
  const roles = JSON.parse(
    (
      await c.sql(
        "SELECT json_agg(row_to_json(r)) FROM (SELECT rolname AS name,rolsuper AS superuser,rolcreatedb AS createdb,rolcreaterole AS createrole,rolreplication AS replication,rolbypassrls AS bypassrls FROM pg_roles WHERE rolname !~ '^pg_') r;",
      )
    ).stdout,
  );
  const roleMapping = recoveryRoleMapping({ roles, objects: [] });
  await put(
    join(root, "forward-service.conf"),
    "[backup]\nhost=db.private\nport=5432\ndbname=markiro\nuser=postgres\nsslmode=verify-full\nsslrootcert=/input/ca.crt\n",
  );
  await put(join(root, "forward-pass"), `db.private:5432:markiro:postgres:${c.password}\n`);
  const connectionFile = join(root, "forward-connection.json");
  await put(connectionFile, {
    version: 1,
    kind: "platform-backup-connection",
    operationId: forwardIdentity.operationId,
    target: forwardIdentity.target,
    service: "backup",
    serviceFile: join(root, "forward-service.conf"),
    passFile: join(root, "forward-pass"),
    caFile: join(root, "pg/ca.crt"),
    network: policy.networks.database.name,
  });
  const hbaSha256 = digest(await readFile(join(parent, "postgres/pg_hba.conf")));
  const deps = { ...c.deps, runProcess, hbaSha256 };
  const authority = {
    oldOperation,
    candidateOperation: forwardOperation,
    retainedIds: predecessorContainers,
    baseline: admission.baseline,
    productMigrationProof: proof,
    policy,
  };
  let observers = createForwardObservers(authority, deps);
  // The prior phase executes its exact historical Git closure and owns its own
  // proof WeakSet; current bytes are never relabeled as that executor.
  const historicalExecutor = c.forwardStage.priorForward;
  await historicalExecutor.verify();
  const priorAdmission = structuredClone(admission);
  priorAdmission.identity = {
    ...structuredClone(forwardIdentity),
    operationId: randomUUID(),
    executorSha: historicalExecutor.executorSha,
  };
  priorAdmission.executorCi = { runId: "998101", runAttempt: "1" };
  priorAdmission.dispatch = {
    toolingSha: historicalExecutor.executorSha,
    runId: "998102",
    runAttempt: "1",
  };
  const priorProof = await historicalExecutor.product.extractProductMigrationProof({
    root,
    identity: priorAdmission.identity,
    verifySources: historicalExecutor.verify,
    runProcess,
  });
  assert.equal(priorProof.proofSha256, proof.proofSha256);
  const priorOperation = { ...forwardOperation, identity: priorAdmission.identity };
  const priorAuthority = {
    ...authority,
    candidateOperation: priorOperation,
    productMigrationProof: priorProof,
  };
  const priorObservers = historicalExecutor.observation.createForwardObservers(
    priorAuthority,
    deps,
  );
  const priorBaseline = historicalExecutor.observation.createForwardBaselineVerifier(
    priorAuthority,
    deps,
  );
  const priorDirectory = join(
    parent,
    "upgrade-operations",
    priorAdmission.identity.operationId,
    "post-migration-prepare",
  );
  await mkdir(priorDirectory, { recursive: true, mode: 0o700 });
  const historicalSources = {};
  // These two older authorities are explicitly synthetic namespace fixtures;
  // their generated source marker is never imported or used as an executor.
  for (const [kind, id, ci, dispatch, key] of [
    [
      "recovery",
      admission.originalPredecessor.identity,
      JSON.parse(built.originalPredecessorBytes.activationOperation).operation.activation.admission
        .executorCi,
      null,
      "recoveryReceiptSha256",
    ],
    [
      "upgrade",
      admission.failed.identity,
      f.input.executorCi,
      f.input.dispatch,
      "failedReceiptSha256",
    ],
  ]) {
    const marker = Buffer.from(`export const syntheticHistoricalExecutor = "${id.executorSha}";\n`),
      file = "deploy/platform/synthetic-history.mjs";
    await put(join(parent, `${kind}-bootstrap`, id.executorSha, file), marker);
    const receipt = {
      version: 1,
      kind: `platform-${kind}-installed-executor`,
      operationId: id.operationId,
      executorSha: id.executorSha,
      ci,
      installationDispatch: dispatch ?? { toolingSha: id.executorSha, runId: "1", runAttempt: "1" },
      files: { [file]: digest(marker) },
    };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    await put(join(root, `${kind}-installed-executor-${id.operationId}.json`), receiptBytes);
    historicalSources[key] = digest(receiptBytes);
  }
  const priorRecord = {
    version: 1,
    kind: "platform-forward-recovery-host-operation",
    phase: admission.phase,
    installedRoot: historicalExecutor.installedRoot,
    dispatch: priorAdmission.dispatch,
    authorization,
    historicalSources,
    observationPolicy: policy,
    operation: {
      root,
      dockerConfig: join(root, "docker"),
      admission: priorAdmission,
      configuration: forwardOperation.configuration,
      predecessorContainers,
      connectionFile,
      roleMapping,
    },
  };
  const priorReceipt = {
    version: 1,
    kind: "platform-upgrade-installed-executor",
    operationId: priorAdmission.identity.operationId,
    executorSha: historicalExecutor.executorSha,
    ci: priorAdmission.executorCi,
    installationDispatch: priorAdmission.dispatch,
    files: historicalExecutor.files,
  };
  await put(
    join(root, `upgrade-installed-executor-${priorAdmission.identity.operationId}.json`),
    priorReceipt,
  );
  await put(join(root, `forward-backup-runtime-${priorAdmission.identity.operationId}.json`), {
    version: 1,
    executorSha: historicalExecutor.executorSha,
    dockerExecutable: "/usr/bin/docker",
    endpoint: "unix:///var/run/docker.sock",
    image: c.forwardStage.workerImage,
    provenance: "live-source",
  });
  await put(join(priorDirectory, "operation.json"), priorRecord);
  await put(join(priorDirectory, "github-token"), "synthetic-rehearsal-token");
  await put(join(priorDirectory, "delivery.json"), {
    phase: admission.phase,
    dispatch: priorAdmission.dispatch,
    executorSha: historicalExecutor.executorSha,
    operationId: priorAdmission.identity.operationId,
    bundleSha256: digest(Buffer.from(JSON.stringify(priorRecord))),
  });
  for (const file of ["execution-fence.json", "command-started.json"])
    await put(join(priorDirectory, file), {
      version: 1,
      phase: admission.phase,
      executorSha: historicalExecutor.executorSha,
      operationId: priorAdmission.identity.operationId,
      dispatch: priorAdmission.dispatch,
    });
  c.progress("create exact failed pre-backup forward admission");
  await assert.rejects(
    historicalExecutor.preparation.executeForwardPreparation(
      { root, admission: priorAdmission, configuration: forwardOperation.configuration },
      {
        verifyAdmission: async () =>
          historicalExecutor.reads.withAdmissionReadStage("publisher", async (reject) =>
            reject("http", { status: 502 }),
          ),
        inspectSource: (_context, cap) => priorObservers.inspectSource(cap),
        inspectSchema: (_context, cap) => priorObservers.inspectSchema(cap),
        createBackup: () => assert.fail("prior admission must never reach backup"),
      },
      { productMigrationProof: priorProof, verifyBaseline: priorBaseline },
    ),
  );
  const priorBytes = await readFailedForwardPredecessor(root, priorAdmission.identity.operationId),
    priorState = JSON.parse(priorBytes.state),
    priorFailure = JSON.parse(priorBytes.failure);
  assert.equal(priorState.sequence, 2);
  assert.equal(priorState.status, "recovery-required");
  assert.equal(priorState.sourceRuntime, null);
  assert.equal(priorState.backup, null);
  assert.equal(priorState.preparation, null);
  assert.equal(priorFailure.admissionRead.stage, "publisher");
  assert.equal(priorFailure.admissionRead.status, 502);
  checks.preBackupPredecessor = true;
  admission.kind = "platform-forward-admission-successor";
  admission.priorForward = {
    identity: priorAdmission.identity,
    hashes: Object.fromEntries(
      Object.entries(priorBytes).map(([key, value]) => [key, digest(value)]),
    ),
  };
  const currentProof = proof;
  let activationHistory, edgeHistory;
  const failedActivationAdmission = {
    ...structuredClone(admission),
    identity: {
      ...structuredClone(admission.identity),
      operationId: randomUUID(),
      executorSha: c.forwardStage.failedActivation.executorSha,
    },
    executorCi: { runId: "998201", runAttempt: "1" },
    dispatch: {
      toolingSha: c.forwardStage.failedActivation.executorSha,
      runId: "998202",
      runAttempt: "1",
    },
  };
  const finalAdmission = structuredClone(admission);
  admission = failedActivationAdmission;
  await put(join(root, `forward-backup-runtime-${admission.identity.operationId}.json`), {
    version: 1,
    executorSha: admission.identity.executorSha,
    dockerExecutable: "/usr/bin/docker",
    endpoint: "unix:///var/run/docker.sock",
    image: c.forwardStage.workerImage,
    provenance: "live-source",
  });
  async function prepareGeneration(executor) {
    const forwardIdentity = admission.identity;
    const forwardOperation = { ...candidateOperation, identity: forwardIdentity };
    const selected = executor ?? {
      installedRoot: join(parent, "upgrade-bootstrap", forwardIdentity.executorSha),
      files: c.forwardStage.sourceFiles,
      verify: c.deps.verifySources,
      preparation: { executeForwardPreparation },
      backup: { createHeldForwardBackup },
      retained: { captureForwardRetained },
      command: { loadUpgradeOperation },
      observation: { createForwardObservers, createForwardBaselineVerifier },
    };
    const proof = executor
      ? await executor.product.extractProductMigrationProof({
          root,
          identity: forwardIdentity,
          verifySources: executor.verify,
          runProcess,
        })
      : currentProof;
    assert.equal(proof.proofSha256, currentProof.proofSha256);
    const authority = {
      oldOperation,
      candidateOperation: forwardOperation,
      retainedIds: admission.baseline.containers,
      baseline: admission.baseline,
      productMigrationProof: proof,
      policy,
    };
    const observers = selected.observation.createForwardObservers(authority, deps),
      verifyBaseline = selected.observation.createForwardBaselineVerifier(authority, deps);
    const connectionFile = join(root, `forward-connection-${forwardIdentity.operationId}.json`);
    await put(connectionFile, {
      ...JSON.parse(await readFile(join(root, "forward-connection.json"))),
      operationId: forwardIdentity.operationId,
    });
    const installedRoot = selected.installedRoot;
    if (!executor)
      for (const path of UPGRADE_BUNDLE_FILES)
        await put(
          join(installedRoot, path),
          await readFile(join(parent, "current-sources", path)),
          path.endsWith("pg_hba.conf") ? 0o644 : 0o600,
        );
    const successorRecord = {
      ...priorRecord,
      installedRoot,
      dispatch: admission.dispatch,
      historicalSources: {
        ...historicalSources,
        priorForwardReceiptSha256: admission.priorForward
          ? admission.priorForward.hashes.installedExecutor
          : JSON.parse(activationHistory.bytes.prepareOperation).historicalSources
              .priorForwardReceiptSha256,
        ...(admission.priorEdge
          ? {
              priorActivationReceiptSha256: JSON.parse(edgeHistory.bytes.prepareOperation)
                .historicalSources.priorActivationReceiptSha256,
              priorEdgeReceiptSha256: admission.priorEdge.hashes.installedExecutor,
            }
          : {}),
        ...(admission.priorActivation
          ? {
              priorActivationReceiptSha256: admission.priorActivation.hashes.installedExecutor,
            }
          : {}),
      },
      operation: {
        ...priorRecord.operation,
        admission,
        connectionFile,
        predecessorContainers: admission.baseline.containers,
      },
    };
    const successorReceipt = {
      version: 1,
      kind: "platform-upgrade-installed-executor",
      operationId: forwardIdentity.operationId,
      executorSha: forwardIdentity.executorSha,
      ci: admission.executorCi,
      installationDispatch: admission.dispatch,
      files: selected.files,
    };
    await put(
      join(root, `upgrade-installed-executor-${forwardIdentity.operationId}.json`),
      successorReceipt,
    );
    const options = { productMigrationProof: proof, verifyBaseline };
    const prepareDirectory = join(
      parent,
      "upgrade-operations",
      forwardIdentity.operationId,
      "post-migration-prepare",
    );
    await mkdir(prepareDirectory, { recursive: true, mode: 0o700 });
    await put(join(prepareDirectory, "operation.json"), successorRecord);
    const authenticated = await selected.command.loadUpgradeOperation(prepareDirectory, {
      hostRoot: parent,
      ambient: {},
    });
    await authenticated.verifySources();
    let backupResult;
    c.progress(
      "forward preparation performs actual source dump, isolated restore, cleanup and Linux index handoff",
    );
    const prepareStarted = performance.now();
    await selected.preparation.executeForwardPreparation(
      { root, admission, configuration: forwardOperation.configuration },
      {
        verifyAdmission: async (_context, cap) => {
          c.progress("forward preparation: verifyAdmission");
          await selected.retained.captureForwardRetained(
            { root, admission, postgresImageId: policy.postgresImageId, runProcess },
            cap,
          );
          return forwardIdentity;
        },
        inspectSource: (context, cap) => {
          if (context.boundary !== "recovery") c.progress("forward preparation: inspectSource");
          return observers.inspectSource(cap);
        },
        inspectSchema: (_context, cap) => {
          c.progress("forward preparation: inspectSchema");
          return observers.inspectSchema(cap);
        },
        createBackup: async (_context, cap, persistFailure) => {
          c.progress("forward preparation: createBackup");
          try {
            backupResult = await selected.backup.createHeldForwardBackup(
              {
                operation: forwardOperation,
                observationPolicy: policy,
                hbaPath: join(parent, "postgres/pg_hba.conf"),
                hbaSha256,
                connectionFile,
                roleMapping,
                verifySources: selected.verify,
              },
              cap,
              admission,
              { ...deps, productMigrationProof: proof, beforeFailureCleanup: persistFailure },
            );
          } catch (error) {
            const diagnostic = forwardBackupFailure(error);
            c.progress(`forward preparation backup: ${diagnostic.stage}`);
            process.stderr.write(`Rehearsal backup failure: ${JSON.stringify(diagnostic)}\n`);
            throw error;
          }
          return {
            backup: backupResult.backup,
            restoreEvidence: backupResult.restoreEvidence,
            fence: backupResult.fence,
          };
        },
      },
      options,
    );
    duration.prepareMs = Math.max(1, Math.ceil(performance.now() - prepareStarted));
    assert.ok(backupResult);
    await authenticated.verifySources();
    await historicalExecutor.verify();
    const immediateArchive = await readFile(
      join(
        root,
        "forward-recovery-operations",
        forwardIdentity.operationId,
        "predecessor-index.json",
      ),
    );
    const immediateBytes = edgeHistory?.bytes ?? activationHistory?.bytes ?? priorBytes;
    assert.deepEqual(immediateArchive, immediateBytes.index);
    const successorIntent = JSON.parse(
      await readFile(
        join(
          root,
          "forward-recovery-operations",
          forwardIdentity.operationId,
          "handoff-intent.json",
        ),
      ),
    );
    assert.equal(
      successorIntent.failedOperationId,
      edgeHistory
        ? edgeHistory.admission.identity.operationId
        : activationHistory
          ? failedActivationAdmission.identity.operationId
          : priorAdmission.identity.operationId,
    );
    assert.equal(successorIntent.expectedSha256, digest(immediateBytes.index));
    if (edgeHistory) checks.edgeSuccessor = true;
    else if (activationHistory) checks.activationSuccessor = true;
    else checks.directSuccessor = true;
    const verified = await readVerifiedBackup({
      root,
      identity: forwardIdentity,
      backup: backupResult.backup,
      restoreEvidence: backupResult.restoreEvidence,
    });
    assert.equal(verified.evidence.checks.length, 10);
    assert.equal(verified.evidence.cleanup.verified, true);
    const statePath = join(
        root,
        "forward-recovery-operations",
        forwardIdentity.operationId,
        "state.json",
      ),
      preparedState = JSON.parse(await readFile(statePath));
    assert.equal(preparedState.sequence, 6);
    assert.equal(preparedState.migrationEntered, true);
    const success = JSON.parse(
      await readFile(
        join(
          root,
          "forward-recovery-operations",
          forwardIdentity.operationId,
          "handoff-success.json",
        ),
      ),
    );
    assert.ok(success);
    for (const [path, bytes] of historical)
      assert.deepEqual(await readFile(join(root, path)), bytes);
    checks.migrationAppliedOnce = migrations === 1;
    assert.equal(ledger.schema.migrationCount, "202");
    checks.fullLedger = true;
    checks.realBackupRestore = true;
    checks.linuxHandoff = true;
    return {
      backupResult,
      verified,
      preparedState,
      statePath,
      options,
      authenticated,
      successorRecord,
      proof,
      verifyBaseline,
    };
  }
  const failedPrepared = await prepareGeneration(c.forwardStage.failedActivation);
  const failedInputs = await activationInputs(
    c,
    admission.identity,
    forwardOperation.configuration,
    failedPrepared.verified,
    failedPrepared.backupResult,
    roleMapping,
    runProcess,
  );
  c.progress("seed exact expired forward activation and preserve its owned artifacts");
  activationHistory = await seedExpiredForwardActivation({
    c,
    executor: c.forwardStage.failedActivation,
    admission,
    preparedState: failedPrepared.preparedState,
    prepareRecord: failedPrepared.successorRecord,
    ...failedInputs,
    proof: failedPrepared.proof,
    verifyBaseline: failedPrepared.verifyBaseline,
    runProcess,
  });
  admission = {
    ...finalAdmission,
    kind: "platform-forward-activation-successor",
    priorActivation: {
      identity: failedActivationAdmission.identity,
      hashes: Object.fromEntries(
        Object.entries(activationHistory.bytes).map(([key, bytes]) => [key, digest(bytes)]),
      ),
    },
    expiresAt: new Date(
      Math.min(
        Date.now() + 3600000,
        Date.parse(JSON.parse(activationHistory.bytes.beforeObservation).observedAt) + 3600000,
      ),
    ).toISOString(),
  };
  delete admission.priorForward;
  // Reproduce the actual later failure using its exact historical Git executor.
  // Only this disposable coordinator has a controlled legacy-expiry clock.
  const edgeAdmission = {
    ...structuredClone(admission),
    identity: {
      ...structuredClone(admission.identity),
      operationId: randomUUID(),
      executorSha: c.forwardStage.failedEdge.executorSha,
    },
    executorCi: { runId: "998301", runAttempt: "1" },
    dispatch: {
      toolingSha: c.forwardStage.failedEdge.executorSha,
      runId: "998302",
      runAttempt: "1",
    },
  };
  admission = edgeAdmission;
  await put(join(root, `forward-backup-runtime-${admission.identity.operationId}.json`), {
    version: 1,
    executorSha: admission.identity.executorSha,
    dockerExecutable: "/usr/bin/docker",
    endpoint: "unix:///var/run/docker.sock",
    image: c.forwardStage.workerImage,
    provenance: "live-source",
  });
  const edgePrepared = await prepareGeneration(c.forwardStage.failedEdge);
  edgeHistory = await seedFailedForwardEdge({
    c,
    executor: c.forwardStage.failedEdge,
    admission,
    ...edgePrepared,
    runProcess,
    deps,
    oldOperation,
    roleMapping,
    inputs: await activationInputs(
      c,
      admission.identity,
      forwardOperation.configuration,
      edgePrepared.verified,
      edgePrepared.backupResult,
      roleMapping,
      runProcess,
    ),
  });
  admission = {
    ...structuredClone(finalAdmission),
    version: 2,
    kind: "platform-forward-edge-successor",
    authority: "protected-dispatch-once",
    baseline: { ...structuredClone(finalAdmission.baseline), containers: edgeHistory.sourceIds },
    priorEdge: {
      identity: edgeAdmission.identity,
      originalContainers: predecessorContainers,
      hashes: Object.fromEntries(
        Object.entries(edgeHistory.bytes).map(([key, bytes]) => [key, digest(bytes)]),
      ),
    },
  };
  delete admission.expiresAt;
  delete admission.priorForward;
  observers = createForwardObservers(
    { ...authority, baseline: admission.baseline, retainedIds: edgeHistory.sourceIds },
    deps,
  );
  const { backupResult, verified, preparedState, statePath, options, authenticated } =
    await prepareGeneration();
  const decision = forwardDecision({ input: admission }, preparedState);
  decision.version = 2;
  decision.authority = "protected-dispatch-once";
  delete decision.expiresAt;
  const activationDirectory = join(
    parent,
    "upgrade-operations",
    forwardIdentity.operationId,
    "post-migration-activate",
  );
  await mkdir(activationDirectory, { recursive: true, mode: 0o700 });
  const activationCounts = {
    dockerCalls: duration.dockerCalls,
    sourceVerifications: duration.sourceVerifications,
  };
  const activationTiming = timing.snapshot();
  const activationWindow = await prepareTimedForwardActivation(() =>
    activationInputs(
      c,
      forwardIdentity,
      forwardOperation.configuration,
      verified,
      backupResult,
      roleMapping,
      runProcess,
    ),
  );
  const { preparedTarget, preparedPolicy } = activationWindow.inputs;
  preparedTarget.version = 3;
  const authorityValue = preparedTarget.observations.egress.value;
  authorityValue.authority = "protected-dispatch-once";
  authorityValue.sourceHold.authority = "protected-dispatch-once";
  delete authorityValue.expiresAt;
  delete authorityValue.sourceHold.expiresAt;
  const loaded = {
    operationDirectory: activationDirectory,
    receipt: {
      files: {
        "deploy/platform/postgres/pg_hba.conf": hbaSha256,
        "deploy/platform/postgres/roles.mjs": preparedPolicy.rolePolicySha256,
      },
    },
    record: {
      installedRoot: join(parent, "current-sources"),
      operation: {
        root,
        dockerConfig: join(root, "docker"),
        admission,
        decision,
        configuration: forwardOperation.configuration,
        predecessorContainers: edgeHistory.sourceIds,
        preparedTarget,
        preparedPolicy,
      },
      observationPolicy: policy,
    },
    verifySources: c.deps.verifySources,
  };
  const adapters = createForwardActivationAdapters(
    loaded,
    oldOperation,
    async (held) => {
      await held.verify();
      return forwardIdentity;
    },
    verified,
    { ...deps },
  );
  // A fault belongs only to this disposable namespace; no production envelope
  // accepts it. It fires after normal Compose replacement and actual health.
  let replacedApi;
  const start = async (request, recheck) => {
    const result = await runProcess(request, recheck);
    if (request.args.includes("up") && request.args.at(-1) === "api") {
      replacedApi = (await c.inspect("container", "markiro-platform-api-1")).Id;
      assert.notEqual(replacedApi, predecessorContainers.api);
      assert.notEqual(replacedApi, edgeHistory.sourceIds.api);
      assert.ok(request.args.includes("--force-recreate"));
      if (mode === "replacement-failure")
        throw Object.assign(Error("synthetic post-replacement failure"), {
          terminationConfirmed: true,
        });
    }
    return result;
  };
  const smoke = async () => {
    await actualSmoke(c, forwardProduct);
    checks.externalTls = true;
  };
  c.progress(`forward activation ${mode}, never a second migrator or old-ID start`);
  const activate = async () => {
    try {
      return await executeForwardActivation(
        {
          root,
          dockerConfig: join(root, "docker"),
          decision,
          configuration: forwardOperation.configuration,
          preparedTarget,
          preparedPolicy,
        },
        {
          ...adapters,
          runProcess: start,
          inspectCandidate: (_context, cap) => observers.inspectCandidate(cap),
          inspectSchema: (_context, cap) => observers.inspectSchema(cap),
          smoke: (_context, cap) =>
            withHeldForwardState(cap, async (held) => {
              await held.verify();
              await smoke();
              await held.verify();
            }),
        },
        options,
      );
    } catch (error) {
      let record;
      try {
        record = JSON.parse(await readFile(join(activationDirectory, "failure.json")));
      } catch {
        /* Missing private evidence still reports the fixed admission boundary. */
      }
      const diagnostic = forwardActivationFailure(error, forwardIdentity.operationId, record);
      c.progress(`forward activation failure: ${diagnostic.phase}`);
      process.stderr.write(
        `Rehearsal activation failure: ${JSON.stringify({ ...diagnostic, sites: hostFailureSites(error) })}\n`,
      );
      throw error;
    }
  };
  if (mode === "healthy") {
    await activate();
    const terminal = JSON.parse(await readFile(statePath));
    assert.equal(terminal.sequence, 14);
    assert.equal(terminal.phase, "healthy");
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.migrationEntered, true);
    checks.forwardHealthy = true;
  } else {
    await assert.rejects(activate());
    assert.ok(replacedApi);
    const stopped = await c.inspect("container", replacedApi);
    assert.equal(stopped.State.Running, false);
    const terminal = JSON.parse(await readFile(statePath));
    assert.equal(terminal.status, "recovery-required");
    const diagnostic = JSON.parse(await readFile(join(activationDirectory, "failure.json")));
    assert.equal(diagnostic.operationId, forwardIdentity.operationId);
    assert.equal(diagnostic.phase, "api-started");
    assert.equal(Object.hasOwn(diagnostic, "stdout"), false);
    assert.equal(Object.hasOwn(diagnostic, "stderr"), false);
    assert.equal(JSON.stringify(diagnostic).includes("synthetic post-replacement failure"), false);
    checks.replacementFailureCleanup = true;
  }
  duration.activationMs = activationWindow.elapsedMs();
  const completedTiming = timing.snapshot();
  duration.activationDockerTransportMs = completedTiming.dockerMs - activationTiming.dockerMs;
  duration.activationIsolationMs = completedTiming.isolationMs - activationTiming.isolationMs;
  duration.activationSourceVerificationMs = completedTiming.sourceMs - activationTiming.sourceMs;
  duration.activationDockerCalls = duration.dockerCalls - activationCounts.dockerCalls;
  duration.activationSourceVerifications =
    duration.sourceVerifications - activationCounts.sourceVerifications;
  assert.equal(
    (await c.inspect("container", "markiro-platform-postgres-1")).Id,
    predecessorContainers.postgres,
  );
  const finalLedger = await observeForwardMigrationLedger({
    postgresId: predecessorContainers.postgres,
    proof,
    root,
    runProcess,
  });
  assert.deepEqual(finalLedger.schema, ledger.schema);
  for (const [path, bytes] of historical) assert.deepEqual(await readFile(join(root, path)), bytes);
  assert.equal(trace.filter((args) => args.includes("migrate") && args.includes("run")).length, 1);
  assert.equal(
    trace.some(
      (args) =>
        args[0] === "start" && Object.values(predecessorContainers).some((id) => args.includes(id)),
    ),
    false,
  );
  assert.equal(
    trace.some(
      (args) =>
        ["stop", "rm"].includes(args[1]) &&
        Object.values(predecessorContainers).some((id) => args.includes(id)),
    ),
    false,
  );
  await authenticated.verifySources();
  const preservedPrior = await readFailedForwardPredecessor(
    root,
    priorAdmission.identity.operationId,
    {
      successorOperationId: failedActivationAdmission.identity.operationId,
      indexFromSuccessorArchive: true,
    },
  );
  for (const key of Object.keys(priorBytes)) assert.deepEqual(preservedPrior[key], priorBytes[key]);
  await historicalExecutor.verify();
  const preservedActivation = await readFailedForwardActivationPredecessor(
    root,
    failedActivationAdmission.identity.operationId,
    {
      successorOperationId: edgeAdmission.identity.operationId,
      indexFromSuccessorArchive: true,
    },
  );
  for (const key of Object.keys(activationHistory.bytes))
    assert.deepEqual(preservedActivation[key], activationHistory.bytes[key]);
  await c.forwardStage.failedActivation.verify();
  const preservedEdge = await readFailedForwardEdgePredecessor(
    root,
    edgeAdmission.identity.operationId,
    { successorOperationId: forwardIdentity.operationId, indexFromSuccessorArchive: true },
  );
  for (const key of Object.keys(edgeHistory.bytes))
    assert.deepEqual(preservedEdge[key], edgeHistory.bytes[key]);
  await c.forwardStage.failedEdge.verify();
  checks.preservedHistory = true;
  c.evidence.forward = {
    mode,
    failedActivationOperationId: failedActivationAdmission.identity.operationId,
    failedActivationStateSha256: digest(activationHistory.bytes.state),
    priorForwardOperationId: priorAdmission.identity.operationId,
    priorForwardStateSha256: digest(priorBytes.state),
    priorForwardIndexSha256: digest(priorBytes.index),
    admissionReadStage: priorFailure.admissionRead.stage,
    operationId: forwardIdentity.operationId,
    failedOperationId: candidate.operationId,
    productSha: forwardProduct,
    executorSha: forwardIdentity.executorSha,
    postgresId: predecessorContainers.postgres,
    schema: ledger.schema,
    productMigrationProofSha256: proof.proofSha256,
    archiveSha256: backupResult.backup.archiveSha256,
    restoreEvidenceSha256: backupResult.restoreEvidence.evidenceSha256,
    terminalSha256: digest(await readFile(statePath)),
    duration,
    checks: { ...checks, noOldStarts: true, noSecondMigrator: true },
  };
  checks.noOldStarts = true;
  checks.noSecondMigrator = true;
}
export async function activationInputs(
  c,
  identity,
  configuration,
  verified,
  result,
  roleMapping,
  runProcess,
) {
  const { document, evidence } = verified,
    at = new Date().toISOString();
  const certificate = new X509Certificate(await readFile(join(c.root, "pg/server.crt")));
  const runtime = await readProtectedEnv(configuration.runtimeSnapshot.path);
  const postgres = {
    // The prepared-target contract binds the registry digest, while the physical
    // observer independently pins Docker Config.Id through c.policy.
    image: runtime.MARKIRO_POSTGRES_IMAGE_DIGEST,
    architecture: "amd64",
    os: "linux",
    uid: 70,
    gid: 70,
  };
  const tls = { certificateSha256: digest(certificate.raw), san: "db.private" };
  const rolePolicySha256 = digest(
    await readFile(join(c.repository, "deploy/platform/postgres/roles.mjs")),
  );
  const values = {
    postgres: {
      ...postgres,
      postgresVersion: String((await c.sql("SHOW server_version;")).stdout).trim(),
    },
    tls: {
      ...tls,
      notBefore: new Date(certificate.validFrom).toISOString(),
      expiresAt: new Date(certificate.validTo).toISOString(),
    },
    rolePolicy: {
      policySha256: rolePolicySha256,
      configurationSha256: identity.configurationSha256,
    },
    restoredSnapshot: {
      snapshotId: document.snapshotId,
      archiveSha256: result.backup.archiveSha256,
      inventorySha256: result.backup.inventorySha256,
      restoreEvidenceSha256: result.restoreEvidence.evidenceSha256,
      roleMappingSha256: evidence.roleMappingSha256,
      restoredInventorySha256: evidence.restoredInventorySha256,
      workerImage: evidence.runtime.image,
      workerArchitecture: evidence.runtime.architecture,
    },
    egress: null,
    // Syntax-only synthetic attestations for isolated generated data. No external
    // key custody, Mac/S3 export or production approval is claimed by this harness.
    keyContinuity: {
      approved: true,
      actor: "synthetic-ci",
      reference: "generated-test-keys-only",
      keyManifestSha256: digest("synthetic-generated-keys-only"),
      decryptionVerified: true,
      signingContinuityVerified: true,
    },
    offHostRecovery: {
      approved: true,
      actor: "synthetic-ci",
      reference: "isolated-test-only",
      archiveSha256: result.backup.archiveSha256,
      recoveryTestReference: "actual-isolated-restore-synthetic-data",
      independentKeyAvailable: true,
    },
  };
  const producers = Object.fromEntries(
    Object.keys(values).map((name) => [
      name,
      ["egress", "keyContinuity", "offHostRecovery"].includes(name)
        ? "synthetic-ci-attestations"
        : observerProducer,
    ]),
  );
  const preparedTarget = {
    version: 2,
    kind: "platform-prepared-target",
    operationId: identity.operationId,
    target: identity.target,
    executorSha: identity.executorSha,
    provenance: "live-source",
    configurationSha256: identity.configurationSha256,
    fence: result.fence,
    observations: {},
  };
  const authorization = productionAuthorization(
    preparedTarget,
    { document, backup: result.backup, restoreEvidence: result.restoreEvidence },
    Date.parse(at),
  );
  // Construct this new synthetic admission within the existing one-hour hold.
  // Never renew it during execution or change production/30s freshness checks.
  values.egress = { ...authorization, expiresAt: authorization.sourceHold.expiresAt };
  values.egress.review.projection = await measureActivationProjection(
    { root: c.root, dockerConfig: join(c.root, "docker") },
    c.predecessorContainers.postgres,
    values.egress.review.asOf,
    runProcess,
  );
  values.egress.reviewSha256 = digest(values.egress.review);
  for (const [name, value] of Object.entries(values))
    preparedTarget.observations[name] = {
      kind: ["egress", "keyContinuity", "offHostRecovery"].includes(name)
        ? "operator-attestation"
        : "measured",
      producerId: producers[name],
      executorSha: identity.executorSha,
      operationId: identity.operationId,
      target: identity.target,
      fenceId: result.fence.fenceId,
      configurationSha256: identity.configurationSha256,
      snapshotId: document.snapshotId,
      observedAt: at,
      value,
    };
  c.evidence.differences.push(
    "Forward v2 key/offhost/operator attestations are synthetic test inputs; actual dump/restore/TLS/ledger/physical checks use isolated generated data and do not authorize production",
  );
  return {
    preparedTarget,
    preparedPolicy: {
      backup: result.backup,
      restoreEvidence: result.restoreEvidence,
      roleMapping,
      postgres,
      tls,
      rolePolicySha256,
      provenance: "live-source",
      maxAgeMs: 3600000,
      producers,
    },
  };
}
async function actualSmoke(c, sourceSha) {
  const edge = await c.inspect("container", "markiro-platform-edge-1"),
    api = await c.inspect("container", "markiro-platform-api-1"),
    address = edge.NetworkSettings.Networks["markiro-platform_default"].IPAddress;
  for (const [host, path, status] of [
    ["landing.localhost", "/", 200],
    ["saas-admin.localhost", "/login", 200],
    ["saas-admin.localhost", "/api/platform/tenants", 401],
    ["saas-admin.localhost", "/station/sync", 404],
    ["admin.localhost", "/api/auth/get-session", 410],
    ["kiosk.localhost", "/kiosk/sync", 410],
  ]) {
    const result = JSON.parse(
      (
        await c.stdinNested(
          ["exec", "-i", api.Id, "node", "-e", c.tlsScript],
          JSON.stringify({ address, host, path, ca: c.ca }),
        )
      ).stdout,
    );
    assert.equal(result.status, status);
    assert.equal(result.headers.location, undefined);
    assert.equal(result.headers["x-markiro-server-profile"], "platform-only");
    assert.equal(result.headers["x-markiro-release-sha"], sourceSha);
  }
}

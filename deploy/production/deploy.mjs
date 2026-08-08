import { spawn } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

import { isMainModule } from "./cli-main.mjs";
import { productionComposeArgs } from "./compose-files.mjs";
import { runPreflight } from "./preflight.mjs";
import { productionBaseUrls, runSmoke } from "./smoke.mjs";

const apiRepository = "ghcr.io/thevladbog/markiro-api";
const edgeRepository = "ghcr.io/thevladbog/markiro-edge";

const COMMAND_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 600_000;
const SERVICE_TIMEOUT_MS = 300_000;
const EDGE_READINESS_TIMEOUT_MS = 180_000;
const EDGE_READINESS_INTERVAL_MS = 2_000;
const TERMINATION_GRACE_MS = 1_000;
const SHA256 = "[0-9a-f]{64}";

function timeoutError(command, timeoutMs) {
  return new Error(`${command} timed out after ${timeoutMs}ms`);
}

function withDeadline(promise, command, timeoutMs) {
  if (timeoutMs === null) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError(command, timeoutMs)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function processRunner() {
  return {
    handlesDeadline: true,
    run(command, args, environment, timeoutMs) {
      return new Promise((resolve, reject) => {
        let timedOut = false;
        let killTimer;
        const child = spawn(command, args, {
          env: environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer =
          timeoutMs === null
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                killTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
              }, timeoutMs);
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", () => {
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          reject(timedOut ? timeoutError(command, timeoutMs) : new Error(`${command} failed`));
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          if (timedOut) reject(timeoutError(command, timeoutMs));
          else resolve({ code: code ?? 1, stdout, stderr });
        });
      });
    },
  };
}

async function probeEdgeTls({ url, headers, timeoutMs }) {
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", ...headers },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const status = response.status;
  await response.body?.cancel();
  return { status };
}

function edgeReadinessProbe(environment) {
  if (environment.MARKIRO_EDGE_MODE === "behind-alb")
    return {
      url: "http://127.0.0.1:8080/health/live",
      headers: { host: environment.MARKIRO_DOMAIN },
    };
  return {
    url: new URL("/health/live", productionBaseUrls(environment).admin).href,
    headers: undefined,
  };
}

async function latestHealthyRelease(directory) {
  return (await latestHealthyReleaseRecord(directory))?.tag ?? null;
}

function isFailedRelease(release, filename, metadata) {
  return (
    isStagedRelease(release, "failed") &&
    filename === stagedReleaseFileName(release, "failed") &&
    metadata.isFile() &&
    (metadata.mode & 0o777) === 0o600
  );
}

async function effectiveHealthyReleaseRecords(directory) {
  try {
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    const healthy = [];
    const failed = [];
    for (const file of files) {
      try {
        const path = join(directory, file);
        const release = JSON.parse(await readFile(path, "utf8"));
        const metadata = await stat(path);
        if (isHealthyRelease(release, file, metadata)) healthy.push(release);
        if (isFailedRelease(release, file, metadata)) failed.push(release);
      } catch {
        // A malformed local record cannot be used to select a rollback target.
      }
    }
    return healthy.filter(
      (candidate) =>
        !failed.some((terminal) => sameRelease({ ...terminal, state: "healthy" }, candidate)),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return [];
}

async function latestHealthyReleaseRecord(directory) {
  const candidates = await effectiveHealthyReleaseRecords(directory);
  candidates.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return candidates[0] ?? null;
}

async function healthyReleaseByTag(directory, tag) {
  try {
    const matches = (await effectiveHealthyReleaseRecords(directory)).filter(
      (release) => release.tag === tag,
    );
    if (matches.length !== 1) throw new Error("previous healthy release is unavailable");
    return matches[0];
  } catch (error) {
    if (error?.message === "previous healthy release is unavailable") throw error;
    throw new Error("previous healthy release is unavailable");
  }
}

function releaseFileName(createdAt, tag) {
  return `${createdAt.replace(/[:.]/g, "-")}-${tag}.json`;
}

function stagedReleaseFileName(release, state) {
  return `${release.createdAt.replace(/[:.]/g, "-")}-${release.tag}.${state}.json`;
}

export async function writeRelease(directory, release) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, releaseFileName(release.createdAt, release.tag));
  const temporaryPath = join(directory, `.${release.tag}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(release)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isDigestFor(repository, digest) {
  const prefix = `${repository}@sha256:`;
  return (
    typeof digest === "string" &&
    digest.startsWith(prefix) &&
    new RegExp(`^${SHA256}$`).test(digest.slice(prefix.length))
  );
}

function requireApprovedDigest(expected, output) {
  let repoDigests;
  try {
    repoDigests = JSON.parse(output);
  } catch {
    throw new Error("approved image digest is not present");
  }
  if (
    !Array.isArray(repoDigests) ||
    !repoDigests.every((value) => typeof value === "string") ||
    !repoDigests.includes(expected)
  )
    throw new Error("approved image digest is not present");
  return expected;
}

function isValidIsoDate(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isHealthyRelease(release, filename, metadata) {
  return (
    release &&
    release.state === "healthy" &&
    typeof release.tag === "string" &&
    /^[0-9a-f]{40}$/.test(release.tag) &&
    (release.previousTag === null || /^[0-9a-f]{40}$/.test(release.previousTag)) &&
    isDigestFor(apiRepository, release.apiDigest) &&
    isDigestFor(edgeRepository, release.edgeDigest) &&
    isValidIsoDate(release.createdAt) &&
    (filename === releaseFileName(release.createdAt, release.tag) ||
      filename === stagedReleaseFileName(release, "healthy")) &&
    metadata.isFile() &&
    (metadata.mode & 0o777) === 0o600
  );
}

function sameRelease(left, right) {
  return (
    left?.tag === right?.tag &&
    left?.previousTag === right?.previousTag &&
    left?.apiDigest === right?.apiDigest &&
    left?.edgeDigest === right?.edgeDigest &&
    left?.state === right?.state &&
    left?.createdAt === right?.createdAt
  );
}

function isStagedRelease(release, state) {
  return (
    release &&
    release.state === state &&
    typeof release.tag === "string" &&
    /^[0-9a-f]{40}$/.test(release.tag) &&
    (release.previousTag === null || /^[0-9a-f]{40}$/.test(release.previousTag)) &&
    isDigestFor(apiRepository, release.apiDigest) &&
    isDigestFor(edgeRepository, release.edgeDigest) &&
    isValidIsoDate(release.createdAt) &&
    Object.keys(release).sort().join(",") === "apiDigest,createdAt,edgeDigest,previousTag,state,tag"
  );
}

async function writeStagedRelease(directory, release, state) {
  if (!isStagedRelease(release, state)) throw new Error("release state transition rejected");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, stagedReleaseFileName(release, state));
  const temporaryPath = join(
    directory,
    `.${stagedReleaseFileName(release, state)}.${randomUUID()}`,
  );
  let file;
  let directoryHandle;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(release)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await link(temporaryPath, path);
    directoryHandle = await open(directory, "r");
    await directoryHandle.sync();
  } catch {
    throw new Error("release state transition rejected");
  } finally {
    await file?.close();
    await directoryHandle?.close();
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return release;
}

async function requirePendingRelease(directory, candidate, { allowHealthy = false } = {}) {
  if (!isStagedRelease(candidate, "pending")) throw new Error("release state transition rejected");
  try {
    const path = join(directory, stagedReleaseFileName(candidate, "pending"));
    const metadata = await stat(path);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      !sameRelease(candidate, persisted)
    )
      throw new Error("release state transition rejected");
    for (const terminal of ["healthy", "failed"])
      try {
        const terminalPath = join(directory, stagedReleaseFileName(candidate, terminal));
        const terminalMetadata = await stat(terminalPath);
        if (terminal === "healthy" && allowHealthy) {
          const terminalRelease = JSON.parse(await readFile(terminalPath, "utf8"));
          if (
            !terminalMetadata.isFile() ||
            (terminalMetadata.mode & 0o777) !== 0o600 ||
            !sameRelease({ ...candidate, state: "healthy" }, terminalRelease)
          )
            throw new Error("release state transition rejected");
          continue;
        }
        throw new Error("release state transition rejected");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    return persisted;
  } catch (error) {
    if (error?.message === "release state transition rejected") throw error;
    throw new Error("release state transition rejected");
  }
}

function commandError(command, result) {
  return new Error(`${command} failed with exit ${result.code}`);
}

async function runCommand(dependencies, command, args, environment, timeoutMs) {
  try {
    const result = dependencies.runner.run(command, args, environment, timeoutMs);
    return dependencies.runner.handlesDeadline
      ? await result
      : await withDeadline(result, command, timeoutMs);
  } catch (error) {
    if (timeoutMs !== null && error?.message === `${command} timed out after ${timeoutMs}ms`)
      throw error;
    throw new Error(`${command} failed`);
  }
}

async function mustRun(dependencies, command, args, environment, timeoutMs) {
  dependencies.log(command);
  const result = await runCommand(dependencies, command, args, environment, timeoutMs);
  if (result.code !== 0) throw commandError(command, result);
  return result;
}

function bestEffortLog(dependencies, message) {
  try {
    dependencies.log(message);
  } catch {
    // Failure reporting must not replace the deployment error being reported.
  }
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function waitForEdgeTls(dependencies, options) {
  const timeoutMs = positiveInteger(options.edgeReadinessTimeoutMs, EDGE_READINESS_TIMEOUT_MS);
  const intervalMs = positiveInteger(options.edgeReadinessIntervalMs, EDGE_READINESS_INTERVAL_MS);
  const maximumAttempts = positiveInteger(
    options.edgeReadinessAttempts,
    Math.ceil(timeoutMs / intervalMs) + 1,
  );
  const startedAt = dependencies.monotonicNow();
  const probe = edgeReadinessProbe(options.environment);
  let lastCause = "no successful response";

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const remaining = timeoutMs - (dependencies.monotonicNow() - startedAt);
    if (remaining <= 0) break;
    try {
      const probeTimeoutMs = Math.max(
        1,
        Math.floor(Math.min(dependencies.timeouts.command, remaining)),
      );
      const result = await withDeadline(
        dependencies.probeEdgeTls({
          url: probe.url,
          headers: probe.headers,
          timeoutMs: probeTimeoutMs,
        }),
        "edge/TLS probe",
        probeTimeoutMs,
      );
      if (result?.status === 200) return;
      lastCause = Number.isSafeInteger(result?.status)
        ? `HTTP ${result.status}`
        : "invalid HTTP status";
    } catch {
      lastCause = "connection or TLS error";
    }

    const remainingAfterProbe = timeoutMs - (dependencies.monotonicNow() - startedAt);
    if (remainingAfterProbe <= 0 || attempt + 1 >= maximumAttempts) break;
    const delay = Math.min(intervalMs, remainingAfterProbe);
    await withDeadline(dependencies.sleep(delay), "edge/TLS readiness", remainingAfterProbe);
  }

  throw new Error(`Edge/TLS readiness failed after ${timeoutMs}ms (last cause: ${lastCause})`);
}

async function waitForApi(dependencies, options, compose, environment) {
  const attempts = options.readinessAttempts ?? 30;
  const interval = options.readinessIntervalMs ?? 2_000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let ready = false;
    try {
      if (dependencies.isReady) ready = await dependencies.isReady();
      else {
        const check = await runCommand(
          dependencies,
          "docker",
          [...compose, "exec", "-T", "api", "node", "/opt/markiro/healthcheck.mjs"],
          environment,
          dependencies.timeouts.command,
        );
        dependencies.log("docker");
        ready = check.code === 0;
      }
    } catch {
      ready = false;
    }
    if (ready) return;
    if (attempt + 1 < attempts) await dependencies.sleep(interval);
  }
  throw new Error("API readiness failed");
}

function deploymentDependencies(options, supplied = {}) {
  return {
    runPreflight,
    runner: processRunner(),
    writeRelease,
    isReady: undefined,
    probeEdgeTls,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    monotonicNow: () => performance.now(),
    now: () => new Date(),
    log: (event) => console.log(event),
    timeouts: {
      command: options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
      pull: options.pullTimeoutMs ?? PULL_TIMEOUT_MS,
      service: options.serviceTimeoutMs ?? SERVICE_TIMEOUT_MS,
    },
    ...supplied,
  };
}

async function markPreparedReleaseFailed(releaseDirectory, candidate) {
  return writeStagedRelease(releaseDirectory, { ...candidate, state: "failed" }, "failed");
}

/**
 * Pull, migrate, and switch a digest-backed candidate, stopping after local API and edge readiness.
 */
export async function prepareRelease(options, supplied = {}) {
  const dependencies = deploymentDependencies(options, supplied);
  dependencies.log("preflight");
  const preflight = await dependencies.runPreflight(options.environment);
  const environment = {
    ...process.env,
    ...options.environment,
    MARKIRO_ENV_FILE: preflight.envFile,
  };
  const releaseDirectory = options.releaseDirectory || ".markiro-releases";
  const compose = productionComposeArgs(environment);
  const approvedApiImage = `${apiRepository}@${preflight.apiImageDigest}`;
  const approvedEdgeImage = `${edgeRepository}@${preflight.edgeImageDigest}`;
  let candidate;
  let switched = false;

  try {
    const effectiveHealthy = await effectiveHealthyReleaseRecords(releaseDirectory);
    const previous = effectiveHealthy.toSorted(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    )[0];
    if (effectiveHealthy.some((release) => release.tag === preflight.imageTag))
      throw new Error("requested release is already healthy");
    if (options.requireNoPreviousHealthy && previous)
      throw new Error("first deployment requires no previous healthy release");
    if (options.requirePreviousHealthy && !previous)
      throw new Error("previous healthy release is unavailable");
    await mustRun(
      dependencies,
      "docker",
      [...compose, "pull", "api", "edge"],
      environment,
      dependencies.timeouts.pull,
    );
    const api = await mustRun(
      dependencies,
      "docker",
      ["image", "inspect", "--format", "{{json .RepoDigests}}", approvedApiImage],
      environment,
      dependencies.timeouts.command,
    );
    const edge = await mustRun(
      dependencies,
      "docker",
      ["image", "inspect", "--format", "{{json .RepoDigests}}", approvedEdgeImage],
      environment,
      dependencies.timeouts.command,
    );
    candidate = {
      tag: preflight.imageTag,
      previousTag: previous?.tag ?? null,
      apiDigest: requireApprovedDigest(approvedApiImage, api.stdout.trim()),
      edgeDigest: requireApprovedDigest(approvedEdgeImage, edge.stdout.trim()),
      state: "pending",
      createdAt: dependencies.now().toISOString(),
    };
    await writeStagedRelease(releaseDirectory, candidate, "pending");
    dependencies.log("release pending");

    await mustRun(
      dependencies,
      "docker",
      [...compose, "run", "--rm", "migrate"],
      environment,
      null,
    );
    switched = true;
    await mustRun(
      dependencies,
      "docker",
      [...compose, "up", "-d", "--no-deps", "api"],
      environment,
      dependencies.timeouts.service,
    );
    await waitForApi(dependencies, options, compose, environment);
    await mustRun(
      dependencies,
      "docker",
      [...compose, "up", "-d", "--no-deps", "edge"],
      environment,
      dependencies.timeouts.service,
    );
    await waitForEdgeTls(dependencies, options);
    dependencies.log("release prepared");
    return candidate;
  } catch (error) {
    if (candidate) {
      try {
        if (switched)
          await rollbackPreparedRelease(
            { ...options, candidate, environment, releaseDirectory },
            dependencies,
          );
        else await markPreparedReleaseFailed(releaseDirectory, candidate);
      } catch (recoveryError) {
        bestEffortLog(dependencies, "prepared release recovery failed");
        if (switched)
          throw new AggregateError(
            [error, recoveryError],
            error instanceof Error ? error.message : "deployment failed",
            { cause: error },
          );
      }
    }
    throw error;
  }
}

/** Mark the exact persisted pending candidate healthy without replacing any record. */
export async function finalizePreparedRelease({ candidate, releaseDirectory }) {
  await requirePendingRelease(releaseDirectory, candidate);
  return writeStagedRelease(releaseDirectory, { ...candidate, state: "healthy" }, "healthy");
}

/** Restore the exact previous healthy digest pair without running migrations. */
export async function rollbackPreparedRelease(options, supplied = {}) {
  const dependencies = deploymentDependencies(options, supplied);
  const candidate = await requirePendingRelease(options.releaseDirectory, options.candidate, {
    allowHealthy: true,
  });
  if (!candidate.previousTag) {
    const environment = { ...process.env, ...options.environment };
    const compose = productionComposeArgs(environment);
    const recoveryErrors = [];
    let failed;
    try {
      await mustRun(
        dependencies,
        "docker",
        [...compose, "stop", "api", "edge"],
        environment,
        dependencies.timeouts.service,
      );
    } catch (error) {
      recoveryErrors.push(error);
    }
    try {
      failed = await markPreparedReleaseFailed(options.releaseDirectory, candidate);
    } catch (error) {
      recoveryErrors.push(error);
    }
    if (recoveryErrors.length)
      throw new AggregateError(recoveryErrors, "first deployment recovery failed");
    dependencies.log("first deployment stopped");
    return failed;
  }
  const previous = await healthyReleaseByTag(options.releaseDirectory, candidate.previousTag);
  const environment = {
    ...process.env,
    ...options.environment,
    MARKIRO_IMAGE_TAG: previous.tag,
    MARKIRO_API_IMAGE_DIGEST: previous.apiDigest.slice(`${apiRepository}@`.length),
    MARKIRO_EDGE_IMAGE_DIGEST: previous.edgeDigest.slice(`${edgeRepository}@`.length),
  };
  const compose = productionComposeArgs(environment);
  await mustRun(
    dependencies,
    "docker",
    [...compose, "pull", "api", "edge"],
    environment,
    dependencies.timeouts.pull,
  );
  await mustRun(
    dependencies,
    "docker",
    [...compose, "up", "-d", "--no-deps", "api"],
    environment,
    dependencies.timeouts.service,
  );
  await waitForApi(dependencies, options, compose, environment);
  await mustRun(
    dependencies,
    "docker",
    [...compose, "up", "-d", "--no-deps", "edge"],
    environment,
    dependencies.timeouts.service,
  );
  await waitForEdgeTls(dependencies, options);
  dependencies.log("release rolled back");
  return markPreparedReleaseFailed(options.releaseDirectory, candidate);
}

/**
 * @typedef {object} ReleaseRecord
 * @property {string} tag
 * @property {string | null} previousTag
 * @property {string} apiDigest
 * @property {string} edgeDigest
 * @property {"pending" | "healthy" | "failed"} state
 * @property {string} createdAt
 */

/**
 * @typedef {object} DeployOptions
 * @property {Record<string, string | undefined>} environment
 * @property {string=} releaseDirectory
 * @property {number=} readinessAttempts
 * @property {number=} readinessIntervalMs
 * @property {number=} commandTimeoutMs
 * @property {number=} pullTimeoutMs
 * @property {number=} serviceTimeoutMs
 * @property {number=} edgeReadinessAttempts
 * @property {number=} edgeReadinessIntervalMs
 * @property {number=} edgeReadinessTimeoutMs
 * @property {boolean=} requirePreviousHealthy
 * @property {boolean=} requireNoPreviousHealthy
 */

/**
 * Pull, migrate, and switch a release. This intentionally never rolls back.
 * @param {DeployOptions} options
 * @param {{runPreflight?: typeof runPreflight, runner?: ReturnType<typeof processRunner>, runSmoke?: typeof runSmoke, writeRelease?: typeof writeRelease, isReady?: () => Promise<boolean>, probeEdgeTls?: (options: {url: string, headers?: Record<string, string>, timeoutMs: number}) => Promise<{status: number}>, sleep?: (milliseconds: number) => Promise<void>, monotonicNow?: () => number, now?: () => Date, log?: (message: string) => void}=} supplied
 * @returns {Promise<ReleaseRecord>}
 */
export async function deployRelease(options, supplied = {}) {
  const dependencies = {
    runPreflight,
    runner: processRunner(),
    runSmoke,
    writeRelease,
    isReady: undefined,
    probeEdgeTls,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    monotonicNow: () => performance.now(),
    now: () => new Date(),
    log: (event) => console.log(event),
    timeouts: {
      command: options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
      pull: options.pullTimeoutMs ?? PULL_TIMEOUT_MS,
      service: options.serviceTimeoutMs ?? SERVICE_TIMEOUT_MS,
    },
    ...supplied,
  };
  dependencies.log("preflight");
  const preflight = await dependencies.runPreflight(options.environment);
  const environment = {
    ...process.env,
    ...options.environment,
    MARKIRO_ENV_FILE: preflight.envFile,
  };
  const releaseDirectory = options.releaseDirectory || ".markiro-releases";
  const compose = productionComposeArgs(environment);
  const tag = preflight.imageTag;
  const approvedApiImage = `${apiRepository}@${preflight.apiImageDigest}`;
  const approvedEdgeImage = `${edgeRepository}@${preflight.edgeImageDigest}`;
  let release;

  try {
    await mustRun(
      dependencies,
      "docker",
      [...compose, "pull", "api", "edge"],
      environment,
      dependencies.timeouts.pull,
    );
    const api = await mustRun(
      dependencies,
      "docker",
      ["image", "inspect", "--format", "{{json .RepoDigests}}", approvedApiImage],
      environment,
      dependencies.timeouts.command,
    );
    const edge = await mustRun(
      dependencies,
      "docker",
      ["image", "inspect", "--format", "{{json .RepoDigests}}", approvedEdgeImage],
      environment,
      dependencies.timeouts.command,
    );
    release = {
      tag,
      previousTag: await latestHealthyRelease(releaseDirectory),
      apiDigest: requireApprovedDigest(approvedApiImage, api.stdout.trim()),
      edgeDigest: requireApprovedDigest(approvedEdgeImage, edge.stdout.trim()),
      state: "pending",
      createdAt: dependencies.now().toISOString(),
    };
    await dependencies.writeRelease(releaseDirectory, release);
    dependencies.log("release pending");

    await mustRun(
      dependencies,
      "docker",
      [...compose, "run", "--rm", "migrate"],
      environment,
      // The migrator bounds connection, advisory-lock, and statement work at PostgreSQL.
      // Killing only the Compose client here could leave the transaction outcome unknown.
      null,
    );
    await mustRun(
      dependencies,
      "docker",
      [...compose, "up", "-d", "--no-deps", "api"],
      environment,
      dependencies.timeouts.service,
    );
    const attempts = options.readinessAttempts ?? 30;
    const interval = options.readinessIntervalMs ?? 2_000;
    let ready = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if (dependencies.isReady) ready = await dependencies.isReady();
        else {
          const check = await runCommand(
            dependencies,
            "docker",
            [...compose, "exec", "-T", "api", "node", "/opt/markiro/healthcheck.mjs"],
            environment,
            dependencies.timeouts.command,
          );
          dependencies.log("docker");
          ready = check.code === 0;
        }
      } catch {
        ready = false;
      }
      if (ready) break;
      if (attempt + 1 < attempts) await dependencies.sleep(interval);
    }
    if (!ready) throw new Error("API readiness failed");

    await mustRun(
      dependencies,
      "docker",
      [...compose, "up", "-d", "--no-deps", "edge"],
      environment,
      dependencies.timeouts.service,
    );
    const baseUrls = productionBaseUrls(environment);
    await waitForEdgeTls(dependencies, options);
    try {
      await dependencies.runSmoke({
        environment,
        adminBaseUrl: baseUrls.admin,
        kioskBaseUrl: baseUrls.kiosk,
        expectedReleaseSha: tag,
      });
    } catch {
      throw new Error("Public smoke failed");
    }
    release.state = "healthy";
    await dependencies.writeRelease(releaseDirectory, release);
    dependencies.log("release healthy");
    return release;
  } catch (error) {
    if (release) {
      release.state = "failed";
      try {
        await dependencies.writeRelease(releaseDirectory, release);
      } catch {
        bestEffortLog(dependencies, "failed release record write failed");
      }
      bestEffortLog(dependencies, "release failed");
    }
    throw error;
  }
}

async function candidateFromStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16 * 1024) throw new Error("release state transition rejected");
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new Error("release state transition rejected");
  }
}

function cliReleaseDirectory() {
  const directory = process.env.MARKIRO_RELEASE_DIRECTORY;
  if (!directory?.startsWith("/") || directory.includes("\0"))
    throw new Error("release state transition rejected");
  return directory;
}

if (isMainModule(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (mode === "prepare") {
      const candidate = await prepareRelease(
        {
          environment: process.env,
          releaseDirectory: cliReleaseDirectory(),
          requirePreviousHealthy: process.env.MARKIRO_REQUIRE_PREVIOUS_HEALTHY === "1",
          requireNoPreviousHealthy: process.env.MARKIRO_REQUIRE_NO_PREVIOUS_HEALTHY === "1",
        },
        { log: () => undefined },
      );
      process.stdout.write(`${JSON.stringify(candidate)}\n`);
    } else if (mode === "finalize") {
      const release = await finalizePreparedRelease({
        candidate: await candidateFromStdin(),
        releaseDirectory: cliReleaseDirectory(),
      });
      process.stdout.write(`${JSON.stringify(release)}\n`);
    } else if (mode === "rollback") {
      const release = await rollbackPreparedRelease(
        {
          candidate: await candidateFromStdin(),
          environment: process.env,
          releaseDirectory: cliReleaseDirectory(),
        },
        { log: () => undefined },
      );
      process.stdout.write(`${JSON.stringify(release)}\n`);
    } else await deployRelease({ environment: process.env });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

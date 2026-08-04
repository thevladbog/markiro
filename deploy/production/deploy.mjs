import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

import { runPreflight } from "./preflight.mjs";
import { runSmoke } from "./smoke.mjs";

const apiRepository = "ghcr.io/thevladbog/markiro-api";
const edgeRepository = "ghcr.io/thevladbog/markiro-edge";

function composeArgs(environment) {
  return [
    "compose",
    "--env-file",
    environment.MARKIRO_ENV_FILE || ".env.production",
    "-f",
    "compose.production.yml",
  ];
}

const COMMAND_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1_000;
const SHA256 = "[0-9a-f]{64}";

function timeoutError(command, timeoutMs) {
  return new Error(`${command} timed out after ${timeoutMs}ms`);
}

function withDeadline(promise, command, timeoutMs) {
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

function processRunner(timeoutMs) {
  return {
    handlesDeadline: true,
    run(command, args, environment) {
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
        const timer = setTimeout(() => {
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

async function latestHealthyRelease(directory) {
  try {
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    const candidates = [];
    for (const file of files) {
      try {
        const path = join(directory, file);
        const release = JSON.parse(await readFile(path, "utf8"));
        const metadata = await stat(path);
        if (isHealthyRelease(release, file, metadata)) candidates.push(release);
      } catch {
        // A malformed local record cannot be used to select a rollback target.
      }
    }
    candidates.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    return candidates[0]?.tag ?? null;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return null;
}

function releaseFileName(createdAt, tag) {
  return `${createdAt.replace(/[:.]/g, "-")}-${tag}.json`;
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

function requireDigest(repository, digest) {
  if (!isDigestFor(repository, digest)) throw new Error("image digest is invalid");
  return digest;
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
    filename === releaseFileName(release.createdAt, release.tag) &&
    metadata.isFile() &&
    (metadata.mode & 0o777) === 0o600
  );
}

function commandError(command, result) {
  return new Error(`${command} failed with exit ${result.code}`);
}

async function runCommand(dependencies, command, args, environment) {
  try {
    const result = dependencies.runner.run(command, args, environment);
    return dependencies.runner.handlesDeadline
      ? await result
      : await withDeadline(result, command, dependencies.commandTimeoutMs);
  } catch (error) {
    if (error?.message === `${command} timed out after ${dependencies.commandTimeoutMs}ms`)
      throw error;
    throw new Error(`${command} failed`);
  }
}

async function mustRun(dependencies, command, args, environment) {
  dependencies.log(command);
  const result = await runCommand(dependencies, command, args, environment);
  if (result.code !== 0) throw commandError(command, result);
  return result;
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
 */

/**
 * Pull, migrate, and switch a release. This intentionally never rolls back.
 * @param {DeployOptions} options
 * @param {{runPreflight?: typeof runPreflight, runner?: ReturnType<typeof processRunner>, runSmoke?: typeof runSmoke, writeRelease?: typeof writeRelease, isReady?: () => Promise<boolean>, sleep?: (milliseconds: number) => Promise<void>, now?: () => Date, log?: (message: string) => void}=} supplied
 * @returns {Promise<ReleaseRecord>}
 */
export async function deployRelease(options, supplied = {}) {
  const dependencies = {
    runPreflight,
    runner: processRunner(options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS),
    runSmoke,
    writeRelease,
    isReady: undefined,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => new Date(),
    log: (event) => console.log(event),
    commandTimeoutMs: options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
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
  const compose = composeArgs(environment);
  const tag = preflight.imageTag;
  let release;

  try {
    await mustRun(dependencies, "docker", [...compose, "pull", "api", "edge"], environment);
    const api = await mustRun(
      dependencies,
      "docker",
      ["image", "inspect", "--format", "{{index .RepoDigests 0}}", `${apiRepository}:${tag}`],
      environment,
    );
    const edge = await mustRun(
      dependencies,
      "docker",
      ["image", "inspect", "--format", "{{index .RepoDigests 0}}", `${edgeRepository}:${tag}`],
      environment,
    );
    release = {
      tag,
      previousTag: await latestHealthyRelease(releaseDirectory),
      apiDigest: requireDigest(apiRepository, api.stdout.trim()),
      edgeDigest: requireDigest(edgeRepository, edge.stdout.trim()),
      state: "pending",
      createdAt: dependencies.now().toISOString(),
    };
    await dependencies.writeRelease(releaseDirectory, release);
    dependencies.log("release pending");

    await mustRun(dependencies, "docker", [...compose, "run", "--rm", "migrate"], environment);
    await mustRun(
      dependencies,
      "docker",
      [...compose, "up", "-d", "--no-deps", "api"],
      environment,
    );
    const attempts = options.readinessAttempts ?? 30;
    const interval = options.readinessIntervalMs ?? 2_000;
    let ready = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (dependencies.isReady) ready = await dependencies.isReady();
      else {
        const check = await runCommand(
          dependencies,
          "docker",
          [...compose, "exec", "-T", "api", "node", "/opt/markiro/healthcheck.mjs"],
          environment,
        );
        dependencies.log("docker");
        ready = check.code === 0;
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
    );
    try {
      await dependencies.runSmoke({ environment, baseUrl: `https://${preflight.domain}` });
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
      await dependencies.writeRelease(releaseDirectory, release);
      dependencies.log("release failed");
    }
    throw error;
  }
}

if (import.meta.main) {
  try {
    await deployRelease({ environment: process.env });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

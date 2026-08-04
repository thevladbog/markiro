import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

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

function processRunner() {
  return {
    run(command, args, environment) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          env: environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });
    },
  };
}

async function latestHealthyRelease(directory) {
  try {
    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".json"))
      .sort()
      .reverse();
    for (const file of files) {
      try {
        const release = JSON.parse(await readFile(join(directory, file), "utf8"));
        if (release.state === "healthy" && typeof release.tag === "string") return release.tag;
      } catch {
        // A malformed local record cannot be used to select a rollback target.
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return null;
}

function releaseFileName(createdAt, tag) {
  return `${createdAt.replace(/[:.]/g, "-")}-${tag}.json`;
}

async function writeRelease(directory, release) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, releaseFileName(release.createdAt, release.tag));
  await writeFile(path, `${JSON.stringify(release)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function commandError(command, result) {
  return new Error(`${command} failed with exit ${result.code}`);
}

async function mustRun(dependencies, command, args, environment) {
  dependencies.log(command);
  const result = await dependencies.runner.run(command, args, environment);
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
 */

/**
 * Pull, migrate, and switch a release. This intentionally never rolls back.
 * @param {DeployOptions} options
 * @param {{runPreflight?: typeof runPreflight, runner?: ReturnType<typeof processRunner>, runSmoke?: typeof runSmoke, isReady?: () => Promise<boolean>, sleep?: (milliseconds: number) => Promise<void>, now?: () => Date, log?: (message: string) => void}=} supplied
 * @returns {Promise<ReleaseRecord>}
 */
export async function deployRelease(options, supplied = {}) {
  const dependencies = {
    runPreflight,
    runner: processRunner(),
    runSmoke,
    isReady: undefined,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => new Date(),
    log: () => undefined,
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
      apiDigest: api.stdout.trim(),
      edgeDigest: edge.stdout.trim(),
      state: "pending",
      createdAt: dependencies.now().toISOString(),
    };
    await writeRelease(releaseDirectory, release);
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
        const check = await dependencies.runner.run(
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
    await writeRelease(releaseDirectory, release);
    dependencies.log("release healthy");
    return release;
  } catch (error) {
    if (release) {
      release.state = "failed";
      await writeRelease(releaseDirectory, release);
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

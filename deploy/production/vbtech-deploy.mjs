import { spawn } from "node:child_process";
import { lstat, readFile, readdir, readlink, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, isAbsolute, resolve } from "node:path";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";
import { productionComposeArgs, PRODUCTION_COMPOSE_PROJECT } from "./compose-files.mjs";
import { runPrivateVbtechSmoke } from "./vbtech-private-smoke.mjs";
import {
  latestHealthyVbtechRelease,
  markVbtechReleaseFailed,
  markVbtechReleaseHealthy,
  validateVbtechSelector,
  writePendingVbtechRelease,
} from "./vbtech-release-state.mjs";

export const VBTECH_EXECUTOR_CONTRACT_VERSION = 1;

const DEFAULT_PATHS = Object.freeze({
  activeReleaseLink: "/opt/markiro/active-release",
  markiroReleaseDirectory: "/var/lib/markiro/releases",
  vbtechReleaseDirectory: "/var/lib/markiro/vbtech/releases",
  environmentFile: "/etc/markiro/production.env",
});
const API_REPOSITORY = "ghcr.io/thevladbog/markiro-api";
const EDGE_REPOSITORY = "ghcr.io/thevladbog/markiro-edge";
const VBTECH_REPOSITORY = "ghcr.io/thevladbog/vbtech-web";
const VBTECH_APEX_DOMAIN = "v-b.tech";
const VBTECH_WWW_DOMAIN = "www.v-b.tech";
const FIXED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const NETWORK_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const DOCKER_CONFIG_PATTERN =
  /^\/run\/markiro-registry-auth\/session-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 600_000;
const SERVICE_TIMEOUT_MS = 300_000;
const SERVICE_INTERVAL_MS = 2_000;
const EDGE_READINESS_TIMEOUT_MS = 180_000;
const EDGE_READINESS_INTERVAL_MS = 2_000;
const PRIVATE_SMOKE_TIMEOUT_MS = 180_000;
const STATE_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_ATTEMPTS = 2_000;

const DEPLOYMENT_STAGES = new Set([
  "configuration",
  "validation",
  "active-markiro",
  "vbtech-state",
  "pending",
  "pull",
  "candidate-digest",
  "candidate-service",
  "candidate-health",
  "edge-activation",
  "private-smoke",
  "healthy",
]);
const ROLLBACK_STAGES = new Set([
  "rollback-service",
  "rollback-health",
  "rollback-edge",
  "rollback-readiness",
  "rollback-smoke",
  "failed-record",
]);

class VbtechDeployStageError extends Error {
  constructor(stage, rollbackStage) {
    const safeStage = DEPLOYMENT_STAGES.has(stage) ? stage : "configuration";
    const safeRollbackStage = ROLLBACK_STAGES.has(rollbackStage) ? rollbackStage : undefined;
    super(
      safeRollbackStage === undefined
        ? `v-b deployment failed at ${safeStage}`
        : `v-b deployment failed at ${safeStage}; rollback failed at ${safeRollbackStage}`,
    );
    this.name = "VbtechDeployStageError";
    this.stage = safeStage;
    this.rollbackStage = safeRollbackStage;
  }
}

function timeoutPromise(promise, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error("bounded operation timed out")),
      timeoutMs,
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function processRunner() {
  return {
    run(command, args, environment, timeoutMs, { cwd, maxOutputBytes }) {
      return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, args, {
          cwd,
          env: environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout = [];
        const stderr = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let timedOut = false;
        let outputExceeded = false;
        let killTimer;

        const terminate = () => {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
        };
        const capture = (chunks, currentBytes, chunk) => {
          const nextBytes = currentBytes + chunk.length;
          if (nextBytes > maxOutputBytes) {
            if (!outputExceeded) {
              outputExceeded = true;
              terminate();
            }
          } else chunks.push(chunk);
          return nextBytes;
        };
        child.stdout.on("data", (chunk) => {
          stdoutBytes = capture(stdout, stdoutBytes, chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderrBytes = capture(stderr, stderrBytes, chunk);
        });
        const timer = setTimeout(() => {
          timedOut = true;
          terminate();
        }, timeoutMs);
        child.once("error", () => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          rejectPromise(new Error("bounded command failed"));
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          resolvePromise({
            code: timedOut || outputExceeded ? 1 : (code ?? 1),
            stdout: outputExceeded ? "" : Buffer.concat(stdout).toString("utf8"),
            stderr: outputExceeded ? "" : Buffer.concat(stderr).toString("utf8"),
          });
        });
      });
    },
  };
}

async function defaultProbeEdge({ transportOrigin, timeoutMs }) {
  const response = await fetch(new URL("/health/live", transportOrigin), {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const status = response.status;
  await response.body?.cancel();
  return { status };
}

function dependencies(supplied) {
  return {
    runner: processRunner(),
    lstat,
    readFile,
    readdir,
    readlink,
    stat,
    latestHealthyVbtechRelease,
    writePendingVbtechRelease,
    markVbtechReleaseHealthy,
    markVbtechReleaseFailed,
    runPrivateVbtechSmoke,
    probeEdge: defaultProbeEdge,
    sleep: (delay) => new Promise((resolveSleep) => setTimeout(resolveSleep, delay)),
    monotonicNow: () => performance.now(),
    event: () => undefined,
    ...supplied,
    paths: { ...DEFAULT_PATHS, ...supplied.paths },
  };
}

function hasExactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys
  );
}

function isCanonicalIsoDate(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function imageReference(repository, value) {
  const prefix = `${repository}@`;
  return (
    typeof value === "string" &&
    value.startsWith(prefix) &&
    DIGEST_PATTERN.test(value.slice(prefix.length))
  );
}

function digestFromReference(repository, value) {
  if (!imageReference(repository, value)) throw new Error("image reference is invalid");
  return value.slice(repository.length + 1);
}

function isCanonicalDomain(value) {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    value.length === 0 ||
    value !== value.toLowerCase() ||
    value.endsWith(".") ||
    isIP(value) !== 0
  )
    return false;
  const labels = value.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  );
}

function positiveBoundedInteger(value, fallback, maximum = MAX_TIMEOUT_MS) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    throw new Error("executor resource bound is invalid");
  return value;
}

function executorSettings(options) {
  const allowedKeys = new Set([
    "environment",
    "serviceHealthTimeoutMs",
    "serviceHealthIntervalMs",
    "serviceHealthAttempts",
    "edgeReadinessTimeoutMs",
    "edgeReadinessIntervalMs",
    "edgeReadinessAttempts",
    "privateSmokeTimeoutMs",
  ]);
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !allowedKeys.has(key))
  )
    throw new Error("executor options are invalid");
  const serviceHealthTimeoutMs = positiveBoundedInteger(
    options.serviceHealthTimeoutMs,
    SERVICE_TIMEOUT_MS,
  );
  const serviceHealthIntervalMs = positiveBoundedInteger(
    options.serviceHealthIntervalMs,
    SERVICE_INTERVAL_MS,
    serviceHealthTimeoutMs,
  );
  const edgeReadinessTimeoutMs = positiveBoundedInteger(
    options.edgeReadinessTimeoutMs,
    EDGE_READINESS_TIMEOUT_MS,
  );
  const edgeReadinessIntervalMs = positiveBoundedInteger(
    options.edgeReadinessIntervalMs,
    EDGE_READINESS_INTERVAL_MS,
    edgeReadinessTimeoutMs,
  );
  return {
    serviceHealthTimeoutMs,
    serviceHealthIntervalMs,
    serviceHealthAttempts: positiveBoundedInteger(
      options.serviceHealthAttempts,
      Math.ceil(serviceHealthTimeoutMs / serviceHealthIntervalMs) + 1,
      MAX_ATTEMPTS,
    ),
    edgeReadinessTimeoutMs,
    edgeReadinessIntervalMs,
    edgeReadinessAttempts: positiveBoundedInteger(
      options.edgeReadinessAttempts,
      Math.ceil(edgeReadinessTimeoutMs / edgeReadinessIntervalMs) + 1,
      MAX_ATTEMPTS,
    ),
    privateSmokeTimeoutMs: positiveBoundedInteger(
      options.privateSmokeTimeoutMs,
      PRIVATE_SMOKE_TIMEOUT_MS,
    ),
  };
}

function validatedInput(options, paths) {
  const settings = executorSettings(options);
  const environment = options.environment;
  if (!environment || typeof environment !== "object" || Array.isArray(environment))
    throw new Error("executor environment is invalid");
  if (
    environment.MARKIRO_COMPOSE_PROJECT !== PRODUCTION_COMPOSE_PROJECT ||
    environment.MARKIRO_ENV_FILE !== paths.environmentFile ||
    environment.VBTECH_DOMAIN !== VBTECH_APEX_DOMAIN ||
    environment.VBTECH_WWW_DOMAIN !== VBTECH_WWW_DOMAIN ||
    environment.VBTECH_SUBMISSION_STATE !== "disabled" ||
    environment.VBTECH_IMAGE_DIGEST === undefined ||
    environment.VBTECH_IMAGE_TAG !== undefined ||
    environment.VBTECH_FUNCTION_ORIGIN !== undefined ||
    (environment.VBTECH_FUNCTION_PATH !== undefined && environment.VBTECH_FUNCTION_PATH !== "") ||
    environment.MARKIRO_IMAGE_TAG !== undefined ||
    environment.MARKIRO_API_IMAGE_DIGEST !== undefined ||
    environment.MARKIRO_EDGE_IMAGE_DIGEST !== undefined
  )
    throw new Error("executor environment is invalid");
  const markiroDomains = [
    environment.MARKIRO_DOMAIN,
    environment.MARKIRO_KIOSK_DOMAIN,
    environment.MARKIRO_LANDING_DOMAIN,
  ];
  if (
    markiroDomains.some((domain) => !isCanonicalDomain(domain)) ||
    new Set(markiroDomains).size !== markiroDomains.length ||
    markiroDomains.includes(VBTECH_APEX_DOMAIN) ||
    markiroDomains.includes(VBTECH_WWW_DOMAIN)
  )
    throw new Error("executor domain is invalid");
  if (
    typeof environment.DOCKER_CONFIG !== "string" ||
    !isAbsolute(environment.DOCKER_CONFIG) ||
    !DOCKER_CONFIG_PATTERN.test(environment.DOCKER_CONFIG) ||
    environment.DOCKER_CONFIG.includes("\0")
  )
    throw new Error("Docker configuration is invalid");
  const selector = validateVbtechSelector({
    imageRef: environment.VBTECH_IMAGE_REF,
    imageDigest: environment.VBTECH_IMAGE_DIGEST,
    releaseSha: environment.VBTECH_RELEASE_SHA,
    functionPath: "",
    submissionState: environment.VBTECH_SUBMISSION_STATE,
  });
  return {
    environment,
    markiroDomains,
    selector,
    settings,
    transportOrigin: `https://${environment.MARKIRO_DOMAIN}`,
  };
}

function exactMarkiroRecordKeys(value) {
  return value?.vbtech === undefined
    ? "apiDigest,createdAt,edgeDigest,previousTag,state,tag"
    : "apiDigest,createdAt,edgeDigest,previousTag,state,tag,vbtech";
}

function validMarkiroRecord(value, file) {
  if (
    !hasExactKeys(value, exactMarkiroRecordKeys(value)) ||
    !RELEASE_SHA_PATTERN.test(value.tag) ||
    (value.previousTag !== null && !RELEASE_SHA_PATTERN.test(value.previousTag)) ||
    !imageReference(API_REPOSITORY, value.apiDigest) ||
    !imageReference(EDGE_REPOSITORY, value.edgeDigest) ||
    !["pending", "healthy", "failed"].includes(value.state) ||
    !isCanonicalIsoDate(value.createdAt)
  )
    return false;
  if (value.vbtech !== undefined) {
    try {
      validateVbtechSelector(value.vbtech);
    } catch {
      return false;
    }
  }
  const timestamp = value.createdAt.replace(/[:.]/g, "-");
  const base = `${timestamp}-${value.tag}`;
  if (value.state === "healthy" && (file === `${base}.json` || file === `${base}.healthy.json`))
    return true;
  return file === `${base}.${value.state}.json`;
}

async function activeReleaseTarget(system) {
  const path = system.paths.activeReleaseLink;
  const metadata = await system.lstat(path);
  if (!metadata.isSymbolicLink()) throw new Error("active release is invalid");
  const target = await system.readlink(path);
  if (
    typeof target !== "string" ||
    !isAbsolute(target) ||
    target.includes("\0") ||
    resolve(target) !== target ||
    !RELEASE_SHA_PATTERN.test(basename(target))
  )
    throw new Error("active release is invalid");
  const targetMetadata = await system.lstat(target);
  if (!targetMetadata.isDirectory()) throw new Error("active release is invalid");
  return { releaseDirectory: target, releaseSha: basename(target) };
}

async function matchingActiveMarkiroRecord(system, releaseSha) {
  const directoryLinkMetadata = await system.lstat(system.paths.markiroReleaseDirectory);
  const directoryMetadata = await system.stat(system.paths.markiroReleaseDirectory);
  if (
    !directoryLinkMetadata.isDirectory() ||
    !directoryMetadata.isDirectory() ||
    (directoryMetadata.mode & 0o777) !== 0o700
  )
    throw new Error("active Markiro state is invalid");
  const files = await system.readdir(system.paths.markiroReleaseDirectory);
  const healthy = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    const path = `${system.paths.markiroReleaseDirectory}/${file}`;
    const linkMetadata = await system.lstat(path);
    const metadata = await system.stat(path);
    if (
      !linkMetadata.isFile() ||
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size > MAX_RECORD_BYTES
    )
      throw new Error("active Markiro state is invalid");
    let value;
    try {
      value = JSON.parse(await system.readFile(path, "utf8"));
    } catch {
      throw new Error("active Markiro state is invalid");
    }
    if (value?.tag !== releaseSha) continue;
    if (!validMarkiroRecord(value, file)) throw new Error("active Markiro state is invalid");
    if (value.state === "healthy") healthy.push(value);
  }
  if (healthy.length !== 1) throw new Error("active Markiro state is invalid");
  return healthy[0];
}

function boundedResult(result) {
  if (
    !result ||
    typeof result !== "object" ||
    !Number.isSafeInteger(result.code) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES ||
    Buffer.byteLength(result.stderr, "utf8") > MAX_COMMAND_OUTPUT_BYTES
  )
    throw new Error("bounded command result is invalid");
  return result;
}

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeImageTarget(value) {
  return (
    IMAGE_ID_PATTERN.test(value) ||
    imageReference(API_REPOSITORY, value) ||
    imageReference(EDGE_REPOSITORY, value) ||
    imageReference(VBTECH_REPOSITORY, value)
  );
}

function allowedDockerCommand(args, environment) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) return false;
  if (
    exactArray(args, [
      "network",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${PRODUCTION_COMPOSE_PROJECT}`,
      "--format",
      "{{json .Name}}",
    ])
  )
    return true;
  if (
    args.length === 5 &&
    args[0] === "network" &&
    args[1] === "inspect" &&
    args[2] === "--format" &&
    args[3] === "{{json .Labels}}" &&
    NETWORK_NAME_PATTERN.test(args[4])
  )
    return true;
  if (
    args.length === 5 &&
    args[0] === "image" &&
    args[1] === "inspect" &&
    args[2] === "--format" &&
    args[3] === "{{json .RepoDigests}}" &&
    safeImageTarget(args[4])
  )
    return true;
  if (
    args.length === 4 &&
    args[0] === "inspect" &&
    args[1] === "--format" &&
    ["{{json .Image}}", "{{json .State.Health}}"].includes(args[2]) &&
    CONTAINER_ID_PATTERN.test(args[3])
  )
    return true;
  if (args[0] === "ps") {
    const allowedServices = new Set(["api", "edge", "vbtech-web"]);
    const expectedPrefix =
      args[1] === "--all" ? ["ps", "--all", "--no-trunc"] : ["ps", "--no-trunc"];
    if (!exactArray(args.slice(0, expectedPrefix.length), expectedPrefix)) return false;
    const remainder = args.slice(expectedPrefix.length);
    return (
      remainder.length === 6 &&
      remainder[0] === "--filter" &&
      remainder[1] === `label=com.docker.compose.project=${PRODUCTION_COMPOSE_PROJECT}` &&
      remainder[2] === "--filter" &&
      remainder[3].startsWith("label=com.docker.compose.service=") &&
      allowedServices.has(remainder[3].split("=").at(-1)) &&
      remainder[4] === "--format" &&
      remainder[5] === "{{.ID}}"
    );
  }
  const compose = productionComposeArgs(environment);
  if (!exactArray(args.slice(0, compose.length), compose)) return false;
  const tail = args.slice(compose.length);
  return [
    ["pull", "vbtech-web"],
    ["up", "-d", "--no-deps", "vbtech-web"],
    ["up", "-d", "--no-deps", "--force-recreate", "edge"],
    ["rm", "--stop", "--force", "vbtech-web"],
  ].some((allowed) => exactArray(tail, allowed));
}

async function runDocker(system, args, environment, cwd, timeoutMs) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS ||
    !allowedDockerCommand(args, environment)
  )
    throw new Error("Docker command is not allowed");
  const result = await timeoutPromise(
    system.runner.run("docker", args, environment, timeoutMs, {
      cwd,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    }),
    timeoutMs,
  );
  return boundedResult(result);
}

async function mustRunDocker(system, args, environment, cwd, timeoutMs) {
  const result = await runDocker(system, args, environment, cwd, timeoutMs);
  if (result.code !== 0) throw new Error("Docker command failed");
  return result;
}

function parseJsonOutput(value) {
  try {
    return JSON.parse(value.trim());
  } catch {
    throw new Error("Docker output is invalid");
  }
}

function requireRepoDigest(expected, output) {
  const value = parseJsonOutput(output);
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string") ||
    !value.includes(expected)
  )
    throw new Error("Docker image identity is invalid");
}

function commandEnvironment(input, active, vbtech) {
  const [markiroDomain, kioskDomain, landingDomain] = input.markiroDomains;
  const environment = {
    PATH: FIXED_PATH,
    ...(input.environment.DOCKER_CONFIG === undefined
      ? {}
      : { DOCKER_CONFIG: input.environment.DOCKER_CONFIG }),
    MARKIRO_COMPOSE_PROJECT: PRODUCTION_COMPOSE_PROJECT,
    MARKIRO_ENV_FILE: active.environmentFile,
    MARKIRO_IMAGE_TAG: active.release.tag,
    MARKIRO_API_IMAGE_DIGEST: digestFromReference(API_REPOSITORY, active.release.apiDigest),
    MARKIRO_EDGE_IMAGE_DIGEST: digestFromReference(EDGE_REPOSITORY, active.release.edgeDigest),
    MARKIRO_DOMAIN: markiroDomain,
    MARKIRO_KIOSK_DOMAIN: kioskDomain,
    MARKIRO_LANDING_DOMAIN: landingDomain,
  };
  if (vbtech === undefined) return environment;
  return {
    ...environment,
    VBTECH_IMAGE_REF: vbtech.imageRef,
    VBTECH_RELEASE_SHA: vbtech.releaseSha,
    VBTECH_DOMAIN: VBTECH_APEX_DOMAIN,
    VBTECH_WWW_DOMAIN: VBTECH_WWW_DOMAIN,
    VBTECH_FUNCTION_PATH: "",
    VBTECH_SUBMISSION_STATE: "disabled",
  };
}

async function oneServiceContainer(
  system,
  service,
  environment,
  cwd,
  { includeStopped = false } = {},
) {
  const result = await mustRunDocker(
    system,
    [
      "ps",
      ...(includeStopped ? ["--all"] : []),
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${PRODUCTION_COMPOSE_PROJECT}`,
      "--filter",
      `label=com.docker.compose.service=${service}`,
      "--format",
      "{{.ID}}",
    ],
    environment,
    cwd,
    COMMAND_TIMEOUT_MS,
  );
  const ids = result.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length !== 1 || !CONTAINER_ID_PATTERN.test(ids[0]))
    throw new Error("Compose service identity is invalid");
  return ids[0];
}

async function validateRunningServiceDigest(system, service, expected, environment, cwd) {
  const containerId = await oneServiceContainer(system, service, environment, cwd);
  const imageResult = await mustRunDocker(
    system,
    ["inspect", "--format", "{{json .Image}}", containerId],
    environment,
    cwd,
    COMMAND_TIMEOUT_MS,
  );
  const imageId = parseJsonOutput(imageResult.stdout);
  if (typeof imageId !== "string" || !IMAGE_ID_PATTERN.test(imageId))
    throw new Error("Compose service image identity is invalid");
  const digestResult = await mustRunDocker(
    system,
    ["image", "inspect", "--format", "{{json .RepoDigests}}", imageId],
    environment,
    cwd,
    COMMAND_TIMEOUT_MS,
  );
  requireRepoDigest(expected, digestResult.stdout);
}

async function validateComposeNetwork(system, environment, cwd) {
  const listed = await mustRunDocker(
    system,
    [
      "network",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${PRODUCTION_COMPOSE_PROJECT}`,
      "--format",
      "{{json .Name}}",
    ],
    environment,
    cwd,
    COMMAND_TIMEOUT_MS,
  );
  let names;
  try {
    names = listed.stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => JSON.parse(value));
  } catch {
    throw new Error("Compose network is invalid");
  }
  if (names.length !== 1 || typeof names[0] !== "string" || !NETWORK_NAME_PATTERN.test(names[0]))
    throw new Error("Compose network is invalid");
  const inspected = await mustRunDocker(
    system,
    ["network", "inspect", "--format", "{{json .Labels}}", names[0]],
    environment,
    cwd,
    COMMAND_TIMEOUT_MS,
  );
  const labels = parseJsonOutput(inspected.stdout);
  if (
    !labels ||
    typeof labels !== "object" ||
    Array.isArray(labels) ||
    labels["com.docker.compose.project"] !== PRODUCTION_COMPOSE_PROJECT
  )
    throw new Error("Compose network is invalid");
  return names[0];
}

async function activeMarkiroContext(system, input) {
  const target = await activeReleaseTarget(system);
  const release = await matchingActiveMarkiroRecord(system, target.releaseSha);
  const active = {
    ...target,
    release,
    environmentFile: system.paths.environmentFile,
  };
  const environment = commandEnvironment(input, active);
  await validateComposeNetwork(system, environment, target.releaseDirectory);
  await validateRunningServiceDigest(
    system,
    "api",
    release.apiDigest,
    environment,
    target.releaseDirectory,
  );
  await validateRunningServiceDigest(
    system,
    "edge",
    release.edgeDigest,
    environment,
    target.releaseDirectory,
  );
  return active;
}

function selectorFromHealthyRecord(value) {
  if (value === undefined) return undefined;
  if (
    !hasExactKeys(value, "createdAt,imageDigest,imageRef,releaseSha,state,submissionState") ||
    value.state !== "healthy" ||
    !isCanonicalIsoDate(value.createdAt)
  )
    throw new Error("v-b lifecycle record is invalid");
  return validateVbtechSelector({
    imageRef: value.imageRef,
    imageDigest: value.imageDigest,
    releaseSha: value.releaseSha,
    functionPath: "",
    submissionState: value.submissionState,
  });
}

function validatedPendingRecord(value, selector) {
  if (
    !hasExactKeys(value, "createdAt,imageDigest,imageRef,releaseSha,state,submissionState") ||
    value.state !== "pending" ||
    !isCanonicalIsoDate(value.createdAt) ||
    value.releaseSha !== selector.releaseSha ||
    value.imageRef !== selector.imageRef ||
    value.imageDigest !== selector.imageDigest ||
    value.submissionState !== selector.submissionState
  )
    throw new Error("pending v-b lifecycle record is invalid");
  return value;
}

async function emitStage(system, event, failureStage, action, timeoutMs) {
  try {
    system.event(event);
    return timeoutMs === undefined ? await action() : await timeoutPromise(action(), timeoutMs);
  } catch {
    throw new VbtechDeployStageError(failureStage);
  }
}

async function inspectExactDigest(system, imageRef, environment, cwd) {
  const result = await mustRunDocker(
    system,
    ["image", "inspect", "--format", "{{json .RepoDigests}}", imageRef],
    environment,
    cwd,
    COMMAND_TIMEOUT_MS,
  );
  requireRepoDigest(imageRef, result.stdout);
}

async function waitForVbtechHealth(system, input, active, environment) {
  const containerId = await oneServiceContainer(
    system,
    "vbtech-web",
    environment,
    active.releaseDirectory,
    { includeStopped: true },
  );
  const startedAt = system.monotonicNow();
  for (let attempt = 0; attempt < input.settings.serviceHealthAttempts; attempt += 1) {
    const elapsed = system.monotonicNow() - startedAt;
    const remaining = input.settings.serviceHealthTimeoutMs - elapsed;
    if (!Number.isFinite(remaining) || remaining <= 0) break;
    const result = await mustRunDocker(
      system,
      ["inspect", "--format", "{{json .State.Health}}", containerId],
      environment,
      active.releaseDirectory,
      Math.max(1, Math.floor(Math.min(COMMAND_TIMEOUT_MS, remaining))),
    );
    const health = parseJsonOutput(result.stdout);
    if (!health || typeof health !== "object" || Array.isArray(health))
      throw new Error("v-b service health is invalid");
    if (health.Status === "healthy") return;
    if (health.Status !== "starting") throw new Error("v-b service health is invalid");
    if (attempt + 1 >= input.settings.serviceHealthAttempts) break;
    const afterProbe = input.settings.serviceHealthTimeoutMs - (system.monotonicNow() - startedAt);
    if (!Number.isFinite(afterProbe) || afterProbe <= 0) break;
    const delay = Math.min(input.settings.serviceHealthIntervalMs, afterProbe);
    await timeoutPromise(system.sleep(delay), Math.max(1, Math.ceil(afterProbe)));
  }
  throw new Error("v-b service health deadline exceeded");
}

async function waitForEdgeReadiness(system, input) {
  const startedAt = system.monotonicNow();
  for (let attempt = 0; attempt < input.settings.edgeReadinessAttempts; attempt += 1) {
    const remaining = input.settings.edgeReadinessTimeoutMs - (system.monotonicNow() - startedAt);
    if (!Number.isFinite(remaining) || remaining <= 0) break;
    const probeTimeoutMs = Math.max(1, Math.floor(Math.min(COMMAND_TIMEOUT_MS, remaining)));
    try {
      const result = await timeoutPromise(
        system.probeEdge({ transportOrigin: input.transportOrigin, timeoutMs: probeTimeoutMs }),
        probeTimeoutMs,
      );
      if (result?.status === 200) return;
    } catch {
      // A bounded retry is safer than disclosing transport details.
    }
    if (attempt + 1 >= input.settings.edgeReadinessAttempts) break;
    const afterProbe = input.settings.edgeReadinessTimeoutMs - (system.monotonicNow() - startedAt);
    if (!Number.isFinite(afterProbe) || afterProbe <= 0) break;
    const delay = Math.min(input.settings.edgeReadinessIntervalMs, afterProbe);
    await timeoutPromise(system.sleep(delay), Math.max(1, Math.ceil(afterProbe)));
  }
  throw new Error("edge readiness deadline exceeded");
}

async function rollbackCandidate(system, input, active, previous) {
  let firstFailure;
  const attempt = async (event, rollbackStage, action) => {
    try {
      system.event(event);
      await action();
    } catch {
      firstFailure ??= rollbackStage;
    }
  };
  const selector = previous?.selector;
  const environment = commandEnvironment(input, active, selector);
  const compose = productionComposeArgs(environment);
  if (selector === undefined) {
    const candidateEnvironment = commandEnvironment(input, active, input.selector);
    const candidateCompose = productionComposeArgs(candidateEnvironment);
    await attempt("rollback-remove-vbtech-web", "rollback-service", () =>
      mustRunDocker(
        system,
        [...candidateCompose, "rm", "--stop", "--force", "vbtech-web"],
        candidateEnvironment,
        active.releaseDirectory,
        SERVICE_TIMEOUT_MS,
      ),
    );
  } else {
    await attempt("rollback-restore-vbtech-web", "rollback-service", async () => {
      await inspectExactDigest(system, selector.imageRef, environment, active.releaseDirectory);
      await mustRunDocker(
        system,
        [...compose, "up", "-d", "--no-deps", "vbtech-web"],
        environment,
        active.releaseDirectory,
        SERVICE_TIMEOUT_MS,
      );
    });
    await attempt("rollback-health-vbtech-web", "rollback-health", () =>
      waitForVbtechHealth(system, input, active, environment),
    );
  }
  await attempt("rollback-recreate-edge", "rollback-edge", () =>
    mustRunDocker(
      system,
      [...compose, "up", "-d", "--no-deps", "--force-recreate", "edge"],
      environment,
      active.releaseDirectory,
      SERVICE_TIMEOUT_MS,
    ),
  );
  await attempt("rollback-edge-readiness", "rollback-readiness", () =>
    waitForEdgeReadiness(system, input),
  );
  if (selector !== undefined)
    await attempt("rollback-private-smoke", "rollback-smoke", () =>
      timeoutPromise(
        system.runPrivateVbtechSmoke({
          transportOrigin: input.transportOrigin,
          expectedVbtechReleaseSha: selector.releaseSha,
        }),
        input.settings.privateSmokeTimeoutMs,
      ),
    );
  return firstFailure;
}

export async function deployVbtechRelease(options, supplied = {}) {
  const system = dependencies(supplied);
  const input = await emitStage(system, "validate", "validation", async () =>
    validatedInput(options, system.paths),
  );
  const active = await emitStage(system, "read-active-markiro", "active-markiro", () =>
    activeMarkiroContext(system, input),
  );
  const previous = await emitStage(
    system,
    "read-vbtech-state",
    "vbtech-state",
    async () => {
      const record = await system.latestHealthyVbtechRelease(system.paths.vbtechReleaseDirectory);
      const selector = selectorFromHealthyRecord(record);
      return selector === undefined ? undefined : { record, selector };
    },
    STATE_TIMEOUT_MS,
  );
  const pending = await emitStage(
    system,
    "pending",
    "pending",
    async () =>
      validatedPendingRecord(
        await system.writePendingVbtechRelease(system.paths.vbtechReleaseDirectory, input.selector),
        input.selector,
      ),
    STATE_TIMEOUT_MS,
  );
  const environment = commandEnvironment(input, active, input.selector);
  const compose = productionComposeArgs(environment);
  let serviceActivationAttempted = false;
  let primaryFailure;
  try {
    await emitStage(system, "pull", "pull", () =>
      mustRunDocker(
        system,
        [...compose, "pull", "vbtech-web"],
        environment,
        active.releaseDirectory,
        PULL_TIMEOUT_MS,
      ),
    );
    await emitStage(system, "inspect-digest", "candidate-digest", () =>
      inspectExactDigest(system, input.selector.imageRef, environment, active.releaseDirectory),
    );
    serviceActivationAttempted = true;
    await emitStage(system, "up-vbtech-web", "candidate-service", () =>
      mustRunDocker(
        system,
        [...compose, "up", "-d", "--no-deps", "vbtech-web"],
        environment,
        active.releaseDirectory,
        SERVICE_TIMEOUT_MS,
      ),
    );
    await emitStage(system, "health-vbtech-web", "candidate-health", () =>
      waitForVbtechHealth(system, input, active, environment),
    );
    await emitStage(system, "recreate-edge", "edge-activation", () =>
      mustRunDocker(
        system,
        [...compose, "up", "-d", "--no-deps", "--force-recreate", "edge"],
        environment,
        active.releaseDirectory,
        SERVICE_TIMEOUT_MS,
      ),
    );
    await emitStage(
      system,
      "private-smoke",
      "private-smoke",
      () =>
        system.runPrivateVbtechSmoke({
          transportOrigin: input.transportOrigin,
          expectedVbtechReleaseSha: input.selector.releaseSha,
        }),
      input.settings.privateSmokeTimeoutMs,
    );
    return await emitStage(
      system,
      "healthy",
      "healthy",
      () => system.markVbtechReleaseHealthy(system.paths.vbtechReleaseDirectory, pending),
      STATE_TIMEOUT_MS,
    );
  } catch (error) {
    primaryFailure =
      error instanceof VbtechDeployStageError ? error : new VbtechDeployStageError("configuration");
  }

  let rollbackFailure;
  if (serviceActivationAttempted)
    rollbackFailure = await rollbackCandidate(system, input, active, previous);
  try {
    system.event("failed");
    await timeoutPromise(
      system.markVbtechReleaseFailed(system.paths.vbtechReleaseDirectory, pending),
      STATE_TIMEOUT_MS,
    );
  } catch {
    rollbackFailure ??= "failed-record";
  }
  throw new VbtechDeployStageError(primaryFailure.stage, rollbackFailure);
}

function safeStage(value) {
  return DEPLOYMENT_STAGES.has(value) ? value : "configuration";
}

function safeRollbackStage(value) {
  return ROLLBACK_STAGES.has(value) ? value : undefined;
}

export async function runVbtechDeployCli(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (Array.isArray(argv) && argv.length === 1 && argv[0] === "contract-version") {
    stdout.write(`MARKIRO_VBTECH_EXECUTOR ${VBTECH_EXECUTOR_CONTRACT_VERSION}\n`);
    return 0;
  }
  try {
    if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "run")
      throw new VbtechDeployStageError("configuration");
    await (options.deploy ?? deployVbtechRelease)(
      { environment: options.environment ?? process.env },
      options.supplied ?? {},
    );
    stdout.write("MARKIRO_VBTECH_DEPLOY_HEALTHY\n");
    return 0;
  } catch (error) {
    const stage = safeStage(error?.stage);
    const rollbackStage = safeRollbackStage(error?.rollbackStage);
    stderr.write(
      rollbackStage === undefined
        ? `MARKIRO_VBTECH_DEPLOY_FAILURE ${stage}\n`
        : `MARKIRO_VBTECH_DEPLOY_FAILURE ${stage} ROLLBACK ${rollbackStage}\n`,
    );
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runVbtechDeployCli();
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import process from "node:process";
import { readFile, readdir, readlink } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^ghcr[.]io\/thevladbog\/markiro-(api|edge)@sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export const RUNTIME_ERROR_CLASSES = Object.freeze([
  "configuration",
  "database_connection",
  "database_schema",
  "resources",
  "healthcheck",
  "process_crash",
  "unknown",
]);

export const RUNTIME_CONFIGURATION_ISSUES = Object.freeze([
  "LANDING_DEMO_SUBMISSION_ENABLED",
  "LANDING_ORIGIN",
  "LANDING_DEMO_RECIPIENT",
  "LANDING_DEMO_REPLY_TO",
  "SMARTCAPTCHA_SERVER_KEY",
  "LANDING_DEMO_RATE_WINDOW_SECONDS",
  "LANDING_DEMO_SOURCE_LIMIT",
  "LANDING_DEMO_GLOBAL_LIMIT",
  "SMTP_USER",
  "SMTP_PASSWORD",
]);

const errorClassOrder = new Map(RUNTIME_ERROR_CLASSES.map((value, index) => [value, index]));

function boundedStatus(value) {
  return ["active", "inactive", "failed"].includes(value) ? value : "unknown";
}

async function defaultRun(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: command === "docker" && args[0] === "logs" ? 256 * 1024 : 64 * 1024,
      timeout: 15_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: Number.isSafeInteger(error?.code) ? error.code : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : "",
    };
  }
}

function classifyEvidence(logs, state) {
  const classes = new Set();
  if (
    /(?:zoderror|invalid (?:environment|configuration)|environment (?:value|variable)|missing required|required environment|configuration validation)/i.test(
      logs,
    )
  )
    classes.add("configuration");
  if (
    /(?:econnrefused|enotfound|password authentication failed|no pg_hba|database connection|connect(?:ion)? (?:to )?(?:database|postgres)|connection (?:terminated|refused|timed out))/i.test(
      logs,
    )
  )
    classes.add("database_connection");
  if (
    /(?:relation .+ does not exist|column .+ does not exist|constraint .+ (?:already exists|does not exist)|type .+ already exists|migration failed|drizzle.*migrat)/i.test(
      logs,
    )
  )
    classes.add("database_schema");
  if (state.oomKilled || /(?:out of memory|oomkilled|no space left on device)/i.test(logs))
    classes.add("resources");
  if (state.health === "unhealthy") classes.add("healthcheck");
  if (state.state === "exited" && state.exitCode !== 0) classes.add("process_crash");
  if (classes.size === 0 && ["exited", "unknown"].includes(state.state)) classes.add("unknown");
  return [...classes].toSorted(
    (left, right) => errorClassOrder.get(left) - errorClassOrder.get(right),
  );
}

function configurationIssues(logs) {
  return RUNTIME_CONFIGURATION_ISSUES.filter((name) => logs.includes(name));
}

function parseState(text) {
  try {
    const value = JSON.parse(text);
    const state = ["running", "exited"].includes(value?.Status) ? value.Status : "unknown";
    const health = ["healthy", "unhealthy", "starting"].includes(value?.Health?.Status)
      ? value.Health.Status
      : value?.Health
        ? "unknown"
        : "none";
    return {
      state,
      health,
      exitCode:
        Number.isSafeInteger(value?.ExitCode) && value.ExitCode >= 0 ? value.ExitCode : null,
      oomKilled: value?.OOMKilled === true,
    };
  } catch {
    return { state: "unknown", health: "unknown", exitCode: null, oomKilled: false };
  }
}

function parseRepoDigest(text, service) {
  try {
    const values = JSON.parse(text);
    if (!Array.isArray(values)) return null;
    return (
      values.find(
        (value) =>
          typeof value === "string" &&
          value.startsWith(`ghcr.io/thevladbog/markiro-${service}@sha256:`) &&
          IMAGE_DIGEST.test(value),
      ) ?? null
    );
  } catch {
    return null;
  }
}

function validReleaseRecord(value) {
  return (
    value &&
    RELEASE_SHA.test(value.tag) &&
    ["pending", "healthy", "failed"].includes(value.state) &&
    IMAGE_DIGEST.test(value.apiDigest) &&
    IMAGE_DIGEST.test(value.edgeDigest) &&
    typeof value.createdAt === "string" &&
    new Date(value.createdAt).toISOString() === value.createdAt
  );
}

async function releaseRecords(dependencies) {
  try {
    const names = await dependencies.readdir("/var/lib/markiro/releases");
    const records = [];
    for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
      try {
        const value = JSON.parse(
          await dependencies.readFile(join("/var/lib/markiro/releases", name), "utf8"),
        );
        if (validReleaseRecord(value)) records.push(value);
      } catch {
        // Malformed and unreadable records provide no trusted diagnostic evidence.
      }
    }
    return records;
  } catch {
    return [];
  }
}

function newestRecord(records, predicate) {
  return records
    .filter(predicate)
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
}

async function activeRelease(dependencies) {
  try {
    const target = await dependencies.readlink("/opt/markiro/active-release");
    const tag = basename(target);
    return RELEASE_SHA.test(tag) ? tag : "unknown";
  } catch {
    return "unknown";
  }
}

async function inspectService(service, records, dependencies) {
  const idResult = await dependencies.run("docker", [
    "ps",
    "-a",
    "--filter",
    "label=com.docker.compose.project=markiro-production",
    "--filter",
    `label=com.docker.compose.service=${service}`,
    "--format",
    "{{.ID}}",
  ]);
  const ids = idResult.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0)
    return {
      state: "missing",
      health: "none",
      exitCode: null,
      oomKilled: false,
      release: "unknown",
      errorClasses: ["unknown"],
      configurationIssues: [],
    };
  if (ids.length !== 1 || !CONTAINER_ID.test(ids[0]))
    return {
      state: "unknown",
      health: "unknown",
      exitCode: null,
      oomKilled: false,
      release: "unknown",
      errorClasses: ["unknown"],
      configurationIssues: [],
    };

  const id = ids[0];
  const stateResult = await dependencies.run("docker", [
    "inspect",
    "--format",
    "{{json .State}}",
    id,
  ]);
  const state = parseState(stateResult.stdout.trim());
  const imageResult = await dependencies.run("docker", ["inspect", "--format", "{{.Image}}", id]);
  const imageId = imageResult.stdout.trim();
  let repoDigest = null;
  if (IMAGE_ID.test(imageId)) {
    const digestResult = await dependencies.run("docker", [
      "image",
      "inspect",
      "--format",
      "{{json .RepoDigests}}",
      imageId,
    ]);
    repoDigest = parseRepoDigest(digestResult.stdout.trim(), service);
  }
  const logs = await dependencies.run("docker", ["logs", "--tail", "200", id]);
  const logText = `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`;
  const errorClasses = classifyEvidence(logText, state);
  const digestKey = service === "api" ? "apiDigest" : "edgeDigest";
  const release = repoDigest
    ? (newestRecord(records, (record) => record[digestKey] === repoDigest)?.tag ?? "unknown")
    : "unknown";
  return {
    ...state,
    release,
    errorClasses,
    configurationIssues: errorClasses.includes("configuration") ? configurationIssues(logText) : [],
  };
}

export async function collectRuntimeSnapshot(supplied = {}) {
  const dependencies = {
    run: defaultRun,
    readlink,
    readdir,
    readFile,
    ...supplied,
  };
  const [dockerResult, runtimeEnvResult, records, active] = await Promise.all([
    dependencies.run("systemctl", ["is-active", "docker.service"]),
    dependencies.run("systemctl", ["is-active", "markiro-runtime-env.service"]),
    releaseRecords(dependencies),
    activeRelease(dependencies),
  ]);
  const candidate = newestRecord(records, (record) => ["pending", "failed"].includes(record.state));
  const [api, edge] = await Promise.all([
    inspectService("api", records, dependencies),
    inspectService("edge", records, dependencies),
  ]);
  return {
    version: 2,
    docker: boundedStatus(dockerResult.stdout.trim()),
    runtimeEnv: boundedStatus(runtimeEnvResult.stdout.trim()),
    activeRelease: active,
    candidateRelease: candidate?.tag ?? "unknown",
    api,
    edge,
  };
}

function validRelease(value) {
  return value === "unknown" || (typeof value === "string" && RELEASE_SHA.test(value));
}

function validService(value) {
  const keys = Object.keys(value ?? {})
    .sort()
    .join(",");
  return (
    keys === "configurationIssues,errorClasses,exitCode,health,oomKilled,release,state" &&
    ["running", "exited", "missing", "unknown"].includes(value.state) &&
    ["healthy", "unhealthy", "starting", "none", "unknown"].includes(value.health) &&
    (value.exitCode === null ||
      (Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255)) &&
    typeof value.oomKilled === "boolean" &&
    validRelease(value.release) &&
    Array.isArray(value.errorClasses) &&
    value.errorClasses.every((item, index) =>
      index === 0
        ? RUNTIME_ERROR_CLASSES.includes(item)
        : errorClassOrder.get(value.errorClasses[index - 1]) < errorClassOrder.get(item),
    ) &&
    Array.isArray(value.configurationIssues) &&
    (value.configurationIssues.length === 0 || value.errorClasses.includes("configuration")) &&
    value.configurationIssues.every((item, index) =>
      index === 0
        ? RUNTIME_CONFIGURATION_ISSUES.includes(item)
        : RUNTIME_CONFIGURATION_ISSUES.indexOf(value.configurationIssues[index - 1]) <
          RUNTIME_CONFIGURATION_ISSUES.indexOf(item),
    )
  );
}

export function validateRuntimeSnapshot(value) {
  if (
    Object.keys(value ?? {})
      .sort()
      .join(",") !== "activeRelease,api,candidateRelease,docker,edge,runtimeEnv,version" ||
    value.version !== 2 ||
    !["active", "inactive", "failed", "unknown"].includes(value.docker) ||
    !["active", "inactive", "failed", "unknown"].includes(value.runtimeEnv) ||
    !validRelease(value.activeRelease) ||
    !validRelease(value.candidateRelease) ||
    !validService(value.api) ||
    !validService(value.edge)
  )
    throw new Error("runtime diagnostics are invalid");
  return value;
}

export async function runRuntimeProbeCli(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const snapshot = validateRuntimeSnapshot(
      await collectRuntimeSnapshot(options.dependencies ?? {}),
    );
    stdout.write(`MARKIRO_RUNTIME_DIAGNOSTICS ${JSON.stringify(snapshot)}\n`);
    return 0;
  } catch {
    stderr.write("MARKIRO_RUNTIME_DIAGNOSTICS_FAILURE\n");
    return 1;
  }
}

if (process.env.MARKIRO_RUNTIME_DIAGNOSTICS_PROBE === "1") {
  process.exitCode = await runRuntimeProbeCli();
}

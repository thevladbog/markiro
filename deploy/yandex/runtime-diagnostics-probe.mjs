import { execFile } from "node:child_process";
import { lstat, readFile, readdir, readlink, stat, statfs } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MARKIRO_IMAGE_REF = /^ghcr[.]io\/thevladbog\/markiro-(api|edge)@sha256:[0-9a-f]{64}$/;
const VBTECH_IMAGE_REF = /^ghcr[.]io\/thevladbog\/vbtech-web@sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const SAFE_NETWORK_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const ALLOWED_SERVICES = Object.freeze(["api", "edge", "vbtech-web"]);
const CPU_SAMPLE_INTERVAL_MS = 100;
const MAX_VBTECH_STATE_BYTES = 16 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const VBTECH_RELEASE_DIRECTORY = "/var/lib/markiro/vbtech/releases";
const VBTECH_REPOSITORY = "ghcr.io/thevladbog/vbtech-web";
const VBTECH_RECORD_KEYS = "createdAt,imageDigest,imageRef,releaseSha,state,submissionState";
const VBTECH_CLAIM_KEYS = "generation,kind,record";
const VBTECH_LOCK_KEYS = "owner,pid";
const VBTECH_LOCK_FILE = ".vbtech-release-state.lock";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const VBTECH_TEMPORARY_FILE =
  /^\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{40}-[0-9a-f]{64}\.(?:pending|healthy|failed)\.json\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/;
const VBTECH_LOCK_TEMPORARY_FILE =
  /^\.vbtech-release-state\.lock\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/;
const VBTECH_CLAIM_TEMPORARY_FILE =
  /^\.vbtech-release-state\.[0-9a-f]{40}-[0-9a-f]{64}\.(?:pending|terminal)-[1-9][0-9]*\.claim\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/;

export const RUNTIME_ERROR_CLASSES = Object.freeze([
  "configuration",
  "database_connection",
  "database_schema",
  "upstream_connectivity",
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

function invalidDiagnostics() {
  return new Error("runtime diagnostics are invalid");
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys
  );
}

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

function defaultSampleCpu() {
  const values = cpus();
  if (!Array.isArray(values) || values.length === 0) throw invalidDiagnostics();
  let idle = 0;
  let total = 0;
  for (const value of values) {
    for (const key of ["user", "nice", "sys", "idle", "irq"]) {
      const count = value?.times?.[key];
      if (!Number.isSafeInteger(count) || count < 0) throw invalidDiagnostics();
      total += count;
      if (!Number.isSafeInteger(total)) throw invalidDiagnostics();
    }
    idle += value.times.idle;
    if (!Number.isSafeInteger(idle)) throw invalidDiagnostics();
  }
  return { idle, total };
}

function defaultReadMemory() {
  return { totalBytes: totalmem(), availableBytes: freemem() };
}

function safeProduct(left, right) {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0)
    throw invalidDiagnostics();
  const value = left * right;
  if (!Number.isSafeInteger(value)) throw invalidDiagnostics();
  return value;
}

async function defaultReadRootFilesystem() {
  const value = await statfs("/");
  return {
    totalBytes: safeProduct(value.bsize, value.blocks),
    availableBytes: safeProduct(value.bsize, value.bavail),
  };
}

async function defaultSleep(milliseconds) {
  await delay(milliseconds);
}

function validCpuSample(value) {
  return (
    hasExactKeys(value, "idle,total") &&
    Number.isSafeInteger(value.idle) &&
    value.idle >= 0 &&
    Number.isSafeInteger(value.total) &&
    value.total > 0 &&
    value.idle <= value.total
  );
}

function validBytePair(value) {
  return (
    hasExactKeys(value, "availableBytes,totalBytes") &&
    Number.isSafeInteger(value.totalBytes) &&
    value.totalBytes > 0 &&
    Number.isSafeInteger(value.availableBytes) &&
    value.availableBytes >= 0 &&
    value.availableBytes <= value.totalBytes
  );
}

async function collectResources(dependencies) {
  const first = await dependencies.sampleCpu();
  await dependencies.sleep(CPU_SAMPLE_INTERVAL_MS);
  const [second, memory, rootFilesystem] = await Promise.all([
    dependencies.sampleCpu(),
    dependencies.readMemory(),
    dependencies.readRootFilesystem(),
  ]);
  if (
    !validCpuSample(first) ||
    !validCpuSample(second) ||
    !validBytePair(memory) ||
    !validBytePair(rootFilesystem)
  )
    throw invalidDiagnostics();
  const totalDelta = second.total - first.total;
  const idleDelta = second.idle - first.idle;
  if (
    !Number.isSafeInteger(totalDelta) ||
    totalDelta <= 0 ||
    !Number.isSafeInteger(idleDelta) ||
    idleDelta < 0 ||
    idleDelta > totalDelta
  )
    throw invalidDiagnostics();
  const cpuBusyBasisPoints = Math.round(((totalDelta - idleDelta) / totalDelta) * 10_000);
  const resources = {
    cpuBusyBasisPoints,
    memoryTotalBytes: memory.totalBytes,
    memoryAvailableBytes: memory.availableBytes,
    rootFilesystemTotalBytes: rootFilesystem.totalBytes,
    rootFilesystemAvailableBytes: rootFilesystem.availableBytes,
  };
  if (!validResources(resources)) throw invalidDiagnostics();
  return resources;
}

function classifyEvidence(service, logs, state) {
  const classes = new Set();
  if (
    /(?:zoderror|invalid (?:environment|configuration)|environment (?:value|variable)|missing required|required environment|configuration validation)/i.test(
      logs,
    )
  )
    classes.add("configuration");
  if (
    service === "api" &&
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
  if (
    service === "edge" &&
    /(?:econnrefused|enotfound|eai_again|no such host|name or service not known|name resolution|dial tcp|upstream.{0,80}(?:connect|dial)|connect(?:ion)?:? refused)/i.test(
      logs,
    )
  )
    classes.add("upstream_connectivity");
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
    const pattern =
      service === "vbtech-web"
        ? VBTECH_IMAGE_REF
        : new RegExp(`^ghcr[.]io/thevladbog/markiro-${service}@sha256:[0-9a-f]{64}$`);
    const matches = [
      ...new Set(values.filter((value) => typeof value === "string" && pattern.test(value))),
    ];
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

function validReleaseRecord(value) {
  return (
    value &&
    RELEASE_SHA.test(value.tag) &&
    ["pending", "healthy", "failed"].includes(value.state) &&
    MARKIRO_IMAGE_REF.test(value.apiDigest) &&
    MARKIRO_IMAGE_REF.test(value.edgeDigest) &&
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
        // Existing Markiro diagnostics expose only trusted records and no raw parse details.
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

function isCanonicalIsoDate(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  try {
    return !Number.isNaN(date.getTime()) && date.toISOString() === value;
  } catch {
    return false;
  }
}

function isVbtechImageIdentity(value) {
  return (
    typeof value?.releaseSha === "string" &&
    RELEASE_SHA.test(value.releaseSha) &&
    typeof value.imageDigest === "string" &&
    DIGEST.test(value.imageDigest) &&
    typeof value.imageRef === "string" &&
    value.imageRef === `${VBTECH_REPOSITORY}@${value.imageDigest}`
  );
}

function isVbtechRecord(value) {
  return (
    hasExactKeys(value, VBTECH_RECORD_KEYS) &&
    isVbtechImageIdentity(value) &&
    value.submissionState === "disabled" &&
    isCanonicalIsoDate(value.createdAt) &&
    ["pending", "healthy", "failed"].includes(value.state)
  );
}

function vbtechRecordFileName(value) {
  return `${value.createdAt.replace(/[:.]/g, "-")}-${value.releaseSha}-${value.imageDigest.slice(7)}.${value.state}.json`;
}

function isVbtechClaim(value) {
  return (
    hasExactKeys(value, VBTECH_CLAIM_KEYS) &&
    ["pending", "terminal"].includes(value.kind) &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    isVbtechRecord(value.record) &&
    ((value.kind === "pending" && value.record.state === "pending") ||
      (value.kind === "terminal" && ["healthy", "failed"].includes(value.record.state)))
  );
}

function vbtechClaimFileName(value) {
  return `.vbtech-release-state.${value.record.releaseSha}-${value.record.imageDigest.slice(7)}.${value.kind}-${value.generation}.claim`;
}

function isVbtechLock(value) {
  return (
    hasExactKeys(value, VBTECH_LOCK_KEYS) &&
    typeof value.owner === "string" &&
    UUID.test(value.owner) &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0
  );
}

async function privateFileMetadata(path, dependencies) {
  let linkMetadata;
  let metadata;
  try {
    [linkMetadata, metadata] = await Promise.all([
      dependencies.lstat(path),
      dependencies.stat(path),
    ]);
  } catch {
    throw invalidDiagnostics();
  }
  if (
    !linkMetadata?.isFile?.() ||
    !metadata?.isFile?.() ||
    linkMetadata.isSymbolicLink?.() === true ||
    (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0 ||
    metadata.size > MAX_VBTECH_STATE_BYTES
  )
    throw invalidDiagnostics();
  return metadata;
}

async function readPrivateJson(path, dependencies) {
  await privateFileMetadata(path, dependencies);
  let contents;
  try {
    contents = await dependencies.readFile(path, "utf8");
  } catch {
    throw invalidDiagnostics();
  }
  if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > MAX_VBTECH_STATE_BYTES)
    throw invalidDiagnostics();
  try {
    return JSON.parse(contents);
  } catch {
    throw invalidDiagnostics();
  }
}

async function readVbtechClaim(directory, file, dependencies) {
  const value = await readPrivateJson(join(directory, file), dependencies);
  if (!isVbtechClaim(value) || vbtechClaimFileName(value) !== file) throw invalidDiagnostics();
  return value;
}

async function validateVbtechTransient(directory, file, dependencies) {
  if (file === VBTECH_LOCK_FILE) {
    if (!isVbtechLock(await readPrivateJson(join(directory, file), dependencies)))
      throw invalidDiagnostics();
    return null;
  }
  if (file.endsWith(".claim")) return readVbtechClaim(directory, file, dependencies);
  if (
    !VBTECH_TEMPORARY_FILE.test(file) &&
    !VBTECH_LOCK_TEMPORARY_FILE.test(file) &&
    !VBTECH_CLAIM_TEMPORARY_FILE.test(file)
  )
    throw invalidDiagnostics();
  await privateFileMetadata(join(directory, file), dependencies);
  return null;
}

function sameVbtechIdentity(left, right) {
  return (
    left.releaseSha === right.releaseSha &&
    left.imageRef === right.imageRef &&
    left.imageDigest === right.imageDigest &&
    left.submissionState === right.submissionState &&
    left.createdAt === right.createdAt
  );
}

function sameVbtechRecord(left, right) {
  return sameVbtechIdentity(left, right) && left.state === right.state;
}

function vbtechRecordIdentity(value) {
  return `${value.createdAt}\n${value.releaseSha}\n${value.imageDigest}`;
}

function vbtechReleaseIdentity(value) {
  return `${value.releaseSha}\n${value.imageDigest}`;
}

function validatedVbtechClaimChains(claims) {
  const byRelease = new Map();
  for (const claim of claims) {
    const identity = vbtechReleaseIdentity(claim.record);
    const values = byRelease.get(identity) ?? [];
    values.push(claim);
    byRelease.set(identity, values);
  }
  const chains = new Map();
  for (const [identity, releaseClaims] of byRelease) {
    const pendingByGeneration = new Map();
    const terminalByGeneration = new Map();
    for (const claim of releaseClaims) {
      const byGeneration = claim.kind === "pending" ? pendingByGeneration : terminalByGeneration;
      if (byGeneration.has(claim.generation)) throw invalidDiagnostics();
      byGeneration.set(claim.generation, claim);
    }
    const generations = [...pendingByGeneration.keys()].sort((left, right) => left - right);
    if (generations.length === 0) throw invalidDiagnostics();
    for (let index = 0; index < generations.length; index += 1) {
      if (generations[index] !== index + 1) throw invalidDiagnostics();
    }
    for (const generation of terminalByGeneration.keys()) {
      if (!pendingByGeneration.has(generation)) throw invalidDiagnostics();
    }
    const chain = generations.map((generation) => ({
      generation,
      pendingClaim: pendingByGeneration.get(generation),
      terminalClaim: terminalByGeneration.get(generation),
    }));
    for (let index = 0; index < chain.length; index += 1) {
      const current = chain[index];
      if (
        current.terminalClaim !== undefined &&
        !sameVbtechIdentity(current.pendingClaim.record, current.terminalClaim.record)
      )
        throw invalidDiagnostics();
      if (index > 0 && chain[index - 1].terminalClaim?.record.state !== "failed")
        throw invalidDiagnostics();
    }
    chains.set(identity, chain);
  }
  return chains;
}

function assertVbtechRecordTransitions(records) {
  const pending = new Map();
  const terminals = new Map();
  for (const record of records) {
    const identity = vbtechRecordIdentity(record);
    if (record.state === "pending") {
      if (pending.has(identity)) throw invalidDiagnostics();
      pending.set(identity, record);
      continue;
    }
    const values = terminals.get(identity) ?? [];
    values.push(record);
    terminals.set(identity, values);
  }
  for (const [identity, values] of terminals) {
    if (!pending.has(identity) || values.length !== 1) throw invalidDiagnostics();
  }
}

function vbtechLogicalRecords(persistedRecords, claims) {
  validatedVbtechClaimChains(claims);
  const pendingClaims = claims.filter((claim) => claim.kind === "pending");
  const terminalClaims = claims.filter((claim) => claim.kind === "terminal");
  for (const pendingClaim of pendingClaims) {
    const matches = persistedRecords.filter(
      (record) => record.state === "pending" && sameVbtechRecord(pendingClaim.record, record),
    );
    if (matches.length > 1) throw invalidDiagnostics();
  }
  for (const terminalClaim of terminalClaims) {
    const pending = pendingClaims.filter(
      (claim) =>
        claim.generation === terminalClaim.generation &&
        sameVbtechIdentity(claim.record, terminalClaim.record),
    );
    const terminals = persistedRecords.filter(
      (record) => record.state !== "pending" && sameVbtechRecord(terminalClaim.record, record),
    );
    if (pending.length !== 1 || terminals.length > 1) throw invalidDiagnostics();
  }
  for (const pending of persistedRecords.filter((record) => record.state === "pending")) {
    if (pendingClaims.filter((claim) => sameVbtechRecord(claim.record, pending)).length !== 1)
      throw invalidDiagnostics();
  }
  for (const terminal of persistedRecords.filter((record) => record.state !== "pending")) {
    const matchingPending = pendingClaims.filter((claim) =>
      sameVbtechIdentity(claim.record, terminal),
    );
    const matchingTerminal = terminalClaims.filter((claim) =>
      sameVbtechRecord(claim.record, terminal),
    );
    if (matchingPending.length !== 1 || matchingTerminal.length !== 1) throw invalidDiagnostics();
  }
  const records = claims.map((claim) => claim.record);
  assertVbtechRecordTransitions(records);
  return records;
}

async function readVbtechRecords(dependencies) {
  let linkMetadata;
  let metadata;
  try {
    linkMetadata = await dependencies.lstat(VBTECH_RELEASE_DIRECTORY);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw invalidDiagnostics();
  }
  try {
    metadata = await dependencies.stat(VBTECH_RELEASE_DIRECTORY);
  } catch {
    throw invalidDiagnostics();
  }
  if (
    !linkMetadata?.isDirectory?.() ||
    !metadata?.isDirectory?.() ||
    linkMetadata.isSymbolicLink?.() === true ||
    (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  )
    throw invalidDiagnostics();
  let files;
  try {
    files = await dependencies.readdir(VBTECH_RELEASE_DIRECTORY);
  } catch {
    throw invalidDiagnostics();
  }
  if (!Array.isArray(files)) throw invalidDiagnostics();
  const persistedRecords = [];
  const claims = [];
  const seen = new Set();
  for (const file of [...files].sort()) {
    if (typeof file !== "string" || file.length === 0 || basename(file) !== file || seen.has(file))
      throw invalidDiagnostics();
    seen.add(file);
    if (!file.endsWith(".json")) {
      const claim = await validateVbtechTransient(VBTECH_RELEASE_DIRECTORY, file, dependencies);
      if (claim) claims.push(claim);
      continue;
    }
    const record = await readPrivateJson(join(VBTECH_RELEASE_DIRECTORY, file), dependencies);
    if (!isVbtechRecord(record) || vbtechRecordFileName(record) !== file)
      throw invalidDiagnostics();
    persistedRecords.push(record);
  }
  return vbtechLogicalRecords(persistedRecords, claims);
}

function effectiveHealthyVbtechRecords(records) {
  const failed = records.filter((record) => record.state === "failed");
  return records
    .filter(
      (record) =>
        record.state === "healthy" &&
        !failed.some((terminal) => sameVbtechIdentity(terminal, record)),
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function activeVbtech(records) {
  const healthy = effectiveHealthyVbtechRecords(records);
  if (healthy.length === 0) return null;
  if (healthy.length > 1 && healthy[0].createdAt === healthy[1].createdAt)
    throw invalidDiagnostics();
  return {
    releaseSha: healthy[0].releaseSha,
    imageDigest: healthy[0].imageDigest,
  };
}

async function composeNetwork(dependencies) {
  const result = await dependencies.run("docker", [
    "network",
    "ls",
    "--filter",
    "label=com.docker.compose.project=markiro-production",
    "--format",
    "{{.Name}}",
  ]);
  if (result.code !== 0 || typeof result.stdout !== "string") throw invalidDiagnostics();
  const names = result.stdout.split("\n").filter((value) => value.length > 0);
  if (names.length !== 1 || !SAFE_NETWORK_NAME.test(names[0])) throw invalidDiagnostics();
  return names[0];
}

function missingService() {
  return {
    state: "missing",
    health: "none",
    exitCode: null,
    oomKilled: false,
    release: "unknown",
    errorClasses: ["unknown"],
    configurationIssues: [],
  };
}

function releaseForDigest(service, repoDigest, markiroRecords, vbtechRecords) {
  if (repoDigest === null) return "unknown";
  if (service === "vbtech-web") {
    const matches = effectiveHealthyVbtechRecords(vbtechRecords).filter(
      (record) => record.imageRef === repoDigest,
    );
    if (matches.length > 1) throw invalidDiagnostics();
    return matches[0]?.releaseSha ?? "unknown";
  }
  const digestKey = service === "api" ? "apiDigest" : "edgeDigest";
  return (
    newestRecord(markiroRecords, (record) => record[digestKey] === repoDigest)?.tag ?? "unknown"
  );
}

async function inspectService(service, markiroRecords, vbtechRecords, dependencies) {
  if (!ALLOWED_SERVICES.includes(service)) throw invalidDiagnostics();
  const idResult = await dependencies.run("docker", [
    "ps",
    "-a",
    "--filter",
    "label=com.docker.compose.project=markiro-production",
    "--filter",
    `label=com.docker.compose.service=${service}`,
    "--format",
    '{{.ID}}\t{{.Label "com.docker.compose.service"}}',
  ]);
  if (idResult.code !== 0 || typeof idResult.stdout !== "string") throw invalidDiagnostics();
  const identities = idResult.stdout.split("\n").filter((value) => value.length > 0);
  if (identities.length === 0) return missingService();
  const parsed = identities.map((value) => {
    const match = value.match(/^([0-9a-f]{12,64})\t(api|edge|vbtech-web)$/);
    if (!match || match[2] !== service) throw invalidDiagnostics();
    return match[1];
  });
  if (parsed.length !== 1 || !CONTAINER_ID.test(parsed[0]))
    return {
      state: "unknown",
      health: "unknown",
      exitCode: null,
      oomKilled: false,
      release: "unknown",
      errorClasses: ["unknown"],
      configurationIssues: [],
    };

  const id = parsed[0];
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
  const errorClasses = classifyEvidence(service, logText, state);
  return {
    ...state,
    release: releaseForDigest(service, repoDigest, markiroRecords, vbtechRecords),
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
    lstat,
    stat,
    sampleCpu: defaultSampleCpu,
    readMemory: defaultReadMemory,
    readRootFilesystem: defaultReadRootFilesystem,
    sleep: defaultSleep,
    ...supplied,
  };
  const [
    dockerResult,
    runtimeEnvResult,
    markiroRecords,
    active,
    network,
    resources,
    vbtechRecords,
  ] = await Promise.all([
    dependencies.run("systemctl", ["is-active", "docker.service"]),
    dependencies.run("systemctl", ["is-active", "markiro-runtime-env.service"]),
    releaseRecords(dependencies),
    activeRelease(dependencies),
    composeNetwork(dependencies),
    collectResources(dependencies),
    readVbtechRecords(dependencies),
  ]);
  const candidate = newestRecord(markiroRecords, (record) =>
    ["pending", "failed"].includes(record.state),
  );
  const [api, edge, vbtechWeb] = await Promise.all([
    inspectService("api", markiroRecords, vbtechRecords, dependencies),
    inspectService("edge", markiroRecords, vbtechRecords, dependencies),
    inspectService("vbtech-web", markiroRecords, vbtechRecords, dependencies),
  ]);
  return {
    version: 3,
    docker: boundedStatus(dockerResult.stdout.trim()),
    runtimeEnv: boundedStatus(runtimeEnvResult.stdout.trim()),
    activeRelease: active,
    candidateRelease: candidate?.tag ?? "unknown",
    composeNetwork: network,
    resources,
    activeVbtech: activeVbtech(vbtechRecords),
    api,
    edge,
    vbtechWeb,
  };
}

function validRelease(value) {
  return value === "unknown" || (typeof value === "string" && RELEASE_SHA.test(value));
}

function validService(value) {
  return (
    hasExactKeys(
      value,
      "configurationIssues,errorClasses,exitCode,health,oomKilled,release,state",
    ) &&
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

function validResources(value) {
  return (
    hasExactKeys(
      value,
      "cpuBusyBasisPoints,memoryAvailableBytes,memoryTotalBytes,rootFilesystemAvailableBytes,rootFilesystemTotalBytes",
    ) &&
    Number.isSafeInteger(value.cpuBusyBasisPoints) &&
    value.cpuBusyBasisPoints >= 0 &&
    value.cpuBusyBasisPoints <= 10_000 &&
    Number.isSafeInteger(value.memoryTotalBytes) &&
    value.memoryTotalBytes > 0 &&
    Number.isSafeInteger(value.memoryAvailableBytes) &&
    value.memoryAvailableBytes >= 0 &&
    value.memoryAvailableBytes <= value.memoryTotalBytes &&
    Number.isSafeInteger(value.rootFilesystemTotalBytes) &&
    value.rootFilesystemTotalBytes > 0 &&
    Number.isSafeInteger(value.rootFilesystemAvailableBytes) &&
    value.rootFilesystemAvailableBytes >= 0 &&
    value.rootFilesystemAvailableBytes <= value.rootFilesystemTotalBytes
  );
}

function validActiveVbtech(value) {
  return (
    value === null ||
    (hasExactKeys(value, "imageDigest,releaseSha") &&
      RELEASE_SHA.test(value.releaseSha) &&
      DIGEST.test(value.imageDigest))
  );
}

export function validateRuntimeSnapshot(value) {
  if (
    !hasExactKeys(
      value,
      "activeRelease,activeVbtech,api,candidateRelease,composeNetwork,docker,edge,resources,runtimeEnv,vbtechWeb,version",
    ) ||
    value.version !== 3 ||
    !["active", "inactive", "failed", "unknown"].includes(value.docker) ||
    !["active", "inactive", "failed", "unknown"].includes(value.runtimeEnv) ||
    !validRelease(value.activeRelease) ||
    !validRelease(value.candidateRelease) ||
    typeof value.composeNetwork !== "string" ||
    !SAFE_NETWORK_NAME.test(value.composeNetwork) ||
    !validResources(value.resources) ||
    !validActiveVbtech(value.activeVbtech) ||
    !validService(value.api) ||
    !validService(value.edge) ||
    !validService(value.vbtechWeb)
  )
    throw invalidDiagnostics();
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

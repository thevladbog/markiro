import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";
import {
  authenticatedKnownHosts,
  publicIpv4,
  runCommand,
  runCommandWithStatus,
  validateHostedPrivateKey,
} from "./remote-deploy.mjs";

const MAX_RESPONSE_BYTES = 8 * 1024;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const METHODS = Object.freeze([
  "categories",
  "categories-repeat",
  "attributes",
  "feed-product",
  "product",
  "product-repeat",
]);
const OUTCOMES = Object.freeze([
  "ok",
  "not_modified",
  "unauthorized",
  "forbidden",
  "not_found",
  "rate_limited",
  "invalid_response",
  "unavailable",
]);
const SOURCE_STATUSES = Object.freeze([
  "ready",
  "encryption-key-missing",
  "active-token-query-failed",
  "active-token-missing",
  "active-token-ambiguous",
  "product-query-failed",
  "product-gtin-unavailable",
  "token-decryption-failed",
]);
const CAPABILITY_STATES = Object.freeze(["available", "unavailable", "not_checked"]);
const CONTRACT_STATUSES = Object.freeze(["conformant", "degraded"]);
const CACHE_OBSERVATIONS = Object.freeze([
  "not_checked",
  "etag_present",
  "etag_missing",
  "not_modified",
  "same_hash",
  "changed_hash",
]);
const VIOLATION_CAPABILITIES = Object.freeze([
  "source",
  "schema_read",
  "owned_card_read",
  "published_card_read",
]);
const VIOLATION_CODES = Object.freeze([
  "source_unavailable",
  "schema_read_failed",
  "owned_card_read_failed",
  "published_card_read_failed",
  "cache_contract_degraded",
  "usage_headers_missing",
]);
const FAILURE_STAGES = Object.freeze([
  "configuration",
  "credential-validation",
  "workspace-setup",
  "api-container-discovery-transport",
  "api-container-discovery",
  "api-cli-transport",
  "api-cli-exit",
  "api-cli-evidence-missing",
  "api-cli-evidence-invalid",
  "api-cli-exit-mismatch",
  "cleanup",
  "unknown",
]);

class NationalCatalogDiagnosticStageError extends Error {
  constructor(stage, cause) {
    super(cause instanceof Error ? cause.message : "National Catalog diagnostic failed", { cause });
    this.name = "NationalCatalogDiagnosticStageError";
    this.stage = FAILURE_STAGES.includes(stage) ? stage : "unknown";
  }
}

async function atFailureStage(stage, operation) {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof NationalCatalogDiagnosticStageError) throw cause;
    throw new NationalCatalogDiagnosticStageError(stage, cause);
  }
}

function diagnosticFailureStage(error) {
  const stage = error instanceof NationalCatalogDiagnosticStageError ? error.stage : "unknown";
  return FAILURE_STAGES.includes(stage) ? stage : "unknown";
}

function invalidResponse() {
  return new Error("National Catalog diagnostic response is invalid");
}

function requiredEnvironment(name, environment) {
  const value = environment[name];
  if (!value) throw new Error("National Catalog diagnostic configuration is incomplete");
  return value;
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys
  );
}

function validCheck(value) {
  if (
    !hasExactKeys(value, "cacheObservation,method,outcome,resultCount,usagePresent") ||
    !METHODS.includes(value.method) ||
    !OUTCOMES.includes(value.outcome) ||
    !CACHE_OBSERVATIONS.includes(value.cacheObservation) ||
    !Number.isSafeInteger(value.resultCount) ||
    value.resultCount < 0 ||
    value.resultCount > 1_000_000 ||
    typeof value.usagePresent !== "boolean"
  ) {
    return false;
  }
  const repeat = value.method === "categories-repeat" || value.method === "product-repeat";
  const cachePrimary = value.method === "categories" || value.method === "product";
  if (value.outcome === "ok") {
    if (repeat && !["same_hash", "changed_hash"].includes(value.cacheObservation)) return false;
    if (cachePrimary && !["etag_present", "etag_missing"].includes(value.cacheObservation))
      return false;
    if (!repeat && !cachePrimary && value.cacheObservation !== "not_checked") return false;
    return true;
  }
  if (value.resultCount !== 0 || value.usagePresent) return false;
  if (value.outcome === "not_modified") {
    return repeat && value.cacheObservation === "not_modified";
  }
  return value.cacheObservation === "not_checked";
}

function validCheckSequence(checks) {
  if (checks.length < 4 || checks.length > METHODS.length || !checks.every(validCheck))
    return false;
  let previousIndex = -1;
  for (const check of checks) {
    const index = METHODS.indexOf(check.method);
    if (index <= previousIndex) return false;
    previousIndex = index;
  }
  for (const required of ["categories", "attributes", "feed-product", "product"]) {
    if (!checks.some((check) => check.method === required)) return false;
  }
  const byMethod = new Map(checks.map((check) => [check.method, check]));
  if (
    (byMethod.has("categories-repeat") && byMethod.get("categories")?.outcome !== "ok") ||
    (byMethod.has("product-repeat") && byMethod.get("product")?.outcome !== "ok")
  ) {
    return false;
  }
  return true;
}

function validCapabilities(value, sourceReady) {
  if (!hasExactKeys(value, "ownedCardRead,publishedCardRead,schemaRead")) return false;
  const states = [value.schemaRead, value.ownedCardRead, value.publishedCardRead];
  return (
    states.every((state) => CAPABILITY_STATES.includes(state)) &&
    (sourceReady
      ? states.every((state) => state !== "not_checked")
      : states.every((state) => state === "not_checked"))
  );
}

function validViolation(value) {
  return (
    hasExactKeys(value, "capability,code") &&
    VIOLATION_CAPABILITIES.includes(value.capability) &&
    VIOLATION_CODES.includes(value.code)
  );
}

function validateEvidence(value) {
  const sourceReady = value?.sourceStatus === "ready";
  if (
    !hasExactKeys(
      value,
      "capabilities,checks,contractStatus,passed,sourceStatus,version,violations",
    ) ||
    value.version !== 3 ||
    typeof value.passed !== "boolean" ||
    !SOURCE_STATUSES.includes(value.sourceStatus) ||
    !CONTRACT_STATUSES.includes(value.contractStatus) ||
    !validCapabilities(value.capabilities, sourceReady) ||
    !Array.isArray(value.checks) ||
    !Array.isArray(value.violations) ||
    value.violations.length > 32 ||
    !value.violations.every(validViolation) ||
    (value.contractStatus === "conformant"
      ? value.violations.length !== 0
      : value.violations.length === 0) ||
    (sourceReady
      ? !validCheckSequence(value.checks)
      : value.passed ||
        value.contractStatus !== "degraded" ||
        value.checks.length !== 0 ||
        value.violations.length !== 1 ||
        value.violations[0].capability !== "source" ||
        value.violations[0].code !== "source_unavailable")
  )
    throw invalidResponse();
  return value;
}

function parseContainer(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 1024)
    throw invalidResponse();
  const match = output.match(/^([0-9a-f]{12,64})\n$/);
  if (!match || !CONTAINER_ID.test(match[1])) throw invalidResponse();
  return match[1];
}

function parseEvidence(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > MAX_RESPONSE_BYTES)
    throw invalidResponse();
  const match = output.match(/^MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS (\{[^\n]+\})\n$/);
  if (!match) throw invalidResponse();
  try {
    return validateEvidence(JSON.parse(match[1]));
  } catch {
    throw invalidResponse();
  }
}

export async function runHostedNationalCatalogDiagnostics(
  environment = process.env,
  supplied = {},
) {
  const system = {
    mkdtemp,
    writeFile,
    rm,
    validatePrivateKey: (path) => validateHostedPrivateKey(path, { readFile, stat }),
    run: (command, args, options) => runCommand(command, args, options),
    runDiagnostic: (command, args, options) => runCommandWithStatus(command, args, options),
    ...supplied,
  };
  const { address, identity, knownHosts, login } = await atFailureStage(
    "configuration",
    async () => {
      const configuredAddress = publicIpv4(
        requiredEnvironment("YC_APP_PUBLIC_ADDRESS", environment),
      );
      const configuredLogin = requiredEnvironment("YC_APP_DEPLOY_LOGIN", environment);
      if (configuredLogin !== "markiro-deploy")
        throw new Error("National Catalog diagnostic configuration is incomplete");
      const configuredIdentity = requiredEnvironment(
        "YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH",
        environment,
      );
      return {
        address: configuredAddress,
        identity: configuredIdentity,
        knownHosts: authenticatedKnownHosts(
          requiredEnvironment("APP_SSH_HOST_KEYS_B64", environment),
          configuredAddress,
        ),
        login: configuredLogin,
      };
    },
  );
  await atFailureStage("credential-validation", () => system.validatePrivateKey(identity));

  const directory = await atFailureStage("workspace-setup", () =>
    system.mkdtemp(join(tmpdir(), "markiro-national-catalog-diagnostics-")),
  );
  let failure;
  let result;
  try {
    const knownHostsPath = join(directory, "known_hosts");
    await atFailureStage("workspace-setup", () =>
      system.writeFile(knownHostsPath, knownHosts, { encoding: "utf8", mode: 0o600 }),
    );
    const sshBase = [
      "-F",
      "/dev/null",
      "-i",
      identity,
      "-o",
      `UserKnownHostsFile=${knownHostsPath}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      `${login}@${address}`,
    ];
    const containerOutput = await atFailureStage("api-container-discovery-transport", () =>
      system.run("ssh", [
        ...sshBase,
        "sudo",
        "/usr/local/bin/docker",
        "ps",
        "-q",
        "--filter",
        "label=com.docker.compose.project=markiro-production",
        "--filter",
        "label=com.docker.compose.service=api",
      ]),
    );
    const containerId = await atFailureStage("api-container-discovery", async () =>
      parseContainer(containerOutput),
    );
    const execution = await atFailureStage("api-cli-transport", () =>
      system.runDiagnostic("ssh", [
        ...sshBase,
        "sudo",
        "/usr/local/bin/docker",
        "exec",
        "-i",
        containerId,
        "node",
        "dist/national-catalog-live-diagnostic.js",
      ]),
    );
    if (!hasExactKeys(execution, "exitCode,stdout") || typeof execution.stdout !== "string")
      throw new NationalCatalogDiagnosticStageError("api-cli-evidence-invalid", invalidResponse());
    if (![0, 1].includes(execution.exitCode))
      throw new NationalCatalogDiagnosticStageError("api-cli-exit", invalidResponse());
    if (execution.stdout.length === 0)
      throw new NationalCatalogDiagnosticStageError("api-cli-evidence-missing", invalidResponse());
    result = await atFailureStage("api-cli-evidence-invalid", async () =>
      parseEvidence(execution.stdout),
    );
    if (execution.exitCode !== (result.passed ? 0 : 1))
      throw new NationalCatalogDiagnosticStageError("api-cli-exit-mismatch", invalidResponse());
  } catch (error) {
    failure = error;
  }

  let cleanupFailure;
  try {
    await system.rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure = new NationalCatalogDiagnosticStageError("cleanup", error);
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return result;
}

export async function runNationalCatalogDiagnosticsCli(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const argv = options.argv ?? process.argv.slice(2);
    if (argv.length !== 1 || argv[0] !== "run") throw new Error();
    const result = await (options.runDiagnostics ?? runHostedNationalCatalogDiagnostics)(
      options.environment ?? process.env,
      options.supplied ?? {},
    );
    stdout.write(`MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(result)}\n`);
    return result.passed ? 0 : 1;
  } catch (error) {
    stderr.write(
      `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS_FAILURE ${JSON.stringify({ stage: diagnosticFailureStage(error) })}\n`,
    );
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runNationalCatalogDiagnosticsCli();
}

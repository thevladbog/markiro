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
const FAILURE_STAGES = Object.freeze([
  "configuration",
  "credential-validation",
  "workspace-setup",
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

function validCheck(value, index) {
  return (
    hasExactKeys(value, "etagPresent,method,outcome,resultCount") &&
    value.method === METHODS[index] &&
    OUTCOMES.includes(value.outcome) &&
    Number.isSafeInteger(value.resultCount) &&
    value.resultCount >= 0 &&
    value.resultCount <= 1_000_000 &&
    typeof value.etagPresent === "boolean" &&
    (value.outcome === "ok" || (value.etagPresent === false && value.resultCount === 0))
  );
}

function evidencePassed(checks) {
  return (
    checks.length === METHODS.length &&
    checks[0].outcome === "ok" &&
    checks[0].etagPresent === true &&
    checks[1].outcome === "not_modified" &&
    checks[2].outcome === "ok" &&
    checks[3].outcome === "ok" &&
    checks[3].resultCount === 1 &&
    checks[4].outcome === "ok" &&
    checks[4].resultCount === 1 &&
    checks[4].etagPresent === true &&
    checks[5].outcome === "not_modified"
  );
}

function checkAllowsContinuation(check, index) {
  if (index === 0) return check.outcome === "ok" && check.etagPresent === true;
  if (index === 1) return check.outcome === "not_modified";
  if (index === 2) return check.outcome === "ok";
  if (index === 3) return check.outcome === "ok" && check.resultCount === 1;
  if (index === 4)
    return check.outcome === "ok" && check.resultCount === 1 && check.etagPresent === true;
  return false;
}

function isCanonicalPrefix(checks) {
  if (checks.length === 0) return false;
  for (let index = 0; index < checks.length - 1; index += 1) {
    if (!checkAllowsContinuation(checks[index], index)) return false;
  }
  return (
    checks.length === METHODS.length ||
    !checkAllowsContinuation(checks[checks.length - 1], checks.length - 1)
  );
}

function validateEvidence(value) {
  const sourceReady = value?.sourceStatus === "ready";
  if (
    !hasExactKeys(value, "checks,passed,sourceStatus,version") ||
    value.version !== 2 ||
    typeof value.passed !== "boolean" ||
    !SOURCE_STATUSES.includes(value.sourceStatus) ||
    !Array.isArray(value.checks) ||
    value.checks.length > METHODS.length ||
    !value.checks.every(validCheck) ||
    (sourceReady ? !isCanonicalPrefix(value.checks) : value.checks.length !== 0) ||
    value.passed !== (sourceReady && evidencePassed(value.checks))
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
    const containerId = await atFailureStage("api-container-discovery", async () => {
      const containerOutput = await system.run("ssh", [
        ...sshBase,
        "sudo",
        "/usr/bin/docker",
        "ps",
        "-q",
        "--filter",
        "label=com.docker.compose.project=markiro-production",
        "--filter",
        "label=com.docker.compose.service=api",
      ]);
      return parseContainer(containerOutput);
    });
    const execution = await atFailureStage("api-cli-transport", () =>
      system.runDiagnostic("ssh", [
        ...sshBase,
        "sudo",
        "/usr/bin/docker",
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

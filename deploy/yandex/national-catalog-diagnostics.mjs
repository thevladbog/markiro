import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";
import {
  authenticatedKnownHosts,
  publicIpv4,
  runCommand,
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

function validateEvidence(value) {
  if (
    !hasExactKeys(value, "checks,passed,version") ||
    value.version !== 1 ||
    typeof value.passed !== "boolean" ||
    !Array.isArray(value.checks) ||
    value.checks.length > METHODS.length ||
    !value.checks.every(validCheck) ||
    value.passed !== evidencePassed(value.checks)
  )
    throw invalidResponse();
  return value;
}

function parseContainer(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 1024)
    throw invalidResponse();
  const match = output.match(/^([0-9a-f]{12,64})\tapi\n$/);
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
    ...supplied,
  };
  const address = publicIpv4(requiredEnvironment("YC_APP_PUBLIC_ADDRESS", environment));
  const login = requiredEnvironment("YC_APP_DEPLOY_LOGIN", environment);
  if (login !== "markiro-deploy")
    throw new Error("National Catalog diagnostic configuration is incomplete");
  const identity = requiredEnvironment("YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH", environment);
  const knownHosts = authenticatedKnownHosts(
    requiredEnvironment("APP_SSH_HOST_KEYS_B64", environment),
    address,
  );
  await system.validatePrivateKey(identity);

  const directory = await system.mkdtemp(join(tmpdir(), "markiro-national-catalog-diagnostics-"));
  let failure;
  let result;
  try {
    const knownHostsPath = join(directory, "known_hosts");
    await system.writeFile(knownHostsPath, knownHosts, { encoding: "utf8", mode: 0o600 });
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
    const containerOutput = await system.run("ssh", [
      ...sshBase,
      "sudo",
      "/usr/bin/docker",
      "ps",
      "--filter",
      "label=com.docker.compose.project=markiro-production",
      "--filter",
      "label=com.docker.compose.service=api",
      "--format",
      '{{.ID}}\t{{.Label "com.docker.compose.service"}}',
    ]);
    const containerId = parseContainer(containerOutput);
    const output = await system.run("ssh", [
      ...sshBase,
      "sudo",
      "/usr/bin/docker",
      "exec",
      "-i",
      containerId,
      "node",
      "dist/national-catalog-live-diagnostic.js",
    ]);
    result = parseEvidence(output);
  } catch (error) {
    failure = error;
  }

  let cleanupFailure;
  try {
    await system.rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure = error;
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
  } catch {
    stderr.write("MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS_FAILURE\n");
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runNationalCatalogDiagnosticsCli();
}

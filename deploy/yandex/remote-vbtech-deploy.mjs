import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  validateProductionDomains,
  validateVbtechDomains,
} from "../production/production-domain.mjs";
import { isMainModule } from "./cli-main.mjs";
import { registryCredentials } from "./registry-auth.mjs";
import {
  authenticatedKnownHosts,
  publicIpv4,
  runCommand,
  validateHostedPrivateKey,
} from "./remote-deploy.mjs";

const ACTIVE_RELEASE_DIRECTORY = "/opt/markiro/active-release";
const ACTIVE_EXECUTOR = `${ACTIVE_RELEASE_DIRECTORY}/deploy/production/vbtech-deploy.mjs`;
const EXECUTOR_CONTRACT = "MARKIRO_VBTECH_EXECUTOR 1\n";
const HEALTHY_RESULT = "MARKIRO_VBTECH_DEPLOY_HEALTHY\n";
const VBTECH_REPOSITORY = "ghcr.io/thevladbog/vbtech-web";
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_HOST_KEYS_BYTES = 16 * 1024;
const VBTECH_DEPLOYMENT_STAGES = new Set([
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
const VBTECH_ROLLBACK_STAGES = new Set([
  "rollback-service",
  "rollback-health",
  "rollback-edge",
  "rollback-readiness",
  "rollback-smoke",
  "failed-record",
]);
const ALLOWED_VBTECH_INPUTS = new Set([
  "VBTECH_IMAGE_DIGEST",
  "VBTECH_IMAGE_REF",
  "VBTECH_RELEASE_SHA",
]);
const ALLOWED_MARKIRO_INPUTS = new Set([
  "MARKIRO_DOMAIN",
  "MARKIRO_SAAS_ADMIN_DOMAIN",
  "MARKIRO_KIOSK_DOMAIN",
  "MARKIRO_LANDING_DOMAIN",
]);

class ExecutorBootstrapRequiredError extends Error {
  constructor() {
    super("v-b executor bootstrap is required");
    this.name = "ExecutorBootstrapRequiredError";
  }
}

class RemoteVbtechStageError extends Error {
  constructor(stage, rollbackStage) {
    super("hosted v-b deployment failed");
    this.name = "RemoteVbtechStageError";
    this.stage = stage;
    this.rollbackStage = rollbackStage;
  }
}

function executorFailureReport(value) {
  const match =
    typeof value === "string"
      ? value.match(/^MARKIRO_VBTECH_DEPLOY_FAILURE ([a-z-]+)(?: ROLLBACK ([a-z-]+))?\n$/)
      : null;
  if (
    !match ||
    !VBTECH_DEPLOYMENT_STAGES.has(match[1]) ||
    (match[2] !== undefined && !VBTECH_ROLLBACK_STAGES.has(match[2]))
  )
    return undefined;
  return { stage: match[1], rollbackStage: match[2] };
}

function configurationError() {
  return new Error("hosted v-b deployment configuration is invalid");
}

function acmeEmail(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(value)
  )
    throw configurationError();
  return value;
}

function requiredEnvironment(name, environment) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) throw configurationError();
  return value;
}

function validateHostedInput(environment) {
  try {
    if (!environment || typeof environment !== "object" || Array.isArray(environment))
      throw configurationError();
    if (
      Object.keys(environment).some(
        (key) => key.startsWith("VBTECH_") && !ALLOWED_VBTECH_INPUTS.has(key),
      ) ||
      Object.keys(environment).some(
        (key) => key.startsWith("MARKIRO_") && !ALLOWED_MARKIRO_INPUTS.has(key),
      ) ||
      Object.hasOwn(environment, "DOCKER_CONFIG")
    )
      throw configurationError();

    const releaseSha = requiredEnvironment("VBTECH_RELEASE_SHA", environment);
    const imageDigest = requiredEnvironment("VBTECH_IMAGE_DIGEST", environment);
    if (!RELEASE_SHA_PATTERN.test(releaseSha) || !IMAGE_DIGEST_PATTERN.test(imageDigest))
      throw configurationError();
    const imageRef = `${VBTECH_REPOSITORY}@${imageDigest}`;
    if (Object.hasOwn(environment, "VBTECH_IMAGE_REF") && environment.VBTECH_IMAGE_REF !== imageRef)
      throw configurationError();

    const { domain, saasAdminDomain, kioskDomain, landingDomain } = validateProductionDomains(
      requiredEnvironment("MARKIRO_DOMAIN", environment),
      requiredEnvironment("MARKIRO_SAAS_ADMIN_DOMAIN", environment),
      requiredEnvironment("MARKIRO_KIOSK_DOMAIN", environment),
      requiredEnvironment("MARKIRO_LANDING_DOMAIN", environment),
    );
    validateVbtechDomains("v-b.tech", "www.v-b.tech", [
      domain,
      saasAdminDomain,
      kioskDomain,
      landingDomain,
    ]);
    const address = publicIpv4(requiredEnvironment("YC_APP_PUBLIC_ADDRESS", environment));
    const login = requiredEnvironment("YC_APP_DEPLOY_LOGIN", environment);
    if (login !== "markiro-deploy") throw configurationError();
    const identity = requiredEnvironment("YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH", environment);
    const encodedHostKeys = requiredEnvironment("APP_SSH_HOST_KEYS_B64", environment);
    if (Buffer.byteLength(encodedHostKeys, "utf8") > MAX_HOST_KEYS_BYTES)
      throw configurationError();
    const knownHosts = authenticatedKnownHosts(encodedHostKeys, address);
    if (Buffer.byteLength(knownHosts, "utf8") > MAX_HOST_KEYS_BYTES) throw configurationError();
    const registryPayload = {
      entries: [
        {
          key: "GHCR_USERNAME",
          textValue: requiredEnvironment("GHCR_USERNAME", environment),
        },
        { key: "GHCR_TOKEN", textValue: requiredEnvironment("GHCR_TOKEN", environment) },
      ],
    };
    registryCredentials(registryPayload);
    const registryInput = `${JSON.stringify(registryPayload)}\n`;
    if (Buffer.byteLength(registryInput, "utf8") > 512 * 1024) throw configurationError();

    return {
      acmeEmail: acmeEmail(requiredEnvironment("ACME_EMAIL", environment)),
      address,
      domain,
      identity,
      imageDigest,
      imageRef,
      kioskDomain,
      knownHosts,
      landingDomain,
      login,
      registryInput,
      releaseSha,
      saasAdminDomain,
    };
  } catch {
    throw configurationError();
  }
}

function sshArguments(input, knownHostsPath) {
  return [
    "-F",
    "/dev/null",
    "-i",
    input.identity,
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    `${input.login}@${input.address}`,
  ];
}

function executorEnvironmentArguments(input) {
  return [
    "MARKIRO_COMPOSE_PROJECT=markiro-production",
    "MARKIRO_ENV_FILE=/etc/markiro/production.env",
    `MARKIRO_DOMAIN=${input.domain}`,
    `MARKIRO_SAAS_ADMIN_DOMAIN=${input.saasAdminDomain}`,
    `MARKIRO_KIOSK_DOMAIN=${input.kioskDomain}`,
    `MARKIRO_LANDING_DOMAIN=${input.landingDomain}`,
    `ACME_EMAIL=${input.acmeEmail}`,
    `VBTECH_RELEASE_SHA=${input.releaseSha}`,
    `VBTECH_IMAGE_DIGEST=${input.imageDigest}`,
    `VBTECH_IMAGE_REF=${input.imageRef}`,
    "VBTECH_DOMAIN=v-b.tech",
    "VBTECH_WWW_DOMAIN=www.v-b.tech",
    "VBTECH_SUBMISSION_STATE=disabled",
  ];
}

async function requireActiveExecutor(system, sshBase) {
  let output;
  try {
    output = await system.run(
      "/usr/bin/ssh",
      [
        ...sshBase,
        "sudo",
        "/usr/bin/timeout",
        "--signal=TERM",
        "--kill-after=5s",
        "30s",
        "/usr/bin/node",
        ACTIVE_EXECUTOR,
        "contract-version",
      ],
      { env: {} },
    );
  } catch {
    throw new ExecutorBootstrapRequiredError();
  }
  if (output !== EXECUTOR_CONTRACT) throw new ExecutorBootstrapRequiredError();
}

async function runActiveExecutor(system, input, sshBase) {
  const output = await system.run(
    "/usr/bin/ssh",
    [
      ...sshBase,
      "sudo",
      "/usr/bin/timeout",
      "--signal=TERM",
      "--kill-after=30s",
      "16m",
      "/usr/bin/systemd-run",
      "--quiet",
      "--wait",
      "--pipe",
      "--collect",
      "--property=Requires=markiro-runtime-env.service",
      "--property=After=markiro-runtime-env.service",
      "--property=RuntimeMaxSec=15min",
      "--property=TimeoutStopSec=30s",
      `--working-directory=${ACTIVE_RELEASE_DIRECTORY}`,
      "/usr/bin/env",
      ...executorEnvironmentArguments(input),
      "/usr/bin/node",
      "/usr/local/lib/markiro/registry-auth.mjs",
      "run-stdin-vbtech-report",
      "/usr/bin/node",
      ACTIVE_EXECUTOR,
      "run",
    ],
    { env: {}, input: input.registryInput },
  );
  if (output === HEALTHY_RESULT) return;
  const report = executorFailureReport(output);
  if (report) throw new RemoteVbtechStageError(report.stage, report.rollbackStage);
  throw new Error("hosted v-b deployment failed");
}

export async function runHostedVbtechDeploy(environment = process.env, supplied = {}) {
  const system = {
    mkdtemp,
    readFile,
    rm,
    run: runCommand,
    stat,
    writeFile,
    ...supplied,
  };
  const input = validateHostedInput(environment);
  await validateHostedPrivateKey(input.identity, system);

  const directory = await system.mkdtemp(join(tmpdir(), "markiro-vbtech-ssh-"));
  let primaryFailure;
  try {
    const knownHostsPath = join(directory, "known_hosts");
    await system.writeFile(knownHostsPath, input.knownHosts, { encoding: "utf8", mode: 0o600 });
    const sshBase = sshArguments(input, knownHostsPath);
    await requireActiveExecutor(system, sshBase);
    await runActiveExecutor(system, input, sshBase);
  } catch (error) {
    primaryFailure = error;
  }

  let cleanupFailure;
  try {
    await system.rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure = error;
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
}

export async function runRemoteVbtechDeployCli(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "run") throw new Error();
    await (options.runDeployment ?? runHostedVbtechDeploy)(
      options.environment ?? process.env,
      options.supplied ?? {},
    );
    stdout.write(HEALTHY_RESULT);
    return 0;
  } catch (error) {
    stderr.write(
      error instanceof ExecutorBootstrapRequiredError
        ? "MARKIRO_VBTECH_EXECUTOR_BOOTSTRAP_REQUIRED an executor-bearing Markiro release must be deployed first\n"
        : error instanceof RemoteVbtechStageError
          ? `MARKIRO_VBTECH_REMOTE_DEPLOY_FAILURE ${error.stage}${error.rollbackStage === undefined ? "" : ` ROLLBACK ${error.rollbackStage}`}\n`
          : "MARKIRO_VBTECH_REMOTE_DEPLOY_FAILURE\n",
    );
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runRemoteVbtechDeployCli();
}

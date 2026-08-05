import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";

const DEPLOYMENT_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
const DEPLOYMENT_LABEL_PREFIX = "markiro-deployment-";
const HOST_KEY_MARKER = "MARKIRO_SSH_HOST_KEY_V1";
const HOST_KEY_ALGORITHMS = ["ssh-ed25519", "ssh-rsa"];
const MAX_OPERATION_ID_BYTES = 256;

function requireDependencies(dependencies) {
  if (
    !dependencies ||
    typeof dependencies.deploymentId !== "string" ||
    !DEPLOYMENT_ID.test(dependencies.deploymentId) ||
    typeof dependencies.instanceId !== "string" ||
    dependencies.instanceId.length === 0 ||
    typeof dependencies.yandex?.getInstanceStatus !== "function" ||
    typeof dependencies.yandex?.startInstance !== "function" ||
    typeof dependencies.yandex?.stopInstance !== "function" ||
    typeof dependencies.github?.listRunners !== "function" ||
    typeof dependencies.github?.deleteRunner !== "function"
  )
    throw new Error("invalid runner controller dependencies");
}

function labelsOf(runner) {
  if (!Array.isArray(runner?.labels)) return [];
  return runner.labels.map((label) => (typeof label === "string" ? label : label?.name));
}

function deploymentRunners(runners) {
  return runners.filter((runner) =>
    labelsOf(runner).some(
      (label) => typeof label === "string" && label.startsWith(DEPLOYMENT_LABEL_PREFIX),
    ),
  );
}

export function selectCleanupRunners(runners, { deploymentId, runnerId } = {}) {
  if (!Array.isArray(runners)) throw new Error("invalid GitHub runner response");
  const registered = deploymentRunners(runners);
  if (runnerId || deploymentId) {
    const exactLabel = deploymentId ? deploymentRunnerLabel(deploymentId) : undefined;
    return registered.filter(
      (runner) =>
        (runnerId && String(runner.id) === String(runnerId)) ||
        (exactLabel && labelsOf(runner).includes(exactLabel)),
    );
  }
  if (registered.length > 1)
    throw new Error("cannot safely identify the deployment runner during cleanup");
  return registered;
}

export function deploymentRunnerLabel(deploymentId) {
  if (typeof deploymentId !== "string" || !DEPLOYMENT_ID.test(deploymentId))
    throw new Error("invalid deployment ID");
  return `${DEPLOYMENT_LABEL_PREFIX}${deploymentId}`;
}

export async function createJitRegistration(dependencies) {
  if (
    !dependencies ||
    typeof dependencies.instanceId !== "string" ||
    typeof dependencies.github?.generateJitConfig !== "function" ||
    typeof dependencies.yandex?.updateMetadata !== "function"
  )
    throw new Error("invalid JIT registration dependencies");
  const label = deploymentRunnerLabel(dependencies.deploymentId);
  const request = {
    name: `markiro-${dependencies.deploymentId}`,
    runner_group_id: 1,
    labels: ["self-hosted", "linux", label],
    work_folder: "_work",
  };
  const response = await dependencies.github.generateJitConfig(request);
  const responseLabels = labelsOf(response?.runner);
  if (
    response?.runner?.name !== request.name ||
    !request.labels.every((expected) => responseLabels.includes(expected)) ||
    typeof response?.encoded_jit_config !== "string" ||
    response.encoded_jit_config.length === 0 ||
    response.encoded_jit_config.length > 256 * 1024
  )
    throw new Error("invalid JIT registration response");
  await dependencies.yandex.updateMetadata(dependencies.instanceId, {
    upsert: { "markiro-runner-jit": response.encoded_jit_config },
  });
  return { deploymentId: dependencies.deploymentId, label };
}

function validateOperation(operation, expectedId) {
  const hasError = operation && Object.hasOwn(operation, "error");
  const hasResponse = operation && Object.hasOwn(operation, "response");
  if (
    !operation ||
    typeof operation !== "object" ||
    Array.isArray(operation) ||
    typeof operation.id !== "string" ||
    operation.id.length === 0 ||
    Buffer.byteLength(operation.id, "utf8") > MAX_OPERATION_ID_BYTES ||
    operation.id.trim() !== operation.id ||
    /\s/u.test(operation.id) ||
    (expectedId !== undefined && operation.id !== expectedId) ||
    typeof operation.done !== "boolean" ||
    (!operation.done && (hasError || hasResponse)) ||
    (operation.done && hasError === hasResponse) ||
    (hasError &&
      (!operation.error ||
        typeof operation.error !== "object" ||
        Array.isArray(operation.error))) ||
    (hasResponse &&
      (!operation.response ||
        typeof operation.response !== "object" ||
        Array.isArray(operation.response)))
  )
    throw new Error("invalid Yandex operation response");
  if (hasError) throw new Error("Yandex operation failed");
  return operation;
}

export async function waitForOperation(initialOperation, dependencies) {
  if (!dependencies || typeof dependencies.getOperation !== "function")
    throw new Error("invalid Yandex operation dependencies");
  const timeoutMs = dependencies.timeoutMs ?? 60_000;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 1_000;
  const now = dependencies.clock?.now ?? (() => performance.now());
  const sleep =
    dependencies.clock?.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs <= 0
  )
    throw new Error("invalid Yandex operation bounds");

  let operation = validateOperation(initialOperation);
  const operationId = operation.id;
  const deadline = now() + timeoutMs;
  while (!operation.done) {
    if (now() >= deadline) throw new Error("Yandex operation timed out");
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
    operation = validateOperation(await dependencies.getOperation(operationId), operationId);
  }
  return operation;
}

function decodeBase64(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1)
    throw new Error("authenticated SSH host keys are invalid");
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length === 0 ||
    decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
  )
    throw new Error("authenticated SSH host keys are invalid");
  return decoded;
}

function readSshField(payload, cursor) {
  if (cursor + 4 > payload.length) throw new Error("authenticated SSH host keys are invalid");
  const length = payload.readUInt32BE(cursor);
  const start = cursor + 4;
  const end = start + length;
  if (end > payload.length) throw new Error("authenticated SSH host keys are invalid");
  return { bytes: payload.subarray(start, end), cursor: end };
}

function validMpint(value) {
  return (
    value.length > 0 &&
    (value[0] & 0x80) === 0 &&
    !(value.length > 1 && value[0] === 0 && (value[1] & 0x80) === 0)
  );
}

function canonicalPublicKey(key) {
  const parts = key.split(" ");
  if (parts.length !== 2 || !HOST_KEY_ALGORITHMS.includes(parts[0]))
    throw new Error("authenticated SSH host keys are invalid");
  const algorithm = parts[0];
  const payload = decodeBase64(parts[1]);
  const name = readSshField(payload, 0);
  if (name.bytes.toString("utf8") !== algorithm)
    throw new Error("authenticated SSH host keys are invalid");
  if (algorithm === "ssh-ed25519") {
    const publicKey = readSshField(payload, name.cursor);
    if (publicKey.bytes.length !== 32 || publicKey.cursor !== payload.length)
      throw new Error("authenticated SSH host keys are invalid");
  } else {
    const exponent = readSshField(payload, name.cursor);
    const modulus = readSshField(payload, exponent.cursor);
    if (
      !validMpint(exponent.bytes) ||
      !validMpint(modulus.bytes) ||
      modulus.cursor !== payload.length
    )
      throw new Error("authenticated SSH host keys are invalid");
  }
  return `${algorithm} ${payload.toString("base64")}`;
}

function canonicalHostKeyPair(keys) {
  if (keys.length !== HOST_KEY_ALGORITHMS.length)
    throw new Error("authenticated SSH host keys are invalid");
  const canonical = keys.map(canonicalPublicKey);
  const byAlgorithm = new Map(canonical.map((key) => [key.slice(0, key.indexOf(" ")), key]));
  if (byAlgorithm.size !== HOST_KEY_ALGORITHMS.length)
    throw new Error("authenticated SSH host keys are invalid");
  return HOST_KEY_ALGORITHMS.map((algorithm) => {
    const key = byAlgorithm.get(algorithm);
    if (!key) throw new Error("authenticated SSH host keys are invalid");
    return key;
  });
}

export function parseSerialHostKeys(serialOutput) {
  if (typeof serialOutput !== "string") throw new Error("authenticated SSH host keys are invalid");
  const markerLines = serialOutput
    .split("\n")
    .filter((line) => line.includes("MARKIRO_SSH_HOST_KEY"));
  const keys = markerLines.map((line) => {
    const match = line.match(
      new RegExp(`^${HOST_KEY_MARKER} (ssh-(?:ed25519|rsa) [A-Za-z0-9+/]+={0,2})$`),
    );
    if (!match) throw new Error("authenticated SSH host keys are invalid");
    return match[1];
  });
  return Buffer.from(canonicalHostKeyPair(keys).join("\n"), "utf8").toString("base64");
}

export function parseAuthenticatedHostKeys(encodedKeys) {
  if (typeof encodedKeys !== "string") throw new Error("authenticated SSH host keys are invalid");
  const payload = decodeBase64(encodedKeys);
  const text = payload.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(payload))
    throw new Error("authenticated SSH host keys are invalid");
  return canonicalHostKeyPair(text.split("\n"));
}

export async function startRunner(dependencies) {
  requireDependencies(dependencies);
  const status = await dependencies.yandex.getInstanceStatus(dependencies.instanceId);
  if (status !== "STOPPED") throw new Error("runner VM must be STOPPED");

  const runners = await dependencies.github.listRunners();
  if (!Array.isArray(runners)) throw new Error("invalid GitHub runner response");
  if (deploymentRunners(runners).length !== 0)
    throw new Error("registered deployment runner already exists");

  await dependencies.yandex.startInstance(dependencies.instanceId);
}

export async function prepareAndStartRunner(dependencies) {
  const registration = await createJitRegistration(dependencies);
  await startRunner(dependencies);
  return registration;
}

export async function waitForRunner(dependencies) {
  requireDependencies(dependencies);
  const timeoutMs = dependencies.timeoutMs ?? 300_000;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 2_000;
  const now = dependencies.clock?.now ?? (() => performance.now());
  const sleep =
    dependencies.clock?.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs <= 0
  )
    throw new Error("invalid runner wait bounds");

  const expectedLabel = deploymentRunnerLabel(dependencies.deploymentId);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const status = await dependencies.yandex.getInstanceStatus(dependencies.instanceId);
    const runners = await dependencies.github.listRunners();
    if (!Array.isArray(runners)) throw new Error("invalid GitHub runner response");
    const registered = deploymentRunners(runners);
    const unrelated = registered.filter((runner) => !labelsOf(runner).includes(expectedLabel));
    if (unrelated.length !== 0) throw new Error("unrelated deployment runner is registered");
    const matches = registered.filter((runner) => labelsOf(runner).includes(expectedLabel));
    if (matches.length > 1) throw new Error("expected exactly one JIT runner");
    if (matches[0]?.busy) throw new Error("runner is already busy");
    if (status === "RUNNING" && matches[0]?.status === "online") return matches[0];
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
  throw new Error("runner startup timed out");
}

export async function waitForRunnerCleanup(dependencies) {
  if (
    !dependencies ||
    typeof dependencies.instanceId !== "string" ||
    dependencies.instanceId.length === 0 ||
    typeof dependencies.yandex?.getInstanceStatus !== "function" ||
    typeof dependencies.github?.listRunners !== "function"
  )
    throw new Error("invalid runner cleanup verification dependencies");
  const timeoutMs = dependencies.timeoutMs ?? 300_000;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 2_000;
  const now = dependencies.clock?.now ?? (() => performance.now());
  const sleep =
    dependencies.clock?.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs <= 0
  )
    throw new Error("invalid runner cleanup verification bounds");

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const status = await dependencies.yandex.getInstanceStatus(dependencies.instanceId);
    const runners = await dependencies.github.listRunners();
    if (!Array.isArray(runners)) throw new Error("invalid GitHub runner response");
    if (status === "STOPPED" && deploymentRunners(runners).length === 0) return;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
  throw new Error("runner cleanup verification timed out");
}

async function reportCleanup(dependencies, error) {
  if (typeof dependencies.reportCleanupError !== "function") return;
  try {
    await dependencies.reportCleanupError(error);
  } catch {
    // Cleanup reporting is advisory and must not prevent the remaining cleanup.
  }
}

export async function stopRunner(dependencies, runner) {
  requireDependencies(dependencies);
  const cleanupErrors = [];
  if (runner?.id !== undefined) {
    try {
      await dependencies.github.deleteRunner(runner.id);
    } catch (error) {
      cleanupErrors.push(error);
      await reportCleanup(dependencies, error);
    }
  }
  try {
    await dependencies.yandex.stopInstance(dependencies.instanceId);
  } catch (error) {
    cleanupErrors.push(error);
    await reportCleanup(dependencies, error);
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "runner cleanup failed");
}

export async function withRunner(dependencies, job) {
  if (typeof job !== "function") throw new Error("runner job is required");
  let runner;
  let primaryError;
  let result;
  let started = false;
  try {
    await startRunner(dependencies);
    started = true;
    runner = await waitForRunner(dependencies);
    result = await job(runner);
  } catch (error) {
    primaryError = error;
  } finally {
    if (started) {
      try {
        await stopRunner(dependencies, runner);
      } catch (cleanupError) {
        if (!primaryError) primaryError = cleanupError;
      }
    }
  }
  if (primaryError) throw primaryError;
  return result;
}

function requiredEnvironment(name, environment = process.env) {
  const value = environment[name];
  if (!value) throw new Error("runner control configuration is incomplete");
  return value;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error("runner control provider request failed");
  return response.status === 204 ? {} : response.json();
}

function bearer(token, additions = {}) {
  return { Authorization: `Bearer ${token}`, ...additions };
}

export function createYandexClient({ token, request = requestJson, operation = {} } = {}) {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    typeof request !== "function" ||
    !operation ||
    typeof operation !== "object" ||
    Array.isArray(operation)
  )
    throw new Error("invalid Yandex client configuration");

  const client = {
    async getInstanceStatus(id) {
      const instance = await request(
        `https://compute.api.cloud.yandex.net/compute/v1/instances/${id}`,
        { headers: bearer(token) },
      );
      return instance.status;
    },
    async startInstance(id) {
      await request(`https://compute.api.cloud.yandex.net/compute/v1/instances/${id}:start`, {
        method: "POST",
        headers: bearer(token),
      });
    },
    async stopInstance(id) {
      const status = await client.getInstanceStatus(id);
      if (status === "STOPPED" || status === "STOPPING") return;
      await request(`https://compute.api.cloud.yandex.net/compute/v1/instances/${id}:stop`, {
        method: "POST",
        headers: bearer(token),
      });
    },
    async updateMetadata(id, update) {
      const pendingOperation = await request(
        `https://compute.api.cloud.yandex.net/compute/v1/instances/${id}/updateMetadata`,
        {
          method: "POST",
          headers: bearer(token, { "Content-Type": "application/json" }),
          body: JSON.stringify(update),
        },
      );
      await waitForOperation(pendingOperation, {
        ...operation,
        async getOperation(operationId) {
          return request(
            `https://operation.api.cloud.yandex.net/operations/${encodeURIComponent(operationId)}`,
            { headers: bearer(token) },
          );
        },
      });
    },
  };
  return client;
}

async function cliClients() {
  const yandexToken = requiredEnvironment("YC_IAM_TOKEN");
  const githubToken = requiredEnvironment("GITHUB_RUNNER_ADMIN_TOKEN");
  const repository = process.env.GITHUB_REPOSITORY || "thevladbog/q";
  const instanceId = requiredEnvironment("YC_RUNNER_INSTANCE_ID");
  const githubBase = `https://api.github.com/repos/${repository}/actions/runners`;
  const githubHeaders = bearer(githubToken, {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
  });
  return {
    instanceId,
    yandex: createYandexClient({ token: yandexToken }),
    github: {
      async listRunners() {
        const result = await requestJson(`${githubBase}?per_page=100`, {
          headers: githubHeaders,
        });
        if (!Array.isArray(result.runners) || result.total_count !== result.runners.length)
          throw new Error("runner inventory exceeds the bounded page");
        return result.runners;
      },
      async deleteRunner(id) {
        await requestJson(`${githubBase}/${id}`, { method: "DELETE", headers: githubHeaders });
      },
      async generateJitConfig(request) {
        return requestJson(`${githubBase}/generate-jitconfig`, {
          method: "POST",
          headers: { ...githubHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
      },
    },
  };
}

function deploymentPhase(value) {
  if (value !== "first" && value !== "repeat")
    throw new Error("runner control configuration is incomplete");
  return value;
}

function privateAppIpv4(app) {
  const interfaces = app?.networkInterfaces;
  if (app?.status !== "RUNNING" || !Array.isArray(interfaces) || interfaces.length !== 1)
    throw new Error("production infrastructure gate failed");
  const primary = interfaces[0]?.primaryV4Address;
  const address = primary?.address;
  const octets =
    typeof address === "string" && isIPv4(address) ? address.split(".").map(Number) : [];
  const isPrivate =
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
  if (!isPrivate || primary.oneToOneNat !== undefined)
    throw new Error("production infrastructure gate failed");
  return address;
}

const ALB_ZONE_STATUSES = new Set([
  "HEALTHY",
  "PARTIALLY_HEALTHY",
  "UNHEALTHY",
  "DRAINING",
  "TIMEOUT",
]);
const FIRST_ALB_ZONE_STATUSES = new Set(["HEALTHY", "PARTIALLY_HEALTHY", "UNHEALTHY", "TIMEOUT"]);

function requireSingleAlbTarget(payload, expectedAddress) {
  if (!payload || !Array.isArray(payload.targetStates) || payload.targetStates.length !== 1)
    throw new Error("production ALB target inventory failed");
  const target = payload.targetStates[0];
  if (target?.target?.ipAddress !== expectedAddress)
    throw new Error("production ALB target inventory failed");
  const zones = target.status?.zoneStatuses;
  if (
    !Array.isArray(zones) ||
    zones.length === 0 ||
    zones.length > 16 ||
    !zones.every(
      (zone) =>
        zone &&
        typeof zone === "object" &&
        !Array.isArray(zone) &&
        typeof zone.zoneId === "string" &&
        zone.zoneId.length > 0 &&
        zone.zoneId.length <= 64 &&
        zone.zoneId.trim() === zone.zoneId &&
        ALB_ZONE_STATUSES.has(zone.status) &&
        (zone.failedActiveHc === undefined || typeof zone.failedActiveHc === "boolean"),
    )
  )
    throw new Error("production ALB target inventory failed");
  return zones;
}

function requireHealthyAlbTarget(zones) {
  if (!zones.every((zone) => zone.status === "HEALTHY"))
    throw new Error("production ALB gate failed");
}

function requireFirstAlbTargetStatus(zones) {
  if (!zones.every((zone) => FIRST_ALB_ZONE_STATUSES.has(zone.status)))
    throw new Error("production first ALB gate failed");
}

export async function verifyControllerGates(
  yandexToken,
  { environment = process.env, now = () => Date.now(), request = requestJson } = {},
) {
  const phase = deploymentPhase(requiredEnvironment("MARKIRO_DEPLOYMENT_PHASE", environment));
  const appInstanceId = requiredEnvironment("YC_APP_INSTANCE_ID", environment);
  const postgresClusterId = requiredEnvironment("YC_POSTGRES_CLUSTER_ID", environment);
  const loadBalancerId = requiredEnvironment("YC_LOAD_BALANCER_ID", environment);
  const backendGroupId = requiredEnvironment("YC_BACKEND_GROUP_ID", environment);
  const targetGroupId = requiredEnvironment("YC_TARGET_GROUP_ID", environment);
  const headers = { headers: bearer(yandexToken) };
  const app = await request(
    `https://compute.api.cloud.yandex.net/compute/v1/instances/${appInstanceId}`,
    headers,
  );
  const appAddress = privateAppIpv4(app);
  const backups = await request(
    `https://mdb.api.cloud.yandex.net/managed-postgresql/v1/clusters/${postgresClusterId}/backups`,
    headers,
  );
  const newest = [...(backups.backups || [])]
    .map((backup) => Date.parse(backup.createdAt))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  const checkedAt = now();
  if (!newest || newest > checkedAt || checkedAt - newest > 86_400_000)
    throw new Error("production backup gate failed");
  const targets = await request(
    `https://alb.api.cloud.yandex.net/apploadbalancer/v1/loadBalancers/${loadBalancerId}/targetStates/${backendGroupId}/${targetGroupId}`,
    headers,
  );
  const targetZones = requireSingleAlbTarget(targets, appAddress);
  if (phase === "repeat") requireHealthyAlbTarget(targetZones);
  if (phase === "first") requireFirstAlbTargetStatus(targetZones);
}

async function authenticatedAppHostKeys(yandexToken) {
  const appInstanceId = requiredEnvironment("YC_APP_INSTANCE_ID");
  const serial = await requestJson(
    `https://compute.api.cloud.yandex.net/compute/v1/instances/${appInstanceId}:serialPortOutput?port=1`,
    { headers: bearer(yandexToken) },
  );
  return parseSerialHostKeys(serial.contents);
}

async function discoverRunner(clients) {
  const deadline = performance.now() + 300_000;
  while (performance.now() < deadline) {
    const status = await clients.yandex.getInstanceStatus(clients.instanceId);
    const registered = deploymentRunners(await clients.github.listRunners());
    if (registered.length > 1) throw new Error("expected exactly one JIT runner");
    const runner = registered[0];
    const label = labelsOf(runner).find((value) => value?.startsWith(DEPLOYMENT_LABEL_PREFIX));
    if (runner?.busy) throw new Error("runner is already busy");
    if (status === "RUNNING" && runner?.status === "online" && label) return { runner, label };
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("runner startup timed out");
}

async function runCli(command) {
  const clients = await cliClients();
  if (command === "start") {
    const gateToken = requiredEnvironment("YC_GATE_IAM_TOKEN");
    await verifyControllerGates(gateToken);
    const appHostKeys = await authenticatedAppHostKeys(gateToken);
    const deploymentId = randomUUID();
    let label;
    let runner;
    try {
      ({ label } = await prepareAndStartRunner({ ...clients, deploymentId }));
      ({ runner } = await discoverRunner(clients));
    } catch (error) {
      await clients.yandex
        .updateMetadata(clients.instanceId, { delete: ["markiro-runner-jit"] })
        .catch(() => undefined);
      throw error;
    }
    await clients.yandex.updateMetadata(clients.instanceId, {
      delete: ["markiro-runner-jit"],
    });
    const output = requiredEnvironment("RUNNER_OUTPUT_PATH");
    await appendFile(
      output,
      `deployment-id=${deploymentId}\nrunner-id=${runner.id}\nrunner-label=${label}\napp-host-keys-b64=${appHostKeys}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return;
  }
  if (command === "cleanup") {
    const errors = [];
    let stale = [];
    try {
      stale = selectCleanupRunners(await clients.github.listRunners(), {
        deploymentId: process.env.DEPLOYMENT_ID,
        runnerId: process.env.RUNNER_ID,
      });
    } catch (error) {
      errors.push(error);
    }
    for (const runner of stale)
      try {
        await clients.github.deleteRunner(runner.id);
      } catch (error) {
        errors.push(error);
      }
    try {
      await clients.yandex.updateMetadata(clients.instanceId, {
        delete: ["markiro-runner-jit"],
      });
    } catch (error) {
      errors.push(error);
    }
    try {
      await clients.yandex.stopInstance(clients.instanceId);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "runner cleanup failed");
    await waitForRunnerCleanup(clients);
    return;
  }
  throw new Error("invalid runner control command");
}

if (isMainModule(import.meta.url))
  runCli(process.argv[2]).catch(() => {
    process.stderr.write("runner control failed\n");
    process.exitCode = 1;
  });

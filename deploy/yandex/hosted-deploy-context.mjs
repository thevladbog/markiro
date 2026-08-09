import { isIPv4 } from "node:net";
import { relative, resolve } from "node:path";
import process from "node:process";
import { writeFile } from "node:fs/promises";

import { isMainModule } from "./cli-main.mjs";

const HOST_KEY_MARKER = "MARKIRO_SSH_HOST_KEY_V1";
const HOST_KEY_ALGORITHMS = ["ssh-ed25519", "ssh-rsa"];
const MAXIMUM_PROVIDER_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const ALB_ZONE_STATUSES = new Set([
  "HEALTHY",
  "PARTIALLY_HEALTHY",
  "UNHEALTHY",
  "DRAINING",
  "TIMEOUT",
]);
const FIRST_ALB_ZONE_STATUSES = new Set(["HEALTHY", "PARTIALLY_HEALTHY", "UNHEALTHY", "TIMEOUT"]);

function requiredEnvironment(name, environment = process.env) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error("hosted deployment context configuration is incomplete");
  return value;
}

function bearer(token) {
  if (typeof token !== "string" || token.length === 0)
    throw new Error("hosted deployment context configuration is incomplete");
  return { Authorization: `Bearer ${token}` };
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
    .split(/\r?\n/u)
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

export function authenticatedKnownHosts(encodedKeys, address) {
  const publicAddress = requirePublicIpv4(address);
  return `${parseAuthenticatedHostKeys(encodedKeys)
    .map((key) => `${publicAddress} ${key}`)
    .join("\n")}\n`;
}

function octets(address) {
  return typeof address === "string" && isIPv4(address) ? address.split(".").map(Number) : [];
}

function isPrivateIpv4(address) {
  const parts = octets(address);
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function requirePrivateIpv4(address) {
  if (!isPrivateIpv4(address)) throw new Error("production infrastructure gate failed");
  return address;
}

function requirePublicIpv4(address) {
  const parts = octets(address);
  if (
    parts.length !== 4 ||
    isPrivateIpv4(address) ||
    parts[0] === 0 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    parts[0] >= 224
  )
    throw new Error("production infrastructure gate failed");
  return address;
}

function deploymentPhase(value) {
  if (value !== "first" && value !== "repeat")
    throw new Error("hosted deployment context configuration is incomplete");
  return value;
}

function appAddresses(app) {
  const interfaces = app?.networkInterfaces;
  if (app?.status !== "RUNNING" || !Array.isArray(interfaces) || interfaces.length !== 1)
    throw new Error("production infrastructure gate failed");
  const primary = interfaces[0]?.primaryV4Address;
  return {
    appPrivateAddress: requirePrivateIpv4(primary?.address),
    appPublicAddress: requirePublicIpv4(primary?.oneToOneNat?.address),
  };
}

function requireSingleAlbTarget(payload, expectedAddress, phase) {
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
    ) ||
    new Set(zones.map((zone) => zone.zoneId)).size !== zones.length
  )
    throw new Error("production ALB target inventory failed");
  if (phase === "repeat" && !zones.every((zone) => zone.status === "HEALTHY"))
    throw new Error("production ALB gate failed");
  if (phase === "first" && !zones.every((zone) => FIRST_ALB_ZONE_STATUSES.has(zone.status)))
    throw new Error("production first ALB gate failed");
}

async function readBoundedJson(response) {
  if (!response.ok || !response.body) throw new Error("hosted deployment provider request failed");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAXIMUM_PROVIDER_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("hosted deployment provider request failed");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("hosted deployment provider request failed");
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return readBoundedJson(response);
}

export async function resolveHostedDeployContext(
  token,
  { environment = process.env, now = () => Date.now(), request = requestJson } = {},
) {
  const phase = deploymentPhase(requiredEnvironment("MARKIRO_DEPLOYMENT_PHASE", environment));
  const appInstanceId = requiredEnvironment("YC_APP_INSTANCE_ID", environment);
  const postgresClusterId = requiredEnvironment("YC_POSTGRES_CLUSTER_ID", environment);
  const loadBalancerId = requiredEnvironment("YC_LOAD_BALANCER_ID", environment);
  const backendGroupId = requiredEnvironment("YC_BACKEND_GROUP_ID", environment);
  const targetGroupId = requiredEnvironment("YC_TARGET_GROUP_ID", environment);
  const requestOptions = { headers: bearer(token) };
  const instance = await request(
    `https://compute.api.cloud.yandex.net/compute/v1/instances/${appInstanceId}`,
    requestOptions,
  );
  const addresses = appAddresses(instance);
  const backups = await request(
    `https://mdb.api.cloud.yandex.net/managed-postgresql/v1/clusters/${postgresClusterId}/backups`,
    requestOptions,
  );
  const newest = [...(Array.isArray(backups?.backups) ? backups.backups : [])]
    .map((backup) => Date.parse(backup.createdAt))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  const checkedAt = now();
  if (!newest || newest > checkedAt || checkedAt - newest > 86_400_000)
    throw new Error("production backup gate failed");
  const targets = await request(
    `https://alb.api.cloud.yandex.net/apploadbalancer/v1/loadBalancers/${loadBalancerId}/targetStates/${backendGroupId}/${targetGroupId}`,
    requestOptions,
  );
  requireSingleAlbTarget(targets, addresses.appPrivateAddress, phase);
  const serial = await request(
    `https://compute.api.cloud.yandex.net/compute/v1/instances/${appInstanceId}:serialPortOutput?port=1`,
    requestOptions,
  );
  return {
    appHostKeysB64: parseSerialHostKeys(serial?.contents),
    ...addresses,
  };
}

function safeOutputPath(outputPath, runnerTemp) {
  const base = resolve(runnerTemp);
  const target = resolve(outputPath);
  const child = relative(base, target);
  if (!child || child.startsWith("..") || resolve(base, child) !== target)
    throw new Error("hosted deployment context configuration is incomplete");
  return target;
}

export async function writeHostedDeployContext(
  outputPath,
  context,
  { runnerTemp = process.env.RUNNER_TEMP } = {},
) {
  const keys = context && typeof context === "object" ? Object.keys(context).sort() : [];
  if (
    keys.join("\0") !==
      ["appHostKeysB64", "appPrivateAddress", "appPublicAddress"].sort().join("\0") ||
    typeof context.appHostKeysB64 !== "string" ||
    typeof context.appPrivateAddress !== "string" ||
    typeof context.appPublicAddress !== "string"
  )
    throw new Error("hosted deployment context configuration is incomplete");
  const contents = `${JSON.stringify(context)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAXIMUM_PROVIDER_BYTES)
    throw new Error("hosted deployment context configuration is incomplete");
  await writeFile(safeOutputPath(outputPath, runnerTemp), contents, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function runCli(command, environment = process.env) {
  if (command !== "resolve")
    throw new Error("hosted deployment context configuration is incomplete");
  const outputPath = safeOutputPath(
    requiredEnvironment("HOSTED_DEPLOY_CONTEXT_PATH", environment),
    requiredEnvironment("RUNNER_TEMP", environment),
  );
  const context = await resolveHostedDeployContext(
    requiredEnvironment("YC_IAM_TOKEN", environment),
    { environment },
  );
  await writeHostedDeployContext(outputPath, context, { runnerTemp: environment.RUNNER_TEMP });
}

if (isMainModule(import.meta.url))
  runCli(process.argv[2]).catch(() => {
    process.stderr.write("hosted deployment context failed\n");
    process.exitCode = 1;
  });

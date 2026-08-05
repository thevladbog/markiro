import { readFile } from "node:fs/promises";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";
import { observeReadiness } from "./readiness-observer.mjs";

const TIMEOUT_MS = 5_000;
const METADATA_TOKEN_URL =
  "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token";

function metric(name, labels, value) {
  if (!Number.isFinite(value) || value < 0) throw new Error("monitoring source data is missing");
  return { name, labels, type: "DGAUGE", value };
}

export async function collectAppMetrics({
  appInstanceId,
  loadBalancerId,
  backendGroupId,
  postgresClusterId,
  now = new Date(),
  getAlbTargets,
  getPostgresBackups,
  getReadiness,
}) {
  const [targets, backups, readiness] = await Promise.all([
    getAlbTargets(),
    getPostgresBackups(),
    getReadiness(),
  ]);
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    !Array.isArray(backups) ||
    backups.length === 0
  )
    throw new Error("monitoring source data is missing");
  const backupTimes = backups
    .map(({ createdAt }) => Date.parse(createdAt))
    .filter((value) => Number.isFinite(value) && value <= now.getTime());
  if (backupTimes.length === 0) throw new Error("monitoring source data is missing");
  const newestBackup = Math.max(...backupTimes);
  const healthyBackends = targets.filter((target) =>
    target?.status?.zoneStatuses?.some(({ status }) => status === "HEALTHY"),
  ).length;
  const optionalDegraded = ["smtp_degraded", "storage_degraded"].includes(readiness?.category)
    ? 1
    : 0;
  return [
    metric(
      "markiro.alb.healthy_backends",
      {
        resource_id: appInstanceId,
        load_balancer_id: loadBalancerId,
        backend_group_id: backendGroupId,
      },
      healthyBackends,
    ),
    metric(
      "markiro.postgres.backup_age_seconds",
      { resource_id: postgresClusterId },
      Math.floor((now.getTime() - newestBackup) / 1000),
    ),
    metric(
      "markiro.readiness.optional_dependency_degraded",
      { resource_id: appInstanceId },
      optionalDegraded,
    ),
  ];
}

export function collectRunnerMetrics({ runnerInstanceId, uptimeSeconds }) {
  return [
    metric(
      "markiro.runner.runtime_seconds",
      { resource_id: runnerInstanceId },
      Math.floor(uptimeSeconds),
    ),
  ];
}

export async function writeMetrics({ folderId, iamToken, metrics, fetch: fetchImpl = fetch }) {
  const response = await fetchImpl(
    `https://monitoring.api.cloud.yandex.net/monitoring/v2/data/write?folderId=${encodeURIComponent(folderId)}&service=custom`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${iamToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ metrics }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error("custom metric write failed");
  const result = await response.json();
  const written = Number(result.writtenMetricsCount ?? result.metrics_written);
  if (written !== metrics.length) throw new Error("custom metric write failed");
}

async function requestJson(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("monitoring source request failed");
  return response.json();
}

async function metadataToken() {
  const response = await fetch(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("monitoring identity request failed");
  const token = (await response.json()).access_token;
  if (typeof token !== "string" || token.length === 0)
    throw new Error("monitoring identity request failed");
  return token;
}

async function metadataText(path) {
  const response = await fetch(`http://169.254.169.254/computeMetadata/v1/${path}`, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("monitoring metadata request failed");
  const value = (await response.text()).trim();
  if (!value) throw new Error("monitoring metadata request failed");
  return value;
}

async function discoverExact(url, collection, token, name) {
  const payload = await requestJson(url, token);
  const matches = (payload[collection] ?? []).filter((resource) => resource?.name === name);
  if (matches.length !== 1 || typeof matches[0].id !== "string")
    throw new Error("monitoring source data is missing");
  return matches[0].id;
}

async function runCli(mode) {
  const folderId = process.env.MARKIRO_FOLDER_ID;
  if (!folderId) throw new Error("monitoring producer configuration is incomplete");
  const token = await metadataToken();
  let metrics;
  if (mode === "app") {
    const appInstanceId = await metadataText("instance/id");
    const encodedFolder = encodeURIComponent(folderId);
    const [loadBalancerId, backendGroupId, targetGroupId, postgresClusterId] = await Promise.all([
      discoverExact(
        `https://alb.api.cloud.yandex.net/apploadbalancer/v1/loadBalancers?folderId=${encodedFolder}`,
        "loadBalancers",
        token,
        "markiro-production",
      ),
      discoverExact(
        `https://alb.api.cloud.yandex.net/apploadbalancer/v1/backendGroups?folderId=${encodedFolder}`,
        "backendGroups",
        token,
        "markiro-production-app",
      ),
      discoverExact(
        `https://alb.api.cloud.yandex.net/apploadbalancer/v1/targetGroups?folderId=${encodedFolder}`,
        "targetGroups",
        token,
        "markiro-production-app",
      ),
      discoverExact(
        `https://mdb.api.cloud.yandex.net/managed-postgresql/v1/clusters?folderId=${encodedFolder}`,
        "clusters",
        token,
        "markiro-production-postgres",
      ),
    ]);
    metrics = await collectAppMetrics({
      appInstanceId,
      loadBalancerId,
      backendGroupId,
      postgresClusterId,
      getAlbTargets: async () => {
        const payload = await requestJson(
          `https://alb.api.cloud.yandex.net/apploadbalancer/v1/loadBalancers/${loadBalancerId}/targetStates/${backendGroupId}/${targetGroupId}`,
          token,
        );
        return payload.targetStates;
      },
      getPostgresBackups: async () => {
        const payload = await requestJson(
          `https://mdb.api.cloud.yandex.net/managed-postgresql/v1/clusters/${postgresClusterId}/backups`,
          token,
        );
        return payload.backups;
      },
      getReadiness: observeReadiness,
    });
  } else if (mode === "runner") {
    const runnerInstanceId = await metadataText("instance/id");
    const uptime = Number.parseFloat((await readFile("/proc/uptime", "utf8")).split(" ")[0]);
    metrics = collectRunnerMetrics({ runnerInstanceId, uptimeSeconds: uptime });
  } else throw new Error("monitoring producer configuration is incomplete");
  await writeMetrics({ folderId, iamToken: token, metrics });
}

if (isMainModule(import.meta.url))
  runCli(process.argv[2]).catch(() => {
    process.stderr.write("monitoring producer failed\n");
    process.exitCode = 1;
  });

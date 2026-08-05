import assert from "node:assert/strict";
import test from "node:test";

import { collectAppMetrics, collectRunnerMetrics, writeMetrics } from "../monitoring-producer.mjs";

test("app producer emits every app custom alert metric with exact Terraform selector labels", async () => {
  const metrics = await collectAppMetrics({
    appInstanceId: "app-1",
    loadBalancerId: "alb-1",
    backendGroupId: "backend-1",
    postgresClusterId: "pg-1",
    now: new Date("2026-08-05T10:02:00.000Z"),
    getAlbTargets: async () => [{ status: { zoneStatuses: [{ status: "HEALTHY" }] } }],
    getPostgresBackups: async () => [{ createdAt: "2026-08-05T09:00:00.000Z" }],
    getReadiness: async () => ({ category: "smtp_degraded", exitCode: 0 }),
  });

  assert.deepEqual(Object.fromEntries(metrics.map(({ name, value }) => [name, value])), {
    "markiro.alb.healthy_backends": 1,
    "markiro.postgres.backup_age_seconds": 3720,
    "markiro.readiness.optional_dependency_degraded": 1,
  });
  assert.deepEqual(metrics[0].labels, {
    resource_id: "app-1",
    load_balancer_id: "alb-1",
    backend_group_id: "backend-1",
  });
  assert.deepEqual(metrics[1].labels, { resource_id: "pg-1" });
});

test("producer fails without fabricating ALB or backup values when source data is missing", async () => {
  await assert.rejects(
    collectAppMetrics({
      appInstanceId: "app-1",
      loadBalancerId: "alb-1",
      backendGroupId: "backend-1",
      postgresClusterId: "pg-1",
      now: new Date("2026-08-05T10:02:00.000Z"),
      getAlbTargets: async () => [],
      getPostgresBackups: async () => [],
      getReadiness: async () => ({ category: "ok", exitCode: 0 }),
    }),
    /monitoring source data is missing/,
  );
});

test("runner producer reports bounded runtime for the exact runner resource", () => {
  assert.deepEqual(collectRunnerMetrics({ runnerInstanceId: "runner-1", uptimeSeconds: 3661 }), [
    {
      name: "markiro.runner.runtime_seconds",
      labels: { resource_id: "runner-1" },
      type: "DGAUGE",
      value: 3661,
    },
  ]);
});

test("metric writer uses one bounded authenticated custom-service request", async () => {
  let request;
  await writeMetrics({
    folderId: "folder-1",
    iamToken: "sensitive-token",
    metrics: collectRunnerMetrics({ runnerInstanceId: "runner-1", uptimeSeconds: 42 }),
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ writtenMetricsCount: "1" }) };
    },
  });
  assert.equal(
    request.url,
    "https://monitoring.api.cloud.yandex.net/monitoring/v2/data/write?folderId=folder-1&service=custom",
  );
  assert.equal(request.options.signal instanceof AbortSignal, true);
  assert.match(request.options.headers.Authorization, /^Bearer /);
  assert.doesNotMatch(request.options.body, /sensitive-token/);
});

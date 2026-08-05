import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { sanitizeJournal, writeBoundedSpool } from "../../../deploy/yandex/log-sanitizer.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const source = (file) => readFile(path.join(root, file), "utf8");

test("clean first-provisioning has no alert attestation, while protected plans require the exact 16 IDs", async () => {
  const [workflow, variables, observability] = await Promise.all([
    source(".github/workflows/yandex-infrastructure.yml"),
    source("infra/yandex/production/variables.tf"),
    source("infra/yandex/modules/observability/variables.tf"),
  ]);

  assert.match(workflow, /observability_phase:[\s\S]*options: \[first, protected\]/);
  assert.match(workflow, /OBSERVABILITY_PHASE/);
  assert.match(workflow, /unset TF_VAR_notification_channel_id TF_VAR_alert_ids/);
  assert.match(workflow, /observability_phase/);
  for (const file of [variables, observability]) {
    assert.match(file, /variable "observability_phase"/);
    assert.match(file, /var\.observability_phase == "first"/);
    assert.match(file, /length\(toset\(values\(var\.alert_ids\)\)\) == 16/);
  }
});

test("clean cloud-init installs but does not materialize runtime secrets, and deploy remains the exact materialization gate", async () => {
  const [cloudInit, remoteDeploy, runtimeEnv] = await Promise.all([
    source("infra/yandex/modules/compute/cloud-init-app.yaml.tftpl"),
    source("deploy/yandex/remote-deploy.mjs"),
    source("deploy/yandex/runtime-env.mjs"),
  ]);

  assert.match(cloudInit, /systemctl enable markiro-runtime-env\.service/);
  assert.doesNotMatch(cloudInit, /systemctl start markiro-runtime-env\.service/);
  assert.doesNotMatch(cloudInit, /test -f \/etc\/markiro\/production\.env/);
  assert.match(remoteDeploy, /systemctl[\s\S]*restart[\s\S]*markiro-runtime-env\.service/);
  assert.match(runtimeEnv, /if \(values\.size !== expected\.size\) throw invalidPayload\(\)/);
});

test("rendered host observability path captures tagged Docker and deploy failures in a bounded redacted spool", async () => {
  const [dockerUnit, sanitizer, agentConfig, remoteDeploy] = await Promise.all([
    source("deploy/yandex/systemd/docker.service"),
    source("deploy/yandex/log-sanitizer.mjs"),
    source("deploy/yandex/unified-agent-logs.yaml.tftpl"),
    source("deploy/yandex/remote-deploy.mjs"),
  ]);
  assert.match(dockerUnit, /--log-driver=journald/);
  assert.match(dockerUnit, /--log-opt tag=markiro\.\{\{\.Name\}\}/);
  assert.match(sanitizer, /CONTAINER_TAG/);
  assert.match(remoteDeploy, /systemd-run[\s\S]*--unit=markiro-deploy/);
  assert.match(agentConfig, /read_only_new_lines: true/);
  assert.match(agentConfig, /namespace: sys/);

  const directory = await (await import("node:fs/promises")).mkdtemp("/tmp/markiro-observability-");
  try {
    const spool = path.join(directory, "observability.log");
    const payload = sanitizeJournal([
      {
        unit: "docker.service",
        tag: "markiro.markiro-production-api-1",
        message: "database is ready",
      },
      { unit: "markiro-deploy.service", message: "token=must-not-leak deployment failed" },
      { unit: "docker.service", tag: "other.container", message: "must-not-ship" },
    ]);
    await writeBoundedSpool(spool, payload, { maxBytes: 512, now: 1_000 });
    const output = await readFile(spool, "utf8");
    assert.match(output, /database is ready/);
    assert.match(output, /deployment failed/);
    assert.doesNotMatch(output, /must-not-leak|must-not-ship/);
    assert.ok(Buffer.byteLength(output) <= 512);
  } finally {
    await (await import("node:fs/promises")).rm(directory, { recursive: true, force: true });
  }
});

test("readiness uses the published edge authority and publishes a required-failure alert", async () => {
  const [observer, producer, observability] = await Promise.all([
    source("deploy/yandex/readiness-observer.mjs"),
    source("deploy/yandex/monitoring-producer.mjs"),
    source("infra/yandex/modules/observability/main.tf"),
  ]);
  assert.match(observer, /127\.0\.0\.1:8080\/health\/ready/);
  assert.match(observer, /domain = process\.env\.MARKIRO_DOMAIN/);
  assert.match(observer, /headers: \{ Host: domain \}/);
  assert.match(producer, /markiro\.readiness\.required_unavailable/);
  assert.match(observability, /readiness_required_unavailable/);
  assert.match(observability, /markiro\.readiness\.required_unavailable/);
});

test("all workload identities are pairwise distinct before plan and in Terraform, including runner OS Login folder audit", async () => {
  const [workflow, variables, production, iam] = await Promise.all([
    source(".github/workflows/yandex-infrastructure.yml"),
    source("infra/yandex/production/variables.tf"),
    source("infra/yandex/production/main.tf"),
    source("infra/yandex/modules/iam/main.tf"),
  ]);
  assert.match(workflow, /node infra\/yandex\/scripts\/validate-workload-identities\.mjs/);
  assert.match(workflow, /YC_TERRAFORM_SERVICE_ACCOUNT_ID/);
  assert.match(variables, /variable "terraform_service_account_id"/);
  assert.match(production, /check "workload_service_account_ids_are_distinct"/);
  assert.match(iam, /"resource-manager\.auditor"/);
  assert.match(iam, /yandex_iam_service_account\.runner\.id/);
});

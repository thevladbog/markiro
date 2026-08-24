import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("first go-live documents the single direct-VM infrastructure and deploy sequence", async () => {
  const runbook = await read("docs/runbooks/yandex-first-go-live.md");
  const ordered = [
    "## 1. Проверить выпуск образов",
    "## 2. Проверить резервную копию",
    "## 3. Применить упрощение инфраструктуры",
    "## 4. Проверить прямой DNS",
    "## 5. Запустить приложение",
    "## 6. Проверить TLS и приложение",
    "## 7. Удалить остаточные данные аудита",
  ];
  let previous = -1;
  for (const heading of ordered) {
    const index = runbook.indexOf(heading);
    assert.ok(index > previous, "missing or unordered " + heading);
    previous = index;
  }
  assert.match(runbook, /target_sha=<current-main-40-character-sha>/);
  assert.match(runbook, /enable_public_dns=true/);
  assert.match(runbook, /release_run_id=<successful-publish-run-id>/);
  assert.match(runbook, /release_sha=<same-40-character-main-sha>/);
  assert.ok(runbook.indexOf("Caddy сам выпускает ACME-сертификаты") > runbook.indexOf("## 5."));
});

test("runbooks protect durable data and explicitly enumerate the retired cloud stack", async () => {
  const [goLive, infra, recovery] = await Promise.all([
    read("docs/runbooks/yandex-first-go-live.md"),
    read("docs/runbooks/yandex-infrastructure-apply.md"),
    read("docs/runbooks/yandex-recovery.md"),
  ]);
  const combined = goLive + "\n" + infra + "\n" + recovery;
  for (const protectedName of ["PostgreSQL", "media", "state", "KMS"]) {
    assert.match(combined, new RegExp(protectedName, "i"));
  }
  for (const retiredName of ["ALB", "SWS/ARL", "Audit Trails", "deployment-controller/runner"]) {
    assert.match(goLive, new RegExp(retiredName.replace("/", "\\/"), "i"));
  }
  assert.match(goLive, /metadata-only инвентаризацию/);
  assert.match(goLive, /Не затрагивайте media или state bucket/);
});

test("operator docs bind deploy to pinned SSH and exact immutable release inputs", async () => {
  const [deploy, secrets] = await Promise.all([
    read("docs/runbooks/saas-production-deploy.md"),
    read("docs/runbooks/yandex-secrets.md"),
  ]);
  for (const value of [
    "YC_APP_PUBLIC_ADDRESS",
    "APP_SSH_HOST_KEYS_B64",
    "YC_APP_DEPLOY_SSH_PRIVATE_KEY",
    "release run ID",
    "40-символьным",
  ])
    assert.match(deploy + "\n" + secrets, new RegExp(value));
  assert.match(
    deploy,
    /transfer, prepare, migrations, start,[\s\S]*readiness, public smoke, finalize/,
  );
  assert.match(deploy, /один[\s\S]*rollback/);
  assert.match(secrets, /job-scoped/);
  assert.match(secrets, /password-stdin/);
  assert.match(secrets, /ротац/i);
  assert.match(secrets, /APP_SSH_HOST_KEYS_B64/);
});

test("active runbooks do not instruct operators to use retired release phases", async () => {
  const active = (
    await Promise.all([
      read("docs/runbooks/yandex-first-go-live.md"),
      read("docs/runbooks/yandex-infrastructure-apply.md"),
      read("docs/runbooks/saas-production-deploy.md"),
      read("docs/runbooks/yandex-secrets.md"),
    ])
  ).join("\n");
  assert.doesNotMatch(
    active,
    /deployment_phase=|rollback_rehearsal=|observability_phase=|postgres_provisioning_phase=|dns_apply_run_id=|dns_verifier_run_id=/,
  );
});

test("active infrastructure runbooks require separate reviewed plan and apply runs", async () => {
  const [goLive, infrastructure, bootstrap] = await Promise.all([
    read("docs/runbooks/yandex-first-go-live.md"),
    read("docs/runbooks/yandex-infrastructure-apply.md"),
    read("docs/runbooks/yandex-bootstrap.md"),
  ]);

  for (const runbook of [goLive, infrastructure]) {
    assert.match(runbook, /mode=plan/);
    assert.match(runbook, /mode=apply/);
    assert.match(runbook, /production-infrastructure/);
    assert.match(runbook, /production-infrastructure-apply/);
    assert.match(runbook, /plan_key/);
    assert.match(runbook, /plan_sha256/);
  }
  assert.match(goLive, /enable_station_release_public_dns=false/);
  assert.match(bootstrap, /production-infrastructure/);
  assert.match(bootstrap, /production-infrastructure-apply/);
  assert.match(bootstrap, /два.*OIDC|OIDC.*два/is);
});

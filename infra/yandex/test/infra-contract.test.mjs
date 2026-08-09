import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function block(input, declaration) {
  const start = input.indexOf(declaration);
  assert.notEqual(start, -1, `missing ${declaration}`);
  const opening = input.indexOf("{", start);
  let depth = 0;
  for (let index = opening; index < input.length; index += 1) {
    if (input[index] === "{") depth += 1;
    if (input[index] === "}") depth -= 1;
    if (depth === 0) return input.slice(start, index + 1);
  }
  assert.fail(`unterminated ${declaration}`);
}

function assertDirectGraph({ production, network, compute }) {
  for (const retained of [
    'module "network"',
    'module "compute"',
    'module "postgres"',
    'module "object_storage"',
    'resource "yandex_dns_recordset" "application"',
    'resource "yandex_dns_recordset" "kiosk_application"',
  ])
    assert.match(production, new RegExp(retained.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const active = `${production}\n${network}\n${compute}`;
  for (const removed of [
    /module\s+"(?:ingress|observability)"/,
    /yandex_alb_/,
    /yandex_sws_/,
    /yandex_cm_certificate/,
    /yandex_audit_trails_trail/,
    /yandex_logging_group/,
    /yandex_monitoring_dashboard/,
    /terraform_data/,
    /deployment_controller/,
  ])
    assert.doesNotMatch(active, removed);

  assert.match(compute, /resource\s+"yandex_vpc_address"\s+"app"/);
  assert.match(compute, /deletion_protection\s*=\s*true/);
  assert.match(compute, /resource\s+"yandex_compute_instance"\s+"app"/);
  assert.match(compute, /nat_ip_address\s*=\s*yandex_vpc_address\.app/);
  assert.doesNotMatch(compute, /replace_triggered_by/);

  assert.doesNotMatch(network, /resource\s+"yandex_vpc_(?:subnet|security_group)"\s+"alb"/);
  for (const port of [22, 80, 443]) {
    assert.match(
      network,
      new RegExp(
        `from_port\\s*=\\s*${port}[\\s\\S]{0,120}to_port\\s*=\\s*${port}[\\s\\S]{0,160}0\\.0\\.0\\.0/0`,
      ),
    );
  }
  assert.doesNotMatch(network, /from_port\s*=\s*8080/);
}

test("production graph is the direct VM MVP and cannot reintroduce managed edge machinery", async () => {
  const graph = {
    production: await source("infra/yandex/production/main.tf"),
    network: await source("infra/yandex/modules/network/main.tf"),
    compute: await source("infra/yandex/modules/compute/main.tf"),
  };
  assertDirectGraph(graph);

  const mutations = [
    {
      ...graph,
      production: `${graph.production}\nmodule "ingress" { source = "../modules/ingress" }`,
    },
    { ...graph, compute: `${graph.compute}\nresource "yandex_alb_target_group" "app" {}` },
    { ...graph, network: `${graph.network}\nresource "yandex_vpc_subnet" "alb" {}` },
  ];
  for (const mutation of mutations) assert.throws(() => assertDirectGraph(mutation));
});

test("both public names are gated together and resolve only to the retained app address", async () => {
  const production = await source("infra/yandex/production/main.tf");
  for (const name of ["application", "kiosk_application"]) {
    const record = block(production, `resource "yandex_dns_recordset" "${name}"`);
    assert.match(record, /count\s*=\s*var\.public_dns_enabled\s*\?\s*1\s*:\s*0/);
    assert.match(record, /type\s*=\s*"A"/);
    assert.match(record, /data\s*=\s*\[module\.compute\.app_public_ip\]/);
    assert.match(record, /name\s*=\s*local\.(?:admin|kiosk)_dns_name/);
  }
  assert.match(production, /admin_dns_name\s*=\s*"\$\{trimsuffix\(var\.domain, "\."\)\}\."/);
  assert.match(production, /kiosk_dns_name\s*=\s*"\$\{trimsuffix\(var\.kiosk_domain, "\."\)\}\."/);
  const outputs = await source("infra/yandex/production/outputs.tf");
  assert.match(outputs, /\(local\.admin_dns_name\)\s*=\s*module\.compute\.app_public_ip/);
  assert.match(outputs, /\(local\.kiosk_dns_name\)\s*=\s*module\.compute\.app_public_ip/);
  const variables = await source("infra/yandex/production/variables.tf");
  const publicDns = block(variables, 'variable "public_dns_enabled"');
  assert.match(publicDns, /default\s*=\s*false/);
});

test("PostgreSQL and application database remain private, encrypted, backed up and protected", async () => {
  const postgres = await source("infra/yandex/modules/postgres/main.tf");
  const cluster = block(postgres, 'resource "yandex_mdb_postgresql_cluster" "production"');
  const database = block(postgres, 'resource "yandex_mdb_postgresql_database" "application"');
  assert.match(cluster, /disk_encryption_key_id\s*=\s*var\.kms_key_id/);
  assert.match(cluster, /backup_retain_period_days\s*=\s*14/);
  assert.match(cluster, /assign_public_ip\s*=\s*false/);
  assert.match(cluster, /prevent_destroy\s*=\s*true/);
  assert.match(database, /prevent_destroy\s*=\s*true/);
});

test("media and temporarily retained audit data are private, versioned, encrypted and protected", async () => {
  const storage = await source("infra/yandex/modules/object-storage/main.tf");
  for (const name of ["media", "audit"]) {
    const bucket = block(storage, `resource "yandex_storage_bucket" "${name}"`);
    assert.match(bucket, /force_destroy\s*=\s*false/);
    assert.match(bucket, /read\s*=\s*false/);
    assert.match(bucket, /list\s*=\s*false/);
    assert.match(bucket, /versioning\s*\{[\s\S]*enabled\s*=\s*true/);
    assert.match(bucket, /kms_master_key_id\s*=\s*var\.kms_key_id/);
    assert.match(bucket, /prevent_destroy\s*=\s*true/);
  }
  assert.match(storage, /AllowApplicationMediaObjects/);
  assert.doesNotMatch(storage, /audit_writer|audit_uploader|audit_service_account/);
});

test("bootstrap retains only state, runtime and the three necessary service accounts", async () => {
  const bootstrap = await source("infra/yandex/bootstrap/main.tf");
  const iam = await source("infra/yandex/modules/iam/main.tf");
  const active = `${bootstrap}\n${iam}`;
  for (const retained of [
    'resource "yandex_storage_bucket" "state"',
    'resource "yandex_lockbox_secret" "runtime"',
    'resource "yandex_lockbox_secret" "state_backend"',
    'resource "yandex_iam_service_account" "terraform"',
    'resource "yandex_iam_service_account" "state"',
    'resource "yandex_iam_service_account" "app"',
    'resource "yandex_iam_workload_identity_federated_credential" "github_infrastructure"',
  ])
    assert.match(active, new RegExp(retained.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal([...iam.matchAll(/resource\s+"yandex_iam_service_account"/g)].length, 3);
  assert.doesNotMatch(
    active,
    /deployment_controller|github_deploy|runner_registration|registry_secret|yandex_lockbox_secret"\s+"registry|yandex_logging_group|audit_trails|smart-web-security|certificate-manager|monitoring\./,
  );
  for (const resource of [
    block(bootstrap, 'resource "yandex_storage_bucket" "state"'),
    block(bootstrap, 'resource "yandex_lockbox_secret" "runtime"'),
    block(bootstrap, 'resource "yandex_lockbox_secret" "state_backend"'),
  ])
    assert.match(resource, /prevent_destroy\s*=\s*true/);
});

test("Terraform identity has infrastructure roles only and deploy has no cloud-plane credential", async () => {
  const iam = await source("infra/yandex/modules/iam/main.tf");
  for (const role of [
    "compute.admin",
    "dns.editor",
    "managed-postgresql.editor",
    "storage.admin",
    "vpc.privateAdmin",
    "vpc.publicAdmin",
  ]) {
    assert.match(iam, new RegExp(`"${role.replace(".", "\\.")}"`));
  }
  assert.doesNotMatch(
    iam,
    /alb\.|smart-web-security|certificate-manager|audit-trails|logging\.|monitoring\.|lockbox\.admin/,
  );
  assert.doesNotMatch(iam, /github_deploy|production-deploy/);
});

test("app cloud-init is key-only, fail-fast and writes completion last", async () => {
  const [cloudInit, tmpfiles] = await Promise.all([
    source("infra/yandex/modules/compute/cloud-init-app.yaml.tftpl"),
    source("deploy/yandex/tmpfiles.d/markiro-registry-auth.conf"),
  ]);
  assert.match(cloudInit, /PasswordAuthentication no/);
  assert.match(cloudInit, /KbdInteractiveAuthentication no/);
  assert.match(cloudInit, /PermitRootLogin no/);
  assert.match(cloudInit, /AuthenticationMethods publickey/);
  assert.match(cloudInit, /lock_passwd:\s*true/);
  assert.match(cloudInit, /\/usr\/bin\/bash\n\s+- -ceu/);
  assert.match(cloudInit, /set -o pipefail/);
  assert.match(cloudInit, /dpkg-query[^\n]+\$\$\{Status\}[^\n]+install ok installed/);
  assert.match(cloudInit, /path:\s*\/etc\/tmpfiles\.d\/markiro-registry-auth\.conf/);
  assert.equal(tmpfiles, "d /run/markiro-registry-auth 0700 root root -\n");
  const marker = "touch /var/lib/markiro/markiro-app-bootstrap-complete";
  assert.equal(cloudInit.lastIndexOf(marker), cloudInit.trimEnd().length - marker.length);
  assert.doesNotMatch(
    cloudInit,
    /unified.agent|monitoring|observability|serial-port-enable|runner/i,
  );
});

test("active Terraform configuration contains no literal secret payloads or local credential backend", async () => {
  const paths = [
    "infra/yandex/bootstrap/main.tf",
    "infra/yandex/bootstrap/providers.tf",
    "infra/yandex/production/main.tf",
    "infra/yandex/production/providers.tf",
    "infra/yandex/modules/iam/main.tf",
    "infra/yandex/modules/compute/main.tf",
  ];
  const active = (await Promise.all(paths.map(source))).join("\n");
  assert.doesNotMatch(
    active,
    /access_key\s*=\s*"|secret_key\s*=\s*"|iam_token\s*=\s*"|token\s*=\s*"/i,
  );
  assert.doesNotMatch(active, /static_access_key|hmac_key/);
});

test("infrastructure workflow has one protected manual apply without legacy phases", async () => {
  const workflow = await source(".github/workflows/yandex-infrastructure.yml");
  assert.match(workflow, /workflow_dispatch:[\s\S]*target_sha:[\s\S]*enable_public_dns:/);
  assert.match(workflow, /environment:\s*production-infrastructure/);
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /terraform[^\n]+plan[^\n]+-out="\$plan"/);
  assert.equal(
    [...workflow.matchAll(/name:\s*Configure provider mirror/g)].length,
    2,
    "both validation and apply must use the Yandex provider mirror",
  );
  const payloadFilter = workflow.match(/jq -e '([\s\S]*?)' <<<"\$payload" > \/dev\/null/)?.[1];
  assert.ok(payloadFilter, "workflow must validate the Lockbox payload before exporting it");
  const validPayload = {
    versionId: "e6q-valid-version",
    entries: [
      { key: "AWS_ACCESS_KEY_ID", textValue: "access-key" },
      { key: "AWS_SECRET_ACCESS_KEY", textValue: "secret-key" },
    ],
  };
  assert.doesNotThrow(() =>
    execFileSync("jq", ["-e", payloadFilter], {
      encoding: "utf8",
      input: JSON.stringify(validPayload),
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  for (const invalidPayload of [
    { entries: validPayload.entries },
    { ...validPayload, versionId: "" },
    { ...validPayload, unexpected: true },
  ]) {
    assert.throws(() =>
      execFileSync("jq", ["-e", payloadFilter], {
        encoding: "utf8",
        input: JSON.stringify(invalidPayload),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  }
  assert.match(workflow, /node infra\/yandex\/scripts\/guard-production-plan\.mjs "\$plan_json"/);
  assert.match(workflow, /terraform[^\n]+apply[^\n]+"\$plan"/);
  assert.doesNotMatch(
    workflow,
    /observability_phase|postgres_provisioning_phase|self-hosted|deployment.controller|ALB|SWS|certificate|rehearsal/i,
  );
});

test("MVP design and plan retain only identities and secrets that still exist", async () => {
  const [plan, design] = await Promise.all([
    source("docs/superpowers/plans/2026-08-09-yandex-direct-vm-mvp.md"),
    source("docs/superpowers/specs/2026-08-09-yandex-direct-vm-mvp-design.md"),
  ]);
  assert.doesNotMatch(plan, /Terraform\/state\/app\/postbox identities/);
  assert.doesNotMatch(design, /runtime, registry and SMTP secrets/);
  assert.match(design, /runtime and SMTP secrets/);
});

test("committed Terraform stays formatted with the pinned local binary when available", async (context) => {
  const terraform = path.join(homedir(), "terraform", "terraform");
  try {
    await access(terraform);
  } catch {
    context.skip("pinned Terraform binary is unavailable");
    return;
  }
  execFileSync(terraform, ["fmt", "-check", "-recursive", "infra/yandex"], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
});

test("toolchain checker accepts committed exact-version locks", () => {
  execFileSync(process.execPath, ["infra/yandex/scripts/check-toolchain.mjs"], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
});

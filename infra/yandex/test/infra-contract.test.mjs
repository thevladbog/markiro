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
  const instance = block(compute, 'resource "yandex_compute_instance" "app"');
  assert.match(
    instance,
    /lifecycle\s*\{[\s\S]*ignore_changes\s*=\s*\[[\s\S]*boot_disk\[0\]\.initialize_params\[0\]\.image_id[\s\S]*\]/,
  );
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

test("all public names are gated together and resolve only to the retained app address", async () => {
  const production = await source("infra/yandex/production/main.tf");
  for (const name of [
    "application",
    "saas_admin_application",
    "kiosk_application",
    "landing_application",
  ]) {
    const record = block(production, `resource "yandex_dns_recordset" "${name}"`);
    assert.match(record, /count\s*=\s*var\.public_dns_enabled\s*\?\s*1\s*:\s*0/);
    assert.match(record, /type\s*=\s*"A"/);
    assert.match(record, /data\s*=\s*\[module\.compute\.app_public_ip\]/);
    assert.match(record, /name\s*=\s*local\.(?:admin|saas_admin|kiosk|landing)_dns_name/);
  }
  assert.match(production, /admin_dns_name\s*=\s*"\$\{trimsuffix\(var\.domain, "\."\)\}\."/);
  assert.match(
    production,
    /saas_admin_dns_name\s*=\s*"\$\{trimsuffix\(var\.saas_admin_domain, "\."\)\}\."/,
  );
  assert.match(production, /kiosk_dns_name\s*=\s*"\$\{trimsuffix\(var\.kiosk_domain, "\."\)\}\."/);
  assert.match(
    production,
    /landing_dns_name\s*=\s*"\$\{trimsuffix\(var\.landing_domain, "\."\)\}\."/,
  );
  const outputs = await source("infra/yandex/production/outputs.tf");
  assert.match(outputs, /\(local\.admin_dns_name\)\s*=\s*module\.compute\.app_public_ip/);
  assert.match(outputs, /\(local\.saas_admin_dns_name\)\s*=\s*module\.compute\.app_public_ip/);
  assert.match(outputs, /\(local\.kiosk_dns_name\)\s*=\s*module\.compute\.app_public_ip/);
  assert.match(outputs, /\(local\.landing_dns_name\)\s*=\s*module\.compute\.app_public_ip/);
  const variables = await source("infra/yandex/production/variables.tf");
  const publicDns = block(variables, 'variable "public_dns_enabled"');
  assert.match(publicDns, /default\s*=\s*false/);

  const publicDomainIsolation = block(production, 'check "public_domains_are_distinct"');
  assert.match(publicDomainIsolation, /length\(toset\(\[/);
  for (const domain of [
    "var.domain",
    "var.saas_admin_domain",
    "var.kiosk_domain",
    "var.landing_domain",
    "var.station_release_domain",
  ])
    assert.match(publicDomainIsolation, new RegExp(domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(publicDomainIsolation, /\]\)\)\s*==\s*5/);
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
  const appUploader = block(storage, 'resource "yandex_storage_bucket_iam_binding" "app_uploader"');
  assert.match(appUploader, /bucket\s*=\s*yandex_storage_bucket\.media\.bucket/);
  assert.match(appUploader, /role\s*=\s*"storage\.uploader"/);
  assert.match(appUploader, /members\s*=\s*\["serviceAccount:\$\{var\.app_service_account_id\}"\]/);
  assert.doesNotMatch(storage, /audit_writer|audit_uploader|audit_service_account/);
});

test("Station releases use one protected versioned bucket and a prefix-limited publisher identity", async () => {
  const [releases, variables, outputs] = await Promise.all([
    source("infra/yandex/modules/station-releases/main.tf"),
    source("infra/yandex/modules/station-releases/variables.tf"),
    source("infra/yandex/modules/station-releases/outputs.tf"),
  ]);

  assert.match(
    releases,
    /required_providers\s*\{[\s\S]*source\s*=\s*"yandex-cloud\/yandex"[\s\S]*version\s*=\s*"= 0\.215\.0"/,
  );
  const bucket = block(releases, 'resource "yandex_storage_bucket" "releases"');
  assert.match(bucket, /bucket\s*=\s*var\.bucket_name/);
  assert.match(bucket, /folder_id\s*=\s*var\.folder_id/);
  assert.match(bucket, /force_destroy\s*=\s*false/);
  assert.match(bucket, /acl\s*=\s*"private"/);
  assert.doesNotMatch(bucket, /\bgrant\s*\{/);
  assert.match(
    bucket,
    /anonymous_access_flags\s*\{[\s\S]*read\s*=\s*true[\s\S]*list\s*=\s*false[\s\S]*config_read\s*=\s*false/,
  );
  assert.match(bucket, /versioning\s*\{[\s\S]*enabled\s*=\s*true/);
  assert.match(bucket, /lifecycle\s*\{[\s\S]*prevent_destroy\s*=\s*true/);
  assert.doesNotMatch(bucket, /lifecycle_rule|expiration|noncurrent_version_expiration/);

  const publisher = block(
    releases,
    'resource "yandex_iam_service_account" "station_release_publisher"',
  );
  assert.match(publisher, /folder_id\s*=\s*var\.folder_id/);
  const publisherKey = block(
    releases,
    'resource "yandex_iam_service_account_static_access_key" "publisher"',
  );
  assert.match(
    publisherKey,
    /service_account_id\s*=\s*yandex_iam_service_account\.station_release_publisher\.id/,
  );
  assert.match(publisherKey, /pgp_key\s*=\s*var\.publisher_pgp_key/);
  assert.doesNotMatch(publisherKey, /\bsecret_key\s*=/);

  const uploader = block(
    releases,
    'resource "yandex_storage_bucket_iam_binding" "publisher_uploader"',
  );
  assert.match(uploader, /bucket\s*=\s*yandex_storage_bucket\.releases\.bucket/);
  assert.match(uploader, /role\s*=\s*"storage\.uploader"/);
  assert.match(
    uploader,
    /members\s*=\s*\["serviceAccount:\$\{yandex_iam_service_account\.station_release_publisher\.id\}"\]/,
  );

  const policy = block(releases, 'resource "yandex_storage_bucket_policy" "releases"');
  assert.match(policy, /AllowPublicStationReleaseObjects/);
  assert.match(policy, /Principal\s*=\s*"\*"/);
  assert.match(policy, /Action\s*=\s*\["s3:GetObject"\]/);
  assert.match(
    policy,
    /AllowPublisherStationObjects[\s\S]*Action\s*=\s*\["s3:GetObject",\s*"s3:PutObject"\]/,
  );
  assert.match(
    policy,
    /AllowPublisherStationBucketPreflight[\s\S]*Action\s*=\s*\["s3:GetBucketLocation",\s*"s3:ListBucket"\]/,
  );
  assert.match(
    policy,
    /Condition\s*=\s*\{[\s\S]*StringLike\s*=\s*\{[\s\S]*"s3:prefix"\s*=\s*\["station\/\*"\]/,
  );
  assert.match(
    policy,
    /Resource\s*=\s*\["arn:aws:s3:::\$\{yandex_storage_bucket\.releases\.bucket\}\/station\/\*"\]/,
  );
  assert.match(
    policy,
    /AllowTerraformReleaseManagement[\s\S]*CanonicalUser\s*=\s*var\.terraform_service_account_id/,
  );
  assert.doesNotMatch(policy, /DeleteObject|DeleteObjectVersion|s3:Delete/);
  assert.doesNotMatch(
    releases,
    /app_service_account|runtime_service_account|deploy_service_account|backup_service_account/,
  );

  const pgpVariable = block(variables, 'variable "publisher_pgp_key"');
  assert.match(pgpVariable, /type\s*=\s*string/);
  assert.match(pgpVariable, /sensitive\s*=\s*true/);
  for (const outputName of ["publisher_access_key_id", "publisher_encrypted_secret_key"]) {
    assert.match(block(outputs, `output "${outputName}"`), /sensitive\s*=\s*true/);
  }
  assert.match(
    block(outputs, 'output "publisher_encrypted_secret_key"'),
    /yandex_iam_service_account_static_access_key\.publisher\.encrypted_secret_key/,
  );
});

test("Station release CDN uses HTTPS GET/HEAD and origin-owned cache metadata behind an issued certificate", async () => {
  const releases = await source("infra/yandex/modules/station-releases/main.tf");

  const originGroup = block(releases, 'resource "yandex_cdn_origin_group" "releases"');
  assert.match(
    originGroup,
    /origin\s*\{[\s\S]*source\s*=\s*yandex_storage_bucket\.releases\.bucket_domain_name[\s\S]*enabled\s*=\s*true[\s\S]*backup\s*=\s*false/,
  );
  const certificate = block(releases, 'resource "yandex_cm_certificate" "releases"');
  assert.match(certificate, /domains\s*=\s*\[var\.domain\]/);
  assert.match(
    certificate,
    /managed\s*\{[\s\S]*challenge_type\s*=\s*"DNS_CNAME"[\s\S]*challenge_count\s*=\s*1/,
  );
  const validation = block(releases, 'resource "yandex_dns_recordset" "certificate_validation"');
  assert.match(validation, /count\s*=\s*1/);
  assert.doesNotMatch(validation, /public_dns_enabled/);
  assert.match(validation, /yandex_cm_certificate\.releases\.challenges\[count\.index\]\.dns_name/);
  assert.match(validation, /yandex_cm_certificate\.releases\.challenges\[count\.index\]\.dns_type/);
  assert.match(
    validation,
    /yandex_cm_certificate\.releases\.challenges\[count\.index\]\.dns_value/,
  );
  assert.match(
    releases,
    /data\s+"yandex_cm_certificate"\s+"issued"\s*\{[\s\S]*certificate_id\s*=\s*yandex_cm_certificate\.releases\.id[\s\S]*wait_validation\s*=\s*true[\s\S]*depends_on\s*=\s*\[yandex_dns_recordset\.certificate_validation\]/,
  );

  const cdn = block(releases, 'resource "yandex_cdn_resource" "releases"');
  assert.match(cdn, /cname\s*=\s*var\.domain/);
  assert.match(cdn, /active\s*=\s*true/);
  assert.match(cdn, /origin_protocol\s*=\s*"https"/);
  assert.match(cdn, /origin_group_id\s*=\s*yandex_cdn_origin_group\.releases\.id/);
  assert.match(cdn, /redirect_http_to_https\s*=\s*true/);
  assert.match(cdn, /redirect_https_to_http\s*=\s*false/);
  assert.match(cdn, /allowed_http_methods\s*=\s*\["GET",\s*"HEAD"\]/);
  assert.match(cdn, /edge_cache_settings\s*=\s*0/);
  assert.doesNotMatch(cdn, /browser_cache_settings|cache_http_headers/);
  assert.match(
    cdn,
    /static_response_headers\s*=\s*\{[\s\S]*"x-content-type-options"\s*=\s*"nosniff"/,
  );
  assert.match(
    cdn,
    /static_response_headers\s*=\s*\{[\s\S]*"content-security-policy"\s*=\s*"default-src 'none'; frame-ancestors 'none'; sandbox"/,
  );
  assert.match(
    cdn,
    /ssl_certificate\s*\{[\s\S]*type\s*=\s*"certificate_manager"[\s\S]*certificate_manager_id\s*=\s*data\.yandex_cm_certificate\.issued\.id/,
  );

  const publicDns = block(releases, 'resource "yandex_dns_recordset" "public_release"');
  assert.match(publicDns, /count\s*=\s*var\.public_dns_enabled\s*\?\s*1\s*:\s*0/);
  assert.match(publicDns, /name\s*=\s*local\.release_dns_name/);
  assert.match(publicDns, /type\s*=\s*"CNAME"/);
  assert.match(
    publicDns,
    /data\s*=\s*\["\$\{trimsuffix\(yandex_cdn_resource\.releases\.provider_cname, "\."\)\}\."\]/,
  );
  assert.match(publicDns, /depends_on\s*=\s*\[data\.yandex_cm_certificate\.issued\]/);
});

test("production wires the fixed Station release origin behind a separate public DNS gate", async () => {
  const [production, variables, outputs, tfvars] = await Promise.all([
    source("infra/yandex/production/main.tf"),
    source("infra/yandex/production/variables.tf"),
    source("infra/yandex/production/outputs.tf"),
    source("infra/yandex/production/terraform.tfvars.example"),
  ]);

  const releaseModule = block(production, 'module "station_releases"');
  assert.match(releaseModule, /source\s*=\s*"\.\.\/modules\/station-releases"/);
  assert.match(releaseModule, /bucket_name\s*=\s*var\.station_release_bucket_name/);
  assert.match(releaseModule, /domain\s*=\s*var\.station_release_domain/);
  assert.match(releaseModule, /publisher_pgp_key\s*=\s*var\.station_release_publisher_pgp_key/);
  assert.match(releaseModule, /public_dns_enabled\s*=\s*var\.station_release_public_dns_enabled/);
  assert.doesNotMatch(
    releaseModule,
    /app_service_account_id|runtime_secret_id|module\.compute|public_dns_enabled\s*=\s*var\.public_dns_enabled/,
  );

  for (const variableName of [
    "station_release_bucket_name",
    "station_release_domain",
    "station_release_publisher_pgp_key",
    "station_release_public_dns_enabled",
  ]) {
    assert.match(variables, new RegExp(`variable\\s+"${variableName}"\\s*\\{`));
    assert.match(tfvars, new RegExp(`^${variableName}\\s*=`, "m"));
  }
  assert.match(
    block(variables, 'variable "station_release_domain"'),
    /var\.station_release_domain\s*==\s*"releases\.markiro\.app"/,
  );
  assert.match(
    block(variables, 'variable "station_release_publisher_pgp_key"'),
    /sensitive\s*=\s*true/,
  );
  assert.match(
    block(variables, 'variable "station_release_public_dns_enabled"'),
    /default\s*=\s*false/,
  );
  for (const outputName of [
    "station_release_publisher_access_key_id",
    "station_release_publisher_encrypted_secret_key",
  ]) {
    assert.match(block(outputs, `output "${outputName}"`), /sensitive\s*=\s*true/);
  }
  assert.match(outputs, /module\.station_releases\.cdn_provider_cname/);
  assert.match(outputs, /module\.station_releases\.certificate_id/);
});

test("bootstrap retains only state, runtime and the three necessary service accounts", async () => {
  const [bootstrap, bootstrapVariables, bootstrapTfvars, iam, iamVariables] = await Promise.all([
    source("infra/yandex/bootstrap/main.tf"),
    source("infra/yandex/bootstrap/variables.tf"),
    source("infra/yandex/bootstrap/terraform.tfvars.example"),
    source("infra/yandex/modules/iam/main.tf"),
    source("infra/yandex/modules/iam/variables.tf"),
  ]);
  const active = `${bootstrap}\n${iam}`;
  for (const retained of [
    'resource "yandex_storage_bucket" "state"',
    'resource "yandex_lockbox_secret" "runtime"',
    'resource "yandex_lockbox_secret" "state_backend"',
    'resource "yandex_iam_service_account" "terraform"',
    'resource "yandex_iam_service_account" "state"',
    'resource "yandex_iam_service_account" "app"',
    'resource "yandex_iam_workload_identity_federated_credential" "github_infrastructure"',
    'resource "yandex_iam_workload_identity_federated_credential" "github_infrastructure_apply"',
  ])
    assert.match(active, new RegExp(retained.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal([...iam.matchAll(/resource\s+"yandex_iam_service_account"/g)].length, 3);
  assert.equal(
    [...iam.matchAll(/resource\s+"yandex_iam_workload_identity_federated_credential"/g)].length,
    2,
  );
  assert.match(
    block(
      iam,
      'resource "yandex_iam_workload_identity_federated_credential" "github_infrastructure"',
    ),
    /external_subject_id\s*=\s*local\.github_infrastructure_subject/,
  );
  assert.match(
    block(
      iam,
      'resource "yandex_iam_workload_identity_federated_credential" "github_infrastructure_apply"',
    ),
    /external_subject_id\s*=\s*local\.github_infrastructure_apply_subject/,
  );
  for (const [variables, name, exact] of [
    [iamVariables, "github_infrastructure_environment", "production-infrastructure"],
    [iamVariables, "github_infrastructure_apply_environment", "production-infrastructure-apply"],
    [bootstrapVariables, "github_infrastructure_environment", "production-infrastructure"],
    [
      bootstrapVariables,
      "github_infrastructure_apply_environment",
      "production-infrastructure-apply",
    ],
  ]) {
    assert.match(block(variables, `variable "${name}"`), new RegExp(`== "${exact}"`));
  }
  assert.match(
    bootstrap,
    /github_infrastructure_apply_environment\s*=\s*var\.github_infrastructure_apply_environment/,
  );
  assert.match(
    bootstrapTfvars,
    /^github_infrastructure_apply_environment\s*=\s*"production-infrastructure-apply"$/m,
  );
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

test("active Terraform contains no literal credentials and managed release edge resources stay allowlisted", async () => {
  const paths = [
    "infra/yandex/bootstrap/main.tf",
    "infra/yandex/bootstrap/providers.tf",
    "infra/yandex/production/main.tf",
    "infra/yandex/production/providers.tf",
    "infra/yandex/modules/iam/main.tf",
    "infra/yandex/modules/compute/main.tf",
  ];
  const general = (await Promise.all(paths.map(source))).join("\n");
  const releases = await source("infra/yandex/modules/station-releases/main.tf");
  const active = `${general}\n${releases}`;
  assert.doesNotMatch(
    active,
    /access_key\s*=\s*"|secret_key\s*=\s*"|iam_token\s*=\s*"|token\s*=\s*"/i,
  );
  assert.doesNotMatch(general, /static_access_key|hmac_key|yandex_cdn_|yandex_cm_certificate/);
  assert.equal(
    [...releases.matchAll(/resource\s+"yandex_iam_service_account_static_access_key"/g)].length,
    1,
  );
  assert.equal([...releases.matchAll(/resource\s+"yandex_cdn_resource"/g)].length, 1);
  assert.equal([...releases.matchAll(/resource\s+"yandex_cm_certificate"/g)].length, 1);
});

test("infrastructure workflow protects validation, plan and apply without legacy phases", async () => {
  const workflow = await source(".github/workflows/yandex-infrastructure.yml");
  assert.match(workflow, /workflow_dispatch:[\s\S]*target_sha:[\s\S]*enable_public_dns:/);
  assert.match(workflow, /environment:\s*production-infrastructure/);
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /terraform[^\n]+plan[^\n]+-out="\$plan"/);
  assert.equal(
    [...workflow.matchAll(/name:\s*Configure provider mirror/g)].length,
    3,
    "validation, plan and apply must use the Yandex provider mirror",
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

test("infrastructure workflow escrows one reviewed plan between separately protected runs", async () => {
  const workflow = await source(".github/workflows/yandex-infrastructure.yml");

  assert.match(
    workflow,
    /workflow_dispatch:[\s\S]*mode:[\s\S]*options:[\s\S]*- plan[\s\S]*- apply/,
  );
  assert.match(workflow, /plan_key:[\s\S]*type:\s*string/);
  assert.match(workflow, /plan_sha256:[\s\S]*type:\s*string/);
  assert.match(workflow, /plan_version_id:[\s\S]*type:\s*string/);
  const releaseDnsInput = workflow.match(
    /enable_station_release_public_dns:([\s\S]*?)\n\npermissions:/,
  )?.[1];
  assert.ok(releaseDnsInput);
  assert.match(releaseDnsInput, /required:\s*true/);
  assert.match(releaseDnsInput, /default:\s*false/);
  assert.match(releaseDnsInput, /type:\s*boolean/);

  const planStart = workflow.indexOf("  plan:\n");
  const applyStart = workflow.indexOf("  apply:\n");
  assert.ok(planStart > -1 && applyStart > planStart);
  const planJob = workflow.slice(planStart, applyStart);
  const applyJob = workflow.slice(applyStart);

  assert.match(planJob, /if:.*inputs\.mode == 'plan'/);
  assert.match(planJob, /environment:\s*production-infrastructure/);
  assert.match(applyJob, /if:.*inputs\.mode == 'apply'/);
  assert.match(applyJob, /environment:\s*production-infrastructure-apply/);

  assert.match(planJob, /terraform[^\n]+plan[^\n]+-out="\$plan"/);
  assert.doesNotMatch(planJob, /terraform[^\n]+\sapply(?:\s|$)/);
  assert.match(applyJob, /terraform[^\n]+apply[^\n]+"\$plan"/);
  assert.doesNotMatch(applyJob, /terraform[^\n]+\splan(?:\s|$)/);

  for (const job of [planJob, applyJob]) {
    assert.match(job, /\[\[ "\$TARGET_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
    assert.match(job, /\[\[ "\$GITHUB_REF" == "refs\/heads\/main" \]\]/);
    assert.match(job, /\[\[ "\$\(git rev-parse HEAD\)" == "\$TARGET_SHA" \]\]/);
    assert.match(job, /case "\$ENABLE_PUBLIC_DNS" in true\|false\)/);
    assert.match(job, /case "\$ENABLE_STATION_RELEASE_PUBLIC_DNS" in true\|false\)/);
    assert.match(
      job,
      /export TF_VAR_public_dns_enabled="\$ENABLE_PUBLIC_DNS"[\s\S]*export TF_VAR_station_release_public_dns_enabled="\$ENABLE_STATION_RELEASE_PUBLIC_DNS"/,
    );
    assert.match(job, /node infra\/yandex\/scripts\/guard-production-plan\.mjs "\$plan_json"/);
  }

  assert.match(
    planJob,
    /plan_key="production\/plans\/\$\{GITHUB_RUN_ID\}\/\$\{GITHUB_RUN_ATTEMPT\}\/\$\{TARGET_SHA\}\/\$\{ENABLE_PUBLIC_DNS\}-\$\{ENABLE_STATION_RELEASE_PUBLIC_DNS\}\/production\.tfplan"/,
  );
  assert.match(planJob, /\[\[ "\$GITHUB_RUN_ATTEMPT" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/);
  assert.match(planJob, /plan_sha256=.*sha256sum "\$plan"/);
  assert.match(planJob, /aws s3api put-object[\s\S]*--bucket "\$YC_STATE_BUCKET_NAME"/);
  assert.match(planJob, /--key "\$plan_key"[\s\S]*--body "\$plan"/);
  assert.match(planJob, /--metadata[\s\S]*target-sha=.*enable-public-dns=.*source-run-attempt=/);
  assert.match(planJob, /plan_version_id="\$\(jq -er '\.VersionId' "\$put_response"\)"/);
  assert.match(planJob, /\[\[ "\$plan_version_id" =~ \^\[A-Za-z0-9\._\+\/=\-\]\{1,256\}\$ \]\]/);
  assert.match(planJob, /\[\[ "\$plan_version_id" != "null" \]\]/);
  assert.match(planJob, /printf 'plan_version_id=%s\\n' "\$plan_version_id" >> "\$GITHUB_OUTPUT"/);
  assert.match(planJob, /Terraform plan escrow::plan_key=%s plan_sha256=%s plan_version_id=%s/);

  assert.match(applyJob, /PLAN_KEY:\s*\$\{\{ inputs\.plan_key \}\}/);
  assert.match(applyJob, /PLAN_SHA256:\s*\$\{\{ inputs\.plan_sha256 \}\}/);
  assert.match(applyJob, /PLAN_VERSION_ID:\s*\$\{\{ inputs\.plan_version_id \}\}/);
  assert.match(applyJob, /\[\[ "\$PLAN_SHA256" =~ \^\[0-9a-f\]\{64\}\$ \]\]/);
  assert.match(applyJob, /\[\[ "\$PLAN_KEY" =~ \^production\\\/plans\\\//);
  assert.match(applyJob, /\[\[ "\$PLAN_VERSION_ID" =~ \^\[A-Za-z0-9\._\+\/=\-\]\{1,256\}\$ \]\]/);
  assert.match(applyJob, /\[\[ "\$PLAN_VERSION_ID" != "null" \]\]/);
  assert.ok(
    applyJob.indexOf('[[ "$PLAN_VERSION_ID" =~') < applyJob.indexOf('github_oidc_token="$(curl'),
    "the reviewer-supplied VersionId must be validated before authentication",
  );
  assert.match(applyJob, /aws s3api head-object[\s\S]*--key "\$PLAN_KEY"/);
  assert.match(applyJob, /aws s3api get-object[\s\S]*--key "\$PLAN_KEY"/);
  assert.match(
    applyJob,
    /--arg plan_version_id "\$PLAN_VERSION_ID"[\s\S]*\.VersionId == \$plan_version_id/,
  );
  assert.match(applyJob, /\.Metadata[\s\S]*target-sha[\s\S]*source-run-attempt/);
  const objectCommands = [
    ...applyJob.matchAll(
      /aws s3api (head-object|get-object|delete-object) \\\n(?:[^\n]*\\\n)*[^\n]*/g,
    ),
  ];
  assert.equal(objectCommands.length, 4);
  assert.deepEqual(
    objectCommands.map((match) => match[1]),
    ["head-object", "get-object", "delete-object", "head-object"],
  );
  for (const command of objectCommands) {
    assert.match(command[0], /--version-id "\$PLAN_VERSION_ID"/);
  }
  assert.doesNotMatch(applyJob, /plan_version_id="\$\(jq/);
  const hashGuard = applyJob.indexOf("sha256sum --check --status");
  const apply = applyJob.indexOf("terraform -chdir=infra/yandex/production apply");
  assert.ok(hashGuard > -1 && apply > hashGuard, "exact plan hash must be verified before apply");
  const deleteEscrow = applyJob.indexOf("aws s3api delete-object", apply);
  assert.ok(deleteEscrow > apply, "the exact escrowed plan version must be deleted after apply");
  assert.equal([...applyJob.matchAll(/--version-id "\$PLAN_VERSION_ID"/g)].length, 4);

  assert.match(
    workflow,
    /ENABLE_STATION_RELEASE_PUBLIC_DNS:\s*\$\{\{ inputs\.enable_station_release_public_dns \}\}/,
  );
  assert.match(
    workflow,
    /TF_VAR_station_release_bucket_name:\s*\$\{\{ vars\.YC_STATION_RELEASE_BUCKET_NAME \}\}/,
  );
  assert.match(
    workflow,
    /TF_VAR_station_release_domain:\s*\$\{\{ vars\.MARKIRO_STATION_RELEASE_DOMAIN \}\}/,
  );
  assert.match(
    workflow,
    /TF_VAR_station_release_publisher_pgp_key:\s*\$\{\{ vars\.YC_STATION_RELEASE_PUBLISHER_PGP_KEY \}\}/,
  );
  assert.doesNotMatch(workflow, /YANDEX_STATION_RELEASE_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
  assert.doesNotMatch(workflow, /terraform[^\n]*\soutput(?:\s|$)/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact/);
  assert.doesNotMatch(workflow, /GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(
    workflow,
    /(?:--access-key|--secret-key|access_key\s*=\s*\$\{\{|secret_key\s*=\s*\$\{\{)/i,
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

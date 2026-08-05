import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

async function readRepositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function terraformBlock(source, kind, type, name) {
  const declaration = new RegExp(`${kind}\\s+"${type}"\\s+"${name}"\\s*\\{`).exec(source);
  assert.ok(declaration, `missing ${kind} ${type}.${name}`);

  const openingBrace = source.indexOf("{", declaration.index);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(declaration.index, index + 1);
  }
  assert.fail(`unterminated ${kind} ${type}.${name}`);
}

function resourceBlock(source, type, name) {
  return terraformBlock(source, "resource", type, name);
}

function allResources(source, type) {
  return [...source.matchAll(new RegExp(`resource\\s+"${type}"\\s+"([^"]+)"`, "g"))].map(
    (match) => match[1],
  );
}

async function integrationSources() {
  const [iam, iamVariables, bootstrap, compute, production, observability, workflow] =
    await Promise.all([
      readRepositoryFile("infra/yandex/modules/iam/main.tf"),
      readRepositoryFile("infra/yandex/modules/iam/variables.tf"),
      readRepositoryFile("infra/yandex/bootstrap/main.tf"),
      readRepositoryFile("infra/yandex/modules/compute/main.tf"),
      readRepositoryFile("infra/yandex/production/main.tf"),
      readRepositoryFile("infra/yandex/modules/observability/main.tf"),
      readRepositoryFile(".github/workflows/deploy-production.yml"),
    ]);
  return { bootstrap, compute, iam, iamVariables, observability, production, workflow };
}

function assertIntegratedGraph(sources) {
  const { bootstrap, compute, iam, iamVariables, observability, production, workflow } =
    sources;

  assert.deepEqual(
    allResources(iam, "yandex_iam_service_account").sort(),
    ["app", "audit", "deployment_controller", "runner", "state", "terraform"],
  );
  assert.match(
    resourceBlock(compute, "yandex_compute_instance", "runner"),
    /service_account_id\s*=\s*var\.runner_service_account_id/,
  );
  assert.doesNotMatch(compute, /runner_vm_service_account_id|service_account_id\s*=\s*var\.deployment_controller_service_account_id/);

  assert.deepEqual(
    allResources(iam, "yandex_iam_workload_identity_federated_credential").sort(),
    ["github_infrastructure", "github_production_cleanup", "github_production_controller"],
  );
  for (const [name, account, subject] of [
    ["github_production_controller", "deployment_controller", "github_controller_subject"],
    ["github_production_cleanup", "deployment_controller", "github_cleanup_subject"],
    ["github_infrastructure", "terraform", "github_infrastructure_subject"],
  ]) {
    const credential = resourceBlock(iam, "yandex_iam_workload_identity_federated_credential", name);
    assert.match(credential, new RegExp(`service_account_id\\s*=\\s*yandex_iam_service_account\\.${account}\\.id`));
    assert.match(credential, new RegExp(`external_subject_id\\s*=\\s*local\\.${subject}`));
  }
  assert.match(iamVariables, /var\.github_controller_environment\s*==\s*"production-controller"/);
  assert.match(iamVariables, /var\.github_cleanup_environment\s*==\s*"production-cleanup"/);
  assert.match(iamVariables, /var\.github_infrastructure_environment\s*==\s*"production-infrastructure"/);
  assert.match(
    iam,
    /github_controller_subject\s*=\s*"repo:\$\{var\.github_repository\}:environment:\$\{var\.github_controller_environment\}"/,
  );
  assert.match(
    iam,
    /github_cleanup_subject\s*=\s*"repo:\$\{var\.github_repository\}:environment:\$\{var\.github_cleanup_environment\}"/,
  );
  assert.doesNotMatch(iam, /environment:production-deploy|github_deploy|runner.*federated_credential/);
  const federationUsers = resourceBlock(
    iam,
    "yandex_iam_workload_identity_oidc_federation_iam_binding",
    "terraform_user",
  );
  assert.match(federationUsers, /yandex_iam_service_account\.terraform\.id/);
  assert.match(federationUsers, /yandex_iam_service_account\.deployment_controller\.id/);
  assert.doesNotMatch(federationUsers, /yandex_iam_service_account\.(?:app|runner|state|audit)\.id/);

  const runnerEditor = resourceBlock(compute, "yandex_compute_instance_iam_binding", "runner_editor");
  assert.match(runnerEditor, /instance_id\s*=\s*yandex_compute_instance\.runner\.id/);
  assert.match(runnerEditor, /role\s*=\s*"compute\.editor"/);
  assert.match(runnerEditor, /deployment_controller_service_account_id/);
  assert.match(runnerEditor, /runner_service_account_id/);
  assert.doesNotMatch(
    [iam, compute].join("\n"),
    /yandex_resourcemanager_folder_iam_(?:member|binding)[\s\S]{0,500}?role\s*=\s*"compute\.(?:editor|admin|operator)"/,
  );
  for (const [name, role, member] of [
    ["deployment_controller_app_viewer", "compute.viewer", "deployment_controller_service_account_id"],
    ["runner_app_viewer", "compute.viewer", "runner_service_account_id"],
    ["runner_app_os_login", "compute.osAdminLogin", "runner_service_account_id"],
  ]) {
    const grant = resourceBlock(compute, "yandex_compute_instance_iam_binding", name);
    assert.match(grant, new RegExp(`role\\s*=\\s*"${role.replaceAll(".", "\\.")}"`));
    assert.match(grant, new RegExp(member));
  }

  for (const [name, account] of [
    ["terraform_key_user", "terraform"],
    ["deployment_controller_runner_key_user", "deployment_controller"],
  ]) {
    const grant = resourceBlock(bootstrap, "yandex_kms_symmetric_key_iam_member", name);
    assert.match(grant, /symmetric_key_id\s*=\s*var\.kms_key_id/);
    assert.match(grant, /role\s*=\s*"kms\.keys\.user"/);
    assert.match(grant, new RegExp(`service_account_ids\\.${account}`));
  }

  const expectedSecretReaders = [
    ["app_runtime", "runtime_secret_id", "app"],
    ["runner_registry", "registry_secret_id", "runner"],
    ["deployment_controller_runner_registration", "runner_registration_secret_id", "deployment_controller"],
    ["terraform_state_backend", "state_backend_secret_id", "terraform"],
  ];
  assert.deepEqual(
    allResources(iam, "yandex_lockbox_secret_iam_member").sort(),
    expectedSecretReaders.map(([name]) => name).sort(),
  );
  for (const [name, secret, account] of expectedSecretReaders) {
    const grant = resourceBlock(iam, "yandex_lockbox_secret_iam_member", name);
    assert.match(grant, new RegExp(`secret_id\\s*=\\s*var\\.${secret}`));
    assert.match(grant, /role\s*=\s*"lockbox\.payloadViewer"/);
    assert.match(grant, new RegExp(`yandex_iam_service_account\\.${account}\\.id`));
  }
  assert.match(bootstrap, /registry_secret_id\s*=\s*yandex_lockbox_secret\.registry\.id/);
  const auditedSecrets = production;
  assert.match(
    auditedSecrets,
    /lockbox_secret_ids\s*=\s*toset\(\[\s*var\.runtime_secret_id,\s*var\.registry_secret_id,\s*var\.runner_registration_secret_id,?\s*\]\)/s,
  );

  for (const [name, role, account] of [
    ["app_monitoring_editor", "monitoring.editor", "app"],
    ["app_logging_writer", "logging.writer", "app"],
    ["app_alb_viewer", "alb.viewer", "app"],
    ["app_postgres_viewer", "managed-postgresql.viewer", "app"],
    ["runner_monitoring_editor", "monitoring.editor", "runner"],
    ["runner_logging_writer", "logging.writer", "runner"],
    ["deployment_controller_alb_viewer", "alb.viewer", "deployment_controller"],
    ["deployment_controller_postgres_viewer", "managed-postgresql.viewer", "deployment_controller"],
  ]) {
    const grant = resourceBlock(iam, "yandex_resourcemanager_folder_iam_member", name);
    assert.match(grant, new RegExp(`role\\s*=\\s*"${role.replaceAll(".", "\\.")}"`));
    assert.match(grant, new RegExp(`yandex_iam_service_account\\.${account}\\.id`));
  }
  const runnerAlb = resourceBlock(iam, "yandex_resourcemanager_folder_iam_member", "runner_alb_viewer");
  assert.match(runnerAlb, /role\s*=\s*"alb\.viewer"/);
  assert.match(runnerAlb, /yandex_iam_service_account\.runner\.id/);
  assert.doesNotMatch(
    [iam, compute].join("\n"),
    /serviceAccount:\$\{yandex_iam_service_account\.(?:app|runner|deployment_controller)\.id\}[\s\S]{0,120}?role\s*=\s*"(?:admin|editor)"/,
  );

  assert.match(production, /resource\s+"yandex_logging_group"\s+"application"/);
  assert.match(production, /application_log_group_id\s*=\s*yandex_logging_group\.application\.id/g);
  assert.match(observability, /resource\s+"yandex_logging_group"\s+"security"/);
  assert.doesNotMatch(observability, /resource\s+"yandex_logging_group"\s+"application"/);
  assert.doesNotMatch(compute, /default_log_group|application_log_group_id\s*=\s*var\.folder_id/);

  assert.match(workflow, /environment:\s*production-controller/);
  assert.match(workflow, /environment:\s*production-cleanup/);
  assert.match(workflow, /environment:\s*production-deploy/);
  const deployJob = workflow.slice(workflow.indexOf("  deploy:"), workflow.indexOf("  cleanup:"));
  assert.match(deployJob, /id-token:\s*["']?none["']?/);
  assert.doesNotMatch(deployJob, /YC_DEPLOYMENT_CONTROLLER_SERVICE_ACCOUNT_ID|workload-identity/);
}

test("integrated Yandex graph preserves exact production identity, secret, role, and log boundaries", async () => {
  assertIntegratedGraph(await integrationSources());
});

test("combined graph contract rejects boundary regressions", async () => {
  const sources = await integrationSources();
  for (const [name, mutate] of [
    ["shared OIDC subject", (graph) => ({ ...graph, iam: graph.iam.replace("environment:${var.github_cleanup_environment}", "environment:${var.github_controller_environment}") })],
    ["deploy OIDC", (graph) => ({ ...graph, iam: graph.iam.replace("github_production_cleanup", "github_production_deploy") })],
    ["Terraform exchange", (graph) => ({ ...graph, iam: graph.iam.replace("yandex_iam_service_account.terraform.id", "yandex_iam_service_account.runner.id") })],
    ["identity reuse", (graph) => ({ ...graph, compute: graph.compute.replace("service_account_id        = var.runner_service_account_id", "service_account_id        = var.deployment_controller_service_account_id") })],
    ["folder metadata editor", (graph) => ({ ...graph, compute: graph.compute.replace('resource "yandex_compute_instance_iam_binding" "runner_editor"', 'resource "yandex_resourcemanager_folder_iam_member" "runner_editor"') })],
    ["runner role", (graph) => ({ ...graph, compute: graph.compute.replace('role = "compute.editor"', 'role = "compute.operator"') })],
    ["secret crossover", (graph) => ({ ...graph, iam: graph.iam.replace("secret_id = var.registry_secret_id", "secret_id = var.runtime_secret_id") })],
    ["KMS role", (graph) => ({ ...graph, bootstrap: graph.bootstrap.replace('role             = "kms.keys.user"', 'role             = "kms.keys.encrypterDecrypter"') })],
    ["producer role", (graph) => ({ ...graph, iam: graph.iam.replace('role      = "monitoring.editor"', 'role      = "monitoring.viewer"') })],
    ["log group", (graph) => ({ ...graph, compute: graph.compute.replace("var.application_log_group_id", "var.folder_id") })],
  ]) {
    assert.throws(() => assertIntegratedGraph(mutate(structuredClone(sources))), undefined, name);
  }
});

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

function outputBlock(source, name) {
  const declaration = new RegExp(`output\\s+"${name}"\\s*\\{`).exec(source);
  assert.ok(declaration, `missing output ${name}`);
  const openingBrace = source.indexOf("{", declaration.index);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(declaration.index, index + 1);
  }
  assert.fail(`unterminated output ${name}`);
}

function resources(source, type) {
  return [...source.matchAll(new RegExp(`resource\\s+"${type}"\\s+"([^"]+)"`, "g"))].map(
    (match) => match[1],
  );
}

async function integrationSources() {
  const entries = await Promise.all(
    Object.entries({
      bootstrap: "infra/yandex/bootstrap/main.tf",
      bootstrapOutputs: "infra/yandex/bootstrap/outputs.tf",
      compute: "infra/yandex/modules/compute/main.tf",
      iam: "infra/yandex/modules/iam/main.tf",
      iamVariables: "infra/yandex/modules/iam/variables.tf",
      production: "infra/yandex/production/main.tf",
      productionOutputs: "infra/yandex/production/outputs.tf",
      productionVariables: "infra/yandex/production/variables.tf",
      productionTfvars: "infra/yandex/production/terraform.tfvars.example",
      workflow: ".github/workflows/yandex-infrastructure.yml",
    }).map(async ([name, file]) => [name, await readRepositoryFile(file)]),
  );
  return Object.fromEntries(entries);
}

function assertIntegratedGraph(sources) {
  const {
    bootstrap,
    bootstrapOutputs,
    compute,
    iam,
    iamVariables,
    production,
    productionOutputs,
    productionVariables,
    productionTfvars,
    workflow,
  } = sources;

  assert.deepEqual(resources(iam, "yandex_iam_service_account").sort(), [
    "app",
    "audit",
    "deployment_controller",
    "state",
    "terraform",
  ]);
  assert.deepEqual(resources(iam, "yandex_iam_workload_identity_federated_credential").sort(), [
    "github_deploy",
    "github_infrastructure",
  ]);
  assert.match(iamVariables, /var\.github_deploy_environment\s*==\s*"production-deploy"/);
  assert.match(
    iamVariables,
    /var\.github_infrastructure_environment\s*==\s*"production-infrastructure"/,
  );
  assert.doesNotMatch(iamVariables, /github_(?:controller|cleanup)_environment/);
  assert.match(
    iam,
    /github_deploy_subject\s*=\s*"repo:\$\{local\.github_repository_subject\}:environment:\$\{var\.github_deploy_environment\}"/,
  );
  assert.doesNotMatch(
    iam,
    /production-controller|production-cleanup|github_(?:controller|cleanup)_subject/,
  );

  const deployCredential = resourceBlock(
    iam,
    "yandex_iam_workload_identity_federated_credential",
    "github_deploy",
  );
  assert.match(
    deployCredential,
    /service_account_id\s*=\s*yandex_iam_service_account\.deployment_controller\.id/,
  );
  assert.match(deployCredential, /external_subject_id\s*=\s*local\.github_deploy_subject/);
  const infrastructureCredential = resourceBlock(
    iam,
    "yandex_iam_workload_identity_federated_credential",
    "github_infrastructure",
  );
  assert.match(
    infrastructureCredential,
    /service_account_id\s*=\s*yandex_iam_service_account\.terraform\.id/,
  );

  const federationUsers = resourceBlock(
    iam,
    "yandex_iam_workload_identity_oidc_federation_iam_binding",
    "terraform_user",
  );
  assert.match(federationUsers, /yandex_iam_service_account\.terraform\.id/);
  assert.match(federationUsers, /yandex_iam_service_account\.deployment_controller\.id/);
  assert.doesNotMatch(federationUsers, /yandex_iam_service_account\.(?:app|audit|state)\.id/);

  const expectedPayloadReaders = [
    ["app_runtime", "runtime_secret_id", "app"],
    ["deployment_controller_registry", "registry_secret_id", "deployment_controller"],
    ["terraform_state_backend", "state_backend_secret_id", "terraform"],
  ];
  assert.deepEqual(
    resources(iam, "yandex_lockbox_secret_iam_member").sort(),
    [...expectedPayloadReaders.map(([name]) => name), "terraform_audit_scope_viewer"].sort(),
  );
  for (const [name, secret, account] of expectedPayloadReaders) {
    const reader = resourceBlock(iam, "yandex_lockbox_secret_iam_member", name);
    assert.match(reader, new RegExp(`secret_id\\s*=\\s*var\\.${secret}`));
    assert.match(reader, /role\s*=\s*"lockbox\.payloadViewer"/);
    assert.match(reader, new RegExp(`yandex_iam_service_account\\.${account}\\.id`));
  }
  const auditScope = resourceBlock(
    iam,
    "yandex_lockbox_secret_iam_member",
    "terraform_audit_scope_viewer",
  );
  assert.match(
    auditScope,
    /for_each\s*=\s*\{\s*registry\s*=\s*var\.registry_secret_id\s*runtime\s*=\s*var\.runtime_secret_id,?\s*\}/,
  );
  assert.doesNotMatch(auditScope, /state_backend|runner_registration/);

  const appViewer = resourceBlock(
    compute,
    "yandex_compute_instance_iam_binding",
    "deployment_controller_app_viewer",
  );
  assert.match(appViewer, /role\s*=\s*"compute\.viewer"/);
  assert.match(appViewer, /deployment_controller_service_account_id/);
  assert.equal(resources(compute, "yandex_compute_instance").length, 1);
  assert.doesNotMatch(compute, /runner/);

  for (const [name, role] of [
    ["deployment_controller_alb_viewer", "alb.viewer"],
    ["deployment_controller_postgres_viewer", "managed-postgresql.viewer"],
    ["deployment_controller_compute_operation_auditor", "compute.auditor"],
  ]) {
    const grant = resourceBlock(iam, "yandex_resourcemanager_folder_iam_member", name);
    assert.match(grant, new RegExp(`role\\s*=\\s*"${role.replaceAll(".", "\\.")}"`));
    assert.match(grant, /yandex_iam_service_account\.deployment_controller\.id/);
  }
  assert.doesNotMatch(
    iam,
    /serviceAccount:\$\{yandex_iam_service_account\.deployment_controller\.id\}[\s\S]{0,160}?role\s*=\s*"(?:admin|editor)"/,
  );

  const tombstone = resourceBlock(bootstrap, "yandex_lockbox_secret", "runner_registration");
  assert.match(tombstone, /prevent_destroy\s*=\s*true/);
  assert.match(
    outputBlock(bootstrapOutputs, "runner_registration_tombstone_secret_id"),
    /sensitive\s*=\s*true/,
  );
  assert.doesNotMatch(iam + production, /runner_registration/);
  assert.doesNotMatch(bootstrap, /runner_registration_secret_id\s*=/);

  assert.match(productionVariables, /variable\s+"app_deploy_ssh_public_key"\s*\{/);
  assert.match(production, /app_deploy_ssh_public_key\s*=\s*var\.app_deploy_ssh_public_key/);
  assert.doesNotMatch(
    productionVariables + production + productionOutputs,
    /runner_service_account_id|runner_instance_id|management_subnet_cidr|runner_registration_secret_id/,
  );
  assert.doesNotMatch(
    productionTfvars,
    /runner_service_account_id|management_subnet_cidr|runner_registration_secret_id/,
  );

  const publicKeyEnv = "TF_VAR_app_deploy_ssh_public_key: ${{ vars.YC_APP_DEPLOY_SSH_PUBLIC_KEY }}";
  assert.equal(workflow.split(publicKeyEnv).length - 1, 2);
  assert.doesNotMatch(
    workflow,
    /YC_APP_DEPLOY_SSH_PRIVATE_KEY|TF_VAR_runner_|YC_RUNNER_|YC_MANAGEMENT_SUBNET_CIDR/,
  );
  assert.doesNotMatch(workflow, /production-controller|production-cleanup/);
}

test("integrated Yandex graph uses one hosted deploy identity and no active runner graph", async () => {
  assertIntegratedGraph(await integrationSources());
});

test("combined graph rejects runner, subject, secret and SSH-boundary regressions", async () => {
  const sources = await integrationSources();
  const mutations = [
    [
      "runner identity",
      { ...sources, iam: `${sources.iam}\nresource "yandex_iam_service_account" "runner" {}` },
    ],
    [
      "controller subject",
      {
        ...sources,
        iamVariables: sources.iamVariables.replace("production-deploy", "production-controller"),
      },
    ],
    [
      "extra deploy subject",
      {
        ...sources,
        iam: `${sources.iam}\nresource "yandex_iam_workload_identity_federated_credential" "extra" {}`,
      },
    ],
    [
      "controller runtime payload",
      {
        ...sources,
        iam: sources.iam.replace(
          "secret_id = var.registry_secret_id",
          "secret_id = var.runtime_secret_id",
        ),
      },
    ],
    [
      "active tombstone",
      {
        ...sources,
        iam: sources.iam.replace(
          "runtime  = var.runtime_secret_id",
          "runner_registration = var.runner_registration_secret_id\n    runtime = var.runtime_secret_id",
        ),
      },
    ],
    [
      "private key in Terraform",
      {
        ...sources,
        workflow: sources.workflow.replace(
          "YC_APP_DEPLOY_SSH_PUBLIC_KEY",
          "YC_APP_DEPLOY_SSH_PRIVATE_KEY",
        ),
      },
    ],
  ];
  for (const [name, mutation] of mutations) {
    assert.notDeepEqual(mutation, sources, `${name} mutation must change a source`);
    assert.throws(() => assertIntegratedGraph(mutation), undefined, name);
  }
});

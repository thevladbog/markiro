terraform {
  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "= 0.215.0"
    }
  }
}

locals {
  github_owner                  = split("/", var.github_repository)[0]
  github_audience               = "https://github.com/${local.github_owner}"
  github_controller_subject     = "repo:${var.github_repository}:environment:${var.github_controller_environment}"
  github_cleanup_subject        = "repo:${var.github_repository}:environment:${var.github_cleanup_environment}"
  github_infrastructure_subject = "repo:${var.github_repository}:environment:${var.github_infrastructure_environment}"
}

resource "yandex_iam_service_account" "terraform" {
  name        = "markiro-production-terraform"
  description = "Workload-federated Terraform production management identity."
  folder_id   = var.folder_id
  labels      = var.labels
}

resource "yandex_iam_service_account" "state" {
  name        = "markiro-production-state"
  description = "Terraform state backend identity; HMAC credentials are created out of band."
  folder_id   = var.folder_id
  labels      = var.labels
}

resource "yandex_iam_service_account" "app" {
  name        = "markiro-production-app"
  description = "Application runtime identity."
  folder_id   = var.folder_id
  labels      = var.labels
}

resource "yandex_iam_service_account" "runner" {
  name        = "markiro-production-runner"
  description = "Ephemeral deployment runner identity."
  folder_id   = var.folder_id
  labels      = var.labels
}

resource "yandex_iam_service_account" "deployment_controller" {
  name        = "markiro-production-deployment-controller"
  description = "GitHub deployment-controller identity limited to deployment gates and runner control."
  folder_id   = var.folder_id
  labels      = var.labels
}

resource "yandex_iam_service_account" "audit" {
  name        = "markiro-production-audit"
  description = "Audit destination writer; destination-level access is defined with each destination."
  folder_id   = var.folder_id
  labels      = var.labels
}

resource "yandex_iam_workload_identity_oidc_federation" "github" {
  name        = "markiro-production-github"
  description = "GitHub Actions production federation for Yandex organization ${var.organization_id}."
  folder_id   = var.folder_id
  labels      = var.labels

  audiences = [local.github_audience]
  issuer    = "https://token.actions.githubusercontent.com"
  jwks_url  = "https://token.actions.githubusercontent.com/.well-known/jwks"
  disabled  = false
}

resource "yandex_iam_workload_identity_oidc_federation_iam_binding" "terraform_user" {
  federation_id = yandex_iam_workload_identity_oidc_federation.github.id
  role          = "iam.workloadIdentityFederations.user"
  members = [
    "serviceAccount:${yandex_iam_service_account.terraform.id}",
    "serviceAccount:${yandex_iam_service_account.deployment_controller.id}",
  ]
}

resource "yandex_iam_workload_identity_federated_credential" "github_production_controller" {
  service_account_id  = yandex_iam_service_account.deployment_controller.id
  federation_id       = yandex_iam_workload_identity_oidc_federation.github.id
  external_subject_id = local.github_controller_subject
}

resource "yandex_iam_workload_identity_federated_credential" "github_production_cleanup" {
  service_account_id  = yandex_iam_service_account.deployment_controller.id
  federation_id       = yandex_iam_workload_identity_oidc_federation.github.id
  external_subject_id = local.github_cleanup_subject
}

resource "yandex_iam_workload_identity_federated_credential" "github_infrastructure" {
  service_account_id  = yandex_iam_service_account.terraform.id
  federation_id       = yandex_iam_workload_identity_oidc_federation.github.id
  external_subject_id = local.github_infrastructure_subject
}

resource "yandex_storage_bucket_iam_binding" "state_backend" {
  bucket  = var.state_bucket_name
  role    = "storage.editor"
  members = ["serviceAccount:${yandex_iam_service_account.state.id}"]
}

resource "yandex_lockbox_secret_iam_member" "app_runtime" {
  secret_id = var.runtime_secret_id
  role      = "lockbox.payloadViewer"
  member    = "serviceAccount:${yandex_iam_service_account.app.id}"
}

resource "yandex_lockbox_secret_iam_member" "terraform_state_backend" {
  secret_id = var.state_backend_secret_id
  role      = "lockbox.payloadViewer"
  member    = "serviceAccount:${yandex_iam_service_account.terraform.id}"
}

resource "yandex_lockbox_secret_iam_member" "runner_registry" {
  secret_id = var.registry_secret_id
  role      = "lockbox.payloadViewer"
  member    = "serviceAccount:${yandex_iam_service_account.runner.id}"
}

resource "yandex_lockbox_secret_iam_member" "deployment_controller_runner_registration" {
  secret_id = var.runner_registration_secret_id
  role      = "lockbox.payloadViewer"
  member    = "serviceAccount:${yandex_iam_service_account.deployment_controller.id}"
}

# Bootstrap is applied by a protected operator. These service-specific roles are
# the complete production Terraform capability set; it deliberately receives no
# primitive editor/admin role and cannot change IAM bindings beyond services that
# explicitly require their own administrative role.
locals {
  # This action-to-role map is kept explicit so every resource action in the
  # production graph has a reviewable least-privilege grant.
  terraform_production_action_roles = {
    "alb.resources.manage"                                  = "alb.editor"
    "audit-trails.trails.manage"                            = "audit-trails.editor"
    "certificate-manager.certificates.download-for-alb-tls" = "certificate-manager.certificates.downloader"
    "certificate-manager.certificates.manage"               = "certificate-manager.editor"
    "compute.instances-and-access.manage"                   = "compute.admin"
    "dns.recordsets.manage"                                 = "dns.editor"
    "logging.groups.manage"                                 = "logging.editor"
    "managed-postgresql.resources.manage"                   = "managed-postgresql.editor"
    "monitoring.dashboards.manage"                          = "monitoring.editor"
    "smart-web-security.resources.manage"                   = "smart-web-security.editor"
    "storage.buckets-and-policies.manage"                   = "storage.admin"
    "vpc.gateways.attach-to-routes"                         = "vpc.gateways.user"
    "vpc.gateways.manage"                                   = "vpc.gateways.editor"
    "vpc.networks-subnets-routes.manage"                    = "vpc.privateAdmin"
    "vpc.public-addresses.manage"                           = "vpc.publicAdmin"
    "vpc.resources.use"                                     = "vpc.user"
    "vpc.security-groups.manage"                            = "vpc.securityGroups.admin"
  }
  terraform_folder_roles = toset(values(local.terraform_production_action_roles))
}

resource "yandex_resourcemanager_folder_iam_member" "terraform_service_role" {
  for_each = local.terraform_folder_roles

  folder_id = var.folder_id
  role      = each.value
  member    = "serviceAccount:${yandex_iam_service_account.terraform.id}"
}

resource "yandex_iam_service_account_iam_member" "terraform_service_account_user" {
  for_each = {
    app    = yandex_iam_service_account.app.id
    runner = yandex_iam_service_account.runner.id
    audit  = yandex_iam_service_account.audit.id
  }

  service_account_id = each.value
  role               = "iam.serviceAccounts.user"
  member             = "serviceAccount:${yandex_iam_service_account.terraform.id}"
}

# iam.serviceAccounts.user already authorizes ServiceAccount.Get for app,
# runner, and audit. These resource-scoped viewer bindings complete the exact
# five-identity provenance check without exposing every account in the folder.
resource "yandex_iam_service_account_iam_member" "terraform_service_account_viewer" {
  for_each = {
    deployment_controller = yandex_iam_service_account.deployment_controller.id
    terraform              = yandex_iam_service_account.terraform.id
  }

  service_account_id = each.value
  role               = "viewer"
  member             = "serviceAccount:${yandex_iam_service_account.terraform.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "deployment_controller_alb_viewer" {
  folder_id = var.folder_id
  role      = "alb.viewer"
  member    = "serviceAccount:${yandex_iam_service_account.deployment_controller.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "deployment_controller_postgres_viewer" {
  folder_id = var.folder_id
  role      = "managed-postgresql.viewer"
  member    = "serviceAccount:${yandex_iam_service_account.deployment_controller.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "app_monitoring_editor" {
  folder_id = var.folder_id
  role      = "monitoring.editor"
  member    = "serviceAccount:${yandex_iam_service_account.app.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "app_logging_writer" {
  folder_id = var.folder_id
  role      = "logging.writer"
  member    = "serviceAccount:${yandex_iam_service_account.app.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "app_alb_viewer" {
  folder_id = var.folder_id
  role      = "alb.viewer"
  member    = "serviceAccount:${yandex_iam_service_account.app.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "app_postgres_viewer" {
  folder_id = var.folder_id
  role      = "managed-postgresql.viewer"
  member    = "serviceAccount:${yandex_iam_service_account.app.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "runner_monitoring_editor" {
  folder_id = var.folder_id
  role      = "monitoring.editor"
  member    = "serviceAccount:${yandex_iam_service_account.runner.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "runner_logging_writer" {
  folder_id = var.folder_id
  role      = "logging.writer"
  member    = "serviceAccount:${yandex_iam_service_account.runner.id}"
}

# Standard-client OS Login requires the instance role plus a folder-level
# resource-manager.auditor grant for the VM's containing resource boundary.
resource "yandex_resourcemanager_folder_iam_member" "runner_os_login_auditor" {
  folder_id = var.folder_id
  role      = "resource-manager.auditor"
  member    = "serviceAccount:${yandex_iam_service_account.runner.id}"
}

# Application Load Balancer does not expose a load-balancer-level IAM binding in
# yandex-cloud/yandex 0.215.0. Folder scope is therefore the narrowest
# provider-supported scope for the runner's read-only target-state permission.
resource "yandex_resourcemanager_folder_iam_member" "runner_alb_viewer" {
  folder_id = var.folder_id
  role      = "alb.viewer"
  member    = "serviceAccount:${yandex_iam_service_account.runner.id}"
}

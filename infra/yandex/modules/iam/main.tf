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
  github_repository_name        = split("/", var.github_repository)[1]
  github_repository_subject     = "${local.github_owner}@${var.github_repository_owner_id}/${local.github_repository_name}@${var.github_repository_id}"
  github_audience               = "https://github.com/${local.github_owner}"
  github_infrastructure_subject = "repo:${local.github_repository_subject}:environment:${var.github_infrastructure_environment}"
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

resource "yandex_iam_workload_identity_oidc_federation" "github" {
  name        = "markiro-production-github"
  description = "GitHub Actions federation for protected infrastructure changes."
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
  members       = ["serviceAccount:${yandex_iam_service_account.terraform.id}"]
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

locals {
  terraform_production_action_roles = {
    "compute.instances-and-access.manage" = "compute.admin"
    "dns.recordsets.manage"               = "dns.editor"
    "managed-postgresql.resources.manage" = "managed-postgresql.editor"
    "storage.buckets-and-policies.manage" = "storage.admin"
    "vpc.gateways.attach-to-routes"       = "vpc.gateways.user"
    "vpc.gateways.manage"                 = "vpc.gateways.editor"
    "vpc.networks-subnets-routes.manage"  = "vpc.privateAdmin"
    "vpc.public-addresses.manage"         = "vpc.publicAdmin"
    "vpc.resources.use"                   = "vpc.user"
    "vpc.security-groups.manage"          = "vpc.securityGroups.admin"
  }
  terraform_folder_roles = toset(values(local.terraform_production_action_roles))
}

resource "yandex_resourcemanager_folder_iam_member" "terraform_service_role" {
  for_each = local.terraform_folder_roles

  folder_id = var.folder_id
  role      = each.value
  member    = "serviceAccount:${yandex_iam_service_account.terraform.id}"
}

resource "yandex_iam_service_account_iam_member" "terraform_app_user" {
  service_account_id = yandex_iam_service_account.app.id
  role               = "iam.serviceAccounts.user"
  member             = "serviceAccount:${yandex_iam_service_account.terraform.id}"
}

resource "yandex_iam_service_account_iam_member" "terraform_self_viewer" {
  service_account_id = yandex_iam_service_account.terraform.id
  role               = "viewer"
  member             = "serviceAccount:${yandex_iam_service_account.terraform.id}"
}

terraform {
  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "= 0.215.0"
    }
  }
}

locals {
  github_owner    = split("/", var.github_repository)[0]
  github_audience = "https://github.com/${local.github_owner}"
  github_subject  = "repo:${var.github_repository}:environment:${var.github_environment}"
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
  members       = ["serviceAccount:${yandex_iam_service_account.terraform.id}"]
}

resource "yandex_iam_workload_identity_federated_credential" "github_production" {
  service_account_id  = yandex_iam_service_account.terraform.id
  federation_id       = yandex_iam_workload_identity_oidc_federation.github.id
  external_subject_id = local.github_subject
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

resource "yandex_lockbox_secret_iam_member" "runner_registration" {
  secret_id = var.runner_registration_secret_id
  role      = "lockbox.payloadViewer"
  member    = "serviceAccount:${yandex_iam_service_account.runner.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "terraform_management" {
  folder_id = var.folder_id
  role      = "editor"
  member    = "serviceAccount:${yandex_iam_service_account.terraform.id}"
}

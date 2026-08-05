locals {
  labels = {
    app         = "markiro"
    environment = "production"
    managed_by  = "terraform"
  }
}

resource "yandex_storage_bucket" "state" {
  bucket        = var.state_bucket_name
  folder_id     = var.folder_id
  force_destroy = false

  anonymous_access_flags {
    read        = false
    list        = false
    config_read = false
  }

  versioning {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "yandex_lockbox_secret" "runtime" {
  name      = "markiro-production-runtime"
  folder_id = var.folder_id
  labels    = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

resource "yandex_lockbox_secret" "state_backend" {
  name      = "markiro-production-state-backend"
  folder_id = var.folder_id
  labels    = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

resource "yandex_lockbox_secret" "runner_registration" {
  name      = "markiro-production-runner-registration"
  folder_id = var.folder_id
  labels    = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

resource "yandex_logging_group" "audit" {
  name             = "markiro-production-audit"
  folder_id        = var.folder_id
  retention_period = "336h"
  labels           = local.labels
}

module "iam" {
  source = "../modules/iam"

  folder_id                         = var.folder_id
  organization_id                   = var.organization_id
  github_repository                 = var.github_repository
  github_environment                = var.github_environment
  github_infrastructure_environment = var.github_infrastructure_environment
  state_bucket_name                 = yandex_storage_bucket.state.bucket
  runtime_secret_id                 = yandex_lockbox_secret.runtime.id
  state_backend_secret_id           = yandex_lockbox_secret.state_backend.id
  runner_registration_secret_id     = yandex_lockbox_secret.runner_registration.id
  labels                            = local.labels
}

# These grants are deliberately provisioned by the protected bootstrap operator,
# not the workload-federated production Terraform identity. They make both Audit
# Trails destinations usable before the production root creates either trail.
resource "yandex_resourcemanager_folder_iam_member" "audit_trails_viewer" {
  folder_id = var.folder_id
  role      = "audit-trails.viewer"
  member    = "serviceAccount:${module.iam.service_account_ids.audit}"
}

resource "yandex_resourcemanager_folder_iam_member" "audit_logging_writer" {
  # Provider 0.215.0 has no Logging-group IAM resource. This inherited grant is
  # created only by the protected bootstrap operator before trail delivery.
  folder_id = var.folder_id
  role      = "logging.writer"
  member    = "serviceAccount:${module.iam.service_account_ids.audit}"
}

resource "yandex_kms_symmetric_key_iam_member" "terraform_encrypter_decrypter" {
  symmetric_key_id = var.kms_key_id
  role             = "kms.keys.encrypterDecrypter"
  member           = "serviceAccount:${module.iam.service_account_ids.terraform}"
}

resource "yandex_kms_symmetric_key_iam_member" "terraform_key_user" {
  symmetric_key_id = var.kms_key_id
  role             = "kms.keys.user"
  member           = "serviceAccount:${module.iam.service_account_ids.terraform}"
}

resource "yandex_kms_symmetric_key_iam_member" "deployment_controller_runner_key_user" {
  symmetric_key_id = var.kms_key_id
  role             = "kms.keys.user"
  member           = "serviceAccount:${module.iam.service_account_ids.deployment_controller}"
}

resource "yandex_kms_symmetric_key_iam_member" "app_encrypter_decrypter" {
  symmetric_key_id = var.kms_key_id
  role             = "kms.keys.encrypterDecrypter"
  member           = "serviceAccount:${module.iam.service_account_ids.app}"
}

resource "yandex_kms_symmetric_key_iam_member" "audit_encrypter" {
  symmetric_key_id = var.kms_key_id
  role             = "kms.keys.encrypter"
  member           = "serviceAccount:${module.iam.service_account_ids.audit}"
}

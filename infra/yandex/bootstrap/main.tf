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

module "iam" {
  source = "../modules/iam"

  folder_id                         = var.folder_id
  organization_id                   = var.organization_id
  github_repository                 = var.github_repository
  github_repository_owner_id        = var.github_repository_owner_id
  github_repository_id              = var.github_repository_id
  github_infrastructure_environment = var.github_infrastructure_environment
  state_bucket_name                 = yandex_storage_bucket.state.bucket
  runtime_secret_id                 = yandex_lockbox_secret.runtime.id
  state_backend_secret_id           = yandex_lockbox_secret.state_backend.id
  labels                            = local.labels
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

resource "yandex_kms_symmetric_key_iam_member" "app_encrypter_decrypter" {
  symmetric_key_id = var.kms_key_id
  role             = "kms.keys.encrypterDecrypter"
  member           = "serviceAccount:${module.iam.service_account_ids.app}"
}

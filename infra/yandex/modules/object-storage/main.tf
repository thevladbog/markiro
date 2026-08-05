terraform {
  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "= 0.215.0"
    }
  }
}

resource "yandex_storage_bucket" "media" {
  bucket        = var.media_bucket_name
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

  lifecycle_rule {
    id                                     = "expire-noncurrent-media-versions"
    enabled                                = true
    abort_incomplete_multipart_upload_days = 7

    noncurrent_version_expiration {
      days = 30
    }
  }

  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        kms_master_key_id = var.kms_key_id
        sse_algorithm     = "aws:kms"
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "yandex_storage_bucket" "audit" {
  bucket        = var.audit_bucket_name
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

  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        kms_master_key_id = var.kms_key_id
        sse_algorithm     = "aws:kms"
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

# This binding is bucket-scoped: the application can operate on media objects,
# without receiving a folder-wide role or access to audit archives.
resource "yandex_storage_bucket_iam_binding" "media_app" {
  bucket  = yandex_storage_bucket.media.bucket
  role    = "storage.editor"
  members = ["serviceAccount:${var.app_service_account_id}"]
}

# The archive identity can append audit objects but cannot list, read, or alter them.
resource "yandex_storage_bucket_iam_binding" "audit_writer" {
  bucket  = yandex_storage_bucket.audit.bucket
  role    = "storage.uploader"
  members = ["serviceAccount:${var.audit_service_account_id}"]
}

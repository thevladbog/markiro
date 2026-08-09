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

  lifecycle_rule {
    id                                     = "expire-audit-archives"
    enabled                                = true
    abort_incomplete_multipart_upload_days = 7

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      days = 90
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

# A bucket policy, rather than storage.editor, constrains the application to
# media object operations and gives it no bucket configuration authority.
resource "yandex_storage_bucket_policy" "media_app" {
  bucket = yandex_storage_bucket.media.bucket
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowApplicationMediaObjects"
        Effect    = "Allow"
        Principal = { CanonicalUser = var.app_service_account_id }
        Action    = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource  = ["arn:aws:s3:::${yandex_storage_bucket.media.bucket}/*"]
      },
      {
        Sid       = "AllowApplicationMediaBucketList"
        Effect    = "Allow"
        Principal = { CanonicalUser = var.app_service_account_id }
        Action    = ["s3:ListBucket"]
        Resource  = ["arn:aws:s3:::${yandex_storage_bucket.media.bucket}"]
      },
      {
        Sid       = "AllowTerraformMediaManagement"
        Effect    = "Allow"
        Principal = { CanonicalUser = var.terraform_service_account_id }
        Action    = ["s3:*"]
        Resource = [
          "arn:aws:s3:::${yandex_storage_bucket.media.bucket}",
          "arn:aws:s3:::${yandex_storage_bucket.media.bucket}/*",
        ]
      },
    ]
  })
}

terraform {
  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "= 0.215.0"
    }
  }
}

locals {
  release_dns_name = "${trimsuffix(var.domain, ".")}."
}

resource "yandex_storage_bucket" "releases" {
  bucket        = var.bucket_name
  folder_id     = var.folder_id
  force_destroy = false
  acl           = "private"

  anonymous_access_flags {
    read        = true
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

resource "yandex_iam_service_account" "station_release_publisher" {
  name        = "markiro-station-release-publisher"
  description = "Dedicated publisher for versioned Markiro Station release objects."
  folder_id   = var.folder_id
}

resource "yandex_iam_service_account_static_access_key" "publisher" {
  service_account_id = yandex_iam_service_account.station_release_publisher.id
  description        = "S3-compatible access key for protected Station release workflows."
  pgp_key            = var.publisher_pgp_key
}

# Object Storage requires an IAM baseline before evaluating a bucket policy.
# storage.uploader permits read and overwrite but not object deletion or bucket
# configuration; the policy below further limits the identity to station/*.
resource "yandex_storage_bucket_iam_binding" "publisher_uploader" {
  bucket  = yandex_storage_bucket.releases.bucket
  role    = "storage.uploader"
  members = ["serviceAccount:${yandex_iam_service_account.station_release_publisher.id}"]
}

resource "yandex_storage_bucket_policy" "releases" {
  bucket = yandex_storage_bucket.releases.bucket
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowPublicStationReleaseObjects"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["s3:GetObject"]
        Resource  = ["arn:aws:s3:::${yandex_storage_bucket.releases.bucket}/station/*"]
      },
      {
        Sid       = "AllowPublisherStationObjects"
        Effect    = "Allow"
        Principal = { CanonicalUser = yandex_iam_service_account.station_release_publisher.id }
        Action    = ["s3:GetObject", "s3:PutObject"]
        Resource  = ["arn:aws:s3:::${yandex_storage_bucket.releases.bucket}/station/*"]
      },
      {
        Sid       = "AllowPublisherStationBucketPreflight"
        Effect    = "Allow"
        Principal = { CanonicalUser = yandex_iam_service_account.station_release_publisher.id }
        Action    = ["s3:GetBucketLocation", "s3:ListBucket"]
        Resource  = ["arn:aws:s3:::${yandex_storage_bucket.releases.bucket}"]
        Condition = {
          StringLike = {
            "s3:prefix" = ["station/*"]
          }
        }
      },
      {
        Sid       = "AllowTerraformReleaseManagement"
        Effect    = "Allow"
        Principal = { CanonicalUser = var.terraform_service_account_id }
        Action    = ["s3:*"]
        Resource = [
          "arn:aws:s3:::${yandex_storage_bucket.releases.bucket}",
          "arn:aws:s3:::${yandex_storage_bucket.releases.bucket}/*",
        ]
      },
    ]
  })

  depends_on = [yandex_storage_bucket_iam_binding.publisher_uploader]
}

resource "yandex_cdn_origin_group" "releases" {
  name      = "markiro-station-releases"
  folder_id = var.folder_id
  use_next  = false

  origin {
    source  = yandex_storage_bucket.releases.bucket_domain_name
    enabled = true
    backup  = false
  }
}

resource "yandex_cm_certificate" "releases" {
  name      = "markiro-station-releases"
  folder_id = var.folder_id
  domains   = [var.domain]

  managed {
    challenge_type  = "DNS_CNAME"
    challenge_count = 1
  }
}

# Certificate validation is intentionally independent of the final public
# release hostname gate so issuance and renewal can complete before go-live.
resource "yandex_dns_recordset" "certificate_validation" {
  count = 1

  zone_id = var.dns_zone_id
  name    = yandex_cm_certificate.releases.challenges[count.index].dns_name
  type    = yandex_cm_certificate.releases.challenges[count.index].dns_type
  ttl     = 300
  data    = [yandex_cm_certificate.releases.challenges[count.index].dns_value]
}

data "yandex_cm_certificate" "issued" {
  certificate_id  = yandex_cm_certificate.releases.id
  wait_validation = true

  depends_on = [yandex_dns_recordset.certificate_validation]
}

resource "yandex_cdn_resource" "releases" {
  cname           = var.domain
  active          = true
  folder_id       = var.folder_id
  origin_protocol = "https"
  origin_group_id = yandex_cdn_origin_group.releases.id
  provider_type   = "ourcdn"

  ssl_certificate {
    type                   = "certificate_manager"
    certificate_manager_id = data.yandex_cm_certificate.issued.id
  }

  options {
    allowed_http_methods   = ["GET", "HEAD"]
    redirect_http_to_https = true
    redirect_https_to_http = false

    # Cache-Control object metadata remains authoritative. Objects without
    # explicit metadata receive no CDN fallback cache lifetime.
    edge_cache_settings = 0

    static_response_headers = {
      "content-security-policy"   = "default-src 'none'; frame-ancestors 'none'; sandbox"
      "permissions-policy"        = "camera=(), geolocation=(), microphone=()"
      "referrer-policy"           = "no-referrer"
      "strict-transport-security" = "max-age=31536000; includeSubDomains"
      "x-content-type-options"    = "nosniff"
    }
  }
}

resource "yandex_dns_recordset" "public_release" {
  count = var.public_dns_enabled ? 1 : 0

  zone_id = var.dns_zone_id
  name    = local.release_dns_name
  type    = "CNAME"
  ttl     = 300
  data    = ["${trimsuffix(yandex_cdn_resource.releases.provider_cname, ".")}."]

  depends_on = [data.yandex_cm_certificate.issued]
}

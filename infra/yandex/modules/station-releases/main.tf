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

  # The SaaS admin uploads standalone installers straight to the bucket with a
  # presigned PUT, so the browser preflight must succeed for that one origin.
  # This rule covers uploads only; public reads are served by the CDN.
  cors_rule {
    allowed_origins = [var.standalone_upload_origin]
    allowed_methods = ["PUT"]
    allowed_headers = ["content-type"]
    max_age_seconds = 3600
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

# The SaaS API publishes the standalone product («Markiro Автоном») under
# standalone/*. It runs on the platform host, so it gets its own identity and
# key: a leaked platform env must not be able to overwrite Station, signer or
# handheld releases, and the Station publisher key must not reach the platform.
resource "yandex_iam_service_account" "standalone_release_api" {
  name        = "markiro-standalone-release-api"
  description = "SaaS API identity limited to standalone release objects."
  folder_id   = var.folder_id
}

resource "yandex_iam_service_account_static_access_key" "standalone_release_api" {
  service_account_id = yandex_iam_service_account.standalone_release_api.id
  description        = "S3-compatible access key for the SaaS API standalone release section."
  pgp_key            = var.publisher_pgp_key
}

# Object Storage requires an IAM baseline before evaluating a bucket policy.
# storage.uploader permits read and overwrite but not object deletion or bucket
# configuration; the policy below further limits each identity to its own
# release prefixes. The binding is authoritative for the role on this bucket,
# so both release identities share it: a second binding for storage.uploader
# would drop the other member on every apply.
resource "yandex_storage_bucket_iam_binding" "publisher_uploader" {
  bucket = yandex_storage_bucket.releases.bucket
  role   = "storage.uploader"
  members = [
    "serviceAccount:${yandex_iam_service_account.station_release_publisher.id}",
    "serviceAccount:${yandex_iam_service_account.standalone_release_api.id}",
  ]
}

# The publisher identity serves three products: the Station terminal app under
# station/*, the Chestny ZNAK signer agent under signer/*, and the Android
# handheld under handheld/*. They share a service account and a static access
# key, so splitting the grants into per-product statements would buy no
# independent revocation — there is nothing to revoke separately. Every prefix is
# listed on each publisher statement instead, and anything outside them stays
# denied. The standalone product under standalone/* is written by the separate
# SaaS API identity, which reaches no other prefix. Neither identity may delete:
# the API leaves a refused upload in place and the release section lists it as
# unfinished.
#
# Each prefix must appear on the PUBLIC read statement as well as the writer
# one. A prefix that can be written but not read publishes into the dark: the
# upload succeeds, the release reports success, and no device can fetch it.
resource "yandex_storage_bucket_policy" "releases" {
  bucket = yandex_storage_bucket.releases.bucket
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowPublicReleaseObjects"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["s3:GetObject"]
        Resource = [
          "arn:aws:s3:::${yandex_storage_bucket.releases.bucket}/station/*",
          "arn:aws:s3:::${yandex_storage_bucket.releases.bucket}/signer/*",
          "arn:aws:s3:::${yandex_storage_bucket.releases.bucket}/handheld/*",
          "arn:aws:s3:::${yandex_storage_bucket.releases.bucket}/standalone/*",
        ]
      },
      {
        Sid       = "AllowPublisherReleaseObjects"
        Effect    = "Allow"
        Principal = { CanonicalUser = yandex_iam_service_account.station_release_publisher.id }
        Action    = ["s3:GetObject", "s3:PutObject"]
        Resource = [
          "arn:aws:s3:::${yandex_storage_bucket.releases.bucket}/station/*",
          "arn:aws:s3:::${yandex_storage_bucket.releases.bucket}/signer/*",
          "arn:aws:s3:::${yandex_storage_bucket.releases.bucket}/handheld/*",
        ]
      },
      {
        Sid       = "AllowPublisherReleaseBucketPreflight"
        Effect    = "Allow"
        Principal = { CanonicalUser = yandex_iam_service_account.station_release_publisher.id }
        Action    = ["s3:GetBucketLocation", "s3:ListBucket"]
        Resource  = ["arn:aws:s3:::${yandex_storage_bucket.releases.bucket}"]
        Condition = {
          StringLike = {
            "s3:prefix" = ["station/*", "signer/*", "handheld/*"]
          }
        }
      },
      {
        Sid       = "AllowStandaloneReleaseApiObjects"
        Effect    = "Allow"
        Principal = { CanonicalUser = yandex_iam_service_account.standalone_release_api.id }
        Action    = ["s3:GetObject", "s3:PutObject"]
        Resource  = ["arn:aws:s3:::${yandex_storage_bucket.releases.bucket}/standalone/*"]
      },
      {
        Sid       = "AllowStandaloneReleaseApiListing"
        Effect    = "Allow"
        Principal = { CanonicalUser = yandex_iam_service_account.standalone_release_api.id }
        Action    = ["s3:ListBucket"]
        Resource  = ["arn:aws:s3:::${yandex_storage_bucket.releases.bucket}"]
        Condition = {
          StringLike = {
            "s3:prefix" = ["standalone/*"]
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
    custom_host_header     = yandex_storage_bucket.releases.bucket_domain_name

    # Cache-Control object metadata remains authoritative. Objects without
    # explicit metadata receive no CDN fallback cache lifetime.
    edge_cache_settings = 0

    # The landing's download page reads standalone/<channel>/latest.json with a
    # cross-origin fetch. The CDN echoes the request Origin into
    # Access-Control-Allow-Origin only when its host is the landing domain, on
    # cached and uncached responses alike. The fetch is a simple GET, so no
    # preflight reaches the edge. The bucket's own CORS rule covers only the
    # SaaS admin's presigned PUT and plays no part here.
    cors = [var.download_origin_domain]

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

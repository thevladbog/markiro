variable "cloud_id" {
  description = "Yandex Cloud identifier for the Markiro deployment."
  type        = string
  nullable    = false
}

variable "folder_id" {
  description = "Yandex Cloud folder identifier for the Markiro deployment."
  type        = string
  nullable    = false
}

variable "zone" {
  description = "Availability zone of the existing application VM."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^ru-central1-[a-z]$", var.zone))
    error_message = "zone must be a ru-central1 availability zone."
  }
}

variable "app_subnet_cidr" {
  description = "CIDR of the application subnet."
  type        = string
  nullable    = false
}

variable "data_subnet_cidr" {
  description = "CIDR of the Managed PostgreSQL subnet."
  type        = string
  nullable    = false
}

variable "ubuntu_lts_image_family" {
  description = "Pinned Ubuntu LTS family for the application VM."
  type        = string
  nullable    = false

  validation {
    condition     = var.ubuntu_lts_image_family == "ubuntu-2404-lts"
    error_message = "ubuntu_lts_image_family must remain pinned to ubuntu-2404-lts."
  }
}

variable "kms_key_id" {
  description = "Existing KMS key encrypting retained production resources."
  type        = string
  nullable    = false
}

variable "app_service_account_id" {
  description = "Runtime service account attached to the application VM."
  type        = string
  nullable    = false
}

variable "terraform_service_account_id" {
  description = "Terraform identity retained in the private media bucket policy."
  type        = string
  nullable    = false
}

variable "runtime_secret_id" {
  description = "Runtime Lockbox secret identifier; payload stays out of Terraform."
  type        = string
  nullable    = false
}

variable "app_deploy_ssh_public_key" {
  description = "Exact Ed25519 public key of the dedicated deploy account."
  type        = string
  nullable    = false

  validation {
    condition = (
      can(regex("^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$", var.app_deploy_ssh_public_key)) &&
      !strcontains(var.app_deploy_ssh_public_key, "\n") &&
      !strcontains(var.app_deploy_ssh_public_key, "\r")
    )
    error_message = "app_deploy_ssh_public_key must be one canonical ssh-ed25519 public key."
  }
}

variable "database_name" {
  description = "Existing PostgreSQL application database name."
  type        = string
  nullable    = false
}

variable "database_disk_size_gb" {
  description = "Allocated PostgreSQL SSD size in GiB."
  type        = number
  nullable    = false

  validation {
    condition     = var.database_disk_size_gb >= 50
    error_message = "database_disk_size_gb must be at least 50 GiB."
  }
}

variable "state_bucket_name" {
  description = "Protected Terraform state bucket name used for collision validation."
  type        = string
  nullable    = false
}

variable "media_bucket_name" {
  description = "Private application media bucket name."
  type        = string
  nullable    = false
}

variable "audit_bucket_name" {
  description = "Temporarily retained audit bucket pending explicit data cleanup."
  type        = string
  nullable    = false
}

variable "station_release_bucket_name" {
  description = "Globally unique bucket dedicated to Station release objects."
  type        = string
  nullable    = false

  validation {
    condition = (
      can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.station_release_bucket_name)) &&
      var.station_release_bucket_name != var.state_bucket_name &&
      var.station_release_bucket_name != var.media_bucket_name &&
      var.station_release_bucket_name != var.audit_bucket_name
    )
    error_message = "station_release_bucket_name must be a valid S3 bucket name distinct from state, media, and audit buckets."
  }
}

variable "domain" {
  description = "Exact admin authority served directly by Caddy."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.domain))
    error_message = "domain must be a lowercase fully-qualified domain name."
  }
}

variable "kiosk_domain" {
  description = "Exact kiosk authority served directly by Caddy."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.kiosk_domain)) && var.kiosk_domain != var.domain
    error_message = "kiosk_domain must be a distinct lowercase fully-qualified domain name."
  }
}

variable "saas_admin_domain" {
  description = "Exact platform SaaS administration authority served directly by Caddy."
  type        = string
  nullable    = false

  validation {
    condition = (
      can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.saas_admin_domain)) &&
      var.saas_admin_domain != var.domain &&
      var.saas_admin_domain != var.kiosk_domain
    )
    error_message = "saas_admin_domain must be a lowercase fully-qualified domain name distinct from admin and kiosk."
  }
}

variable "landing_domain" {
  description = "Exact public landing authority served directly by Caddy."
  type        = string
  nullable    = false

  validation {
    condition = (
      can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.landing_domain)) &&
      var.landing_domain != var.domain &&
      var.landing_domain != var.saas_admin_domain &&
      var.landing_domain != var.kiosk_domain
    )
    error_message = "landing_domain must be a lowercase fully-qualified domain name distinct from admin, SaaS admin, and kiosk."
  }
}

variable "station_release_domain" {
  description = "Fixed public Station release authority served only through Yandex Cloud CDN."
  type        = string
  nullable    = false

  validation {
    condition     = var.station_release_domain == "releases.markiro.app"
    error_message = "station_release_domain must be exactly releases.markiro.app."
  }
}

variable "station_release_publisher_pgp_key" {
  description = "Base64-encoded PGP public key used to encrypt the Station publisher secret."
  type        = string
  nullable    = false
  sensitive   = true

  validation {
    condition     = length(trimspace(var.station_release_publisher_pgp_key)) > 0
    error_message = "station_release_publisher_pgp_key must be nonblank."
  }
}

variable "dns_zone_id" {
  description = "Existing public Cloud DNS zone ID."
  type        = string
  nullable    = false
}

variable "public_dns_enabled" {
  description = "Whether all direct-VM A records are published."
  type        = bool
  default     = false
  nullable    = false
}

variable "station_release_public_dns_enabled" {
  description = "Whether the final releases.markiro.app CNAME is published after separate approval."
  type        = bool
  default     = false
  nullable    = false
}

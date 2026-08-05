variable "cloud_id" {
  description = "Yandex Cloud identifier for the Markiro deployment."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.cloud_id)) > 0
    error_message = "cloud_id must not be empty."
  }
}

variable "folder_id" {
  description = "Yandex Cloud folder identifier for the Markiro deployment."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.folder_id)) > 0
    error_message = "folder_id must not be empty."
  }
}

variable "zone" {
  description = "Yandex Cloud availability zone for the initial production deployment."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^ru-central1-[a-z]$", var.zone))
    error_message = "zone must be a ru-central1 availability zone."
  }
}

variable "alb_subnet_cidr" {
  description = "CIDR for the application load balancer subnet."
  type        = string
  nullable    = false
}

variable "app_subnet_cidr" {
  description = "CIDR for the private application subnet."
  type        = string
  nullable    = false
}

variable "data_subnet_cidr" {
  description = "CIDR for the private data subnet."
  type        = string
  nullable    = false
}

variable "management_subnet_cidr" {
  description = "CIDR for the private management subnet."
  type        = string
  nullable    = false
}

variable "ubuntu_lts_image_family" {
  description = "Pinned Ubuntu LTS family used by every production VM."
  type        = string
  nullable    = false

  validation {
    condition     = var.ubuntu_lts_image_family == "ubuntu-2404-lts"
    error_message = "ubuntu_lts_image_family must remain pinned to ubuntu-2404-lts."
  }
}

variable "kms_key_id" {
  description = "Existing KMS key ID that encrypts the managed boot disks."
  type        = string
  nullable    = false
}

variable "app_service_account_id" {
  description = "Bootstrap-created runtime service account for the application VM."
  type        = string
  nullable    = false
}

variable "runtime_secret_id" {
  description = "Bootstrap-created runtime Lockbox secret ID; payload remains out of Terraform."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.runtime_secret_id)) > 0
    error_message = "runtime_secret_id must be a nonblank Lockbox secret ID."
  }
}

variable "registry_secret_id" {
  description = "Bootstrap-created deploy-only GHCR Lockbox secret ID; payload remains out of Terraform."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.registry_secret_id)) > 0 && var.registry_secret_id != var.runtime_secret_id
    error_message = "registry_secret_id must be a distinct nonblank Lockbox secret ID."
  }
}

variable "runner_service_account_id" {
  description = "Bootstrap-created runtime service account for the runner VM."
  type        = string
  nullable    = false
}

variable "deployment_controller_service_account_id" {
  description = "Bootstrap-created GitHub deployment-controller service account ID."
  type        = string
  nullable    = false
}

variable "runner_registration_secret_id" {
  description = "Bootstrap-created runner-only Lockbox secret ID; payload remains out of Terraform."
  type        = string
  nullable    = false

  validation {
    condition = length(trimspace(var.runner_registration_secret_id)) > 0 && !contains(
      [var.runtime_secret_id, var.registry_secret_id],
      var.runner_registration_secret_id,
    )
    error_message = "runner_registration_secret_id must be distinct from the runtime and registry Lockbox secret IDs."
  }
}

variable "audit_service_account_id" {
  description = "Bootstrap-created audit writer service-account ID."
  type        = string
  nullable    = false
}

variable "audit_log_group_id" {
  description = "Bootstrap-created Cloud Logging group for near-real-time Audit Trails delivery."
  type        = string
  nullable    = false
}

variable "database_name" {
  description = "PostgreSQL database and out-of-band owner identity name."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z_][a-z0-9_]{0,62}$", var.database_name))
    error_message = "database_name must be a lowercase PostgreSQL identifier no longer than 63 characters."
  }
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
  description = "Protected bootstrap state bucket name, supplied only for collision validation."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.state_bucket_name)) > 0 && can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.state_bucket_name)) && var.state_bucket_name != var.media_bucket_name && var.state_bucket_name != var.audit_bucket_name
    error_message = "state_bucket_name must be a valid nonblank S3 bucket name distinct from media and audit buckets."
  }
}

variable "media_bucket_name" {
  description = "Globally unique private bucket name for application media."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.media_bucket_name))
    error_message = "media_bucket_name must be a 3-63 character lowercase S3 bucket name."
  }
}

variable "audit_bucket_name" {
  description = "Globally unique private bucket name for durable audit archives."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.audit_bucket_name)) && var.audit_bucket_name != var.media_bucket_name
    error_message = "audit_bucket_name must be a distinct 3-63 character lowercase S3 bucket name."
  }
}

variable "domain" {
  description = "Exact public authority served by the protected production ingress."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.domain))
    error_message = "domain must be a lowercase fully-qualified domain name."
  }
}

variable "dns_zone_id" {
  description = "Existing Cloud DNS zone ID for certificate validation and application publication."
  type        = string
  nullable    = false
}

variable "public_dns_enabled" {
  description = "Whether to publish the application A record after explicit go-live approval."
  type        = bool
  default     = false
  nullable    = false
}

variable "notification_channel_id" {
  description = "Existing Monitoring notification channel used by every production alert."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.notification_channel_id)) > 0
    error_message = "notification_channel_id must not be empty."
  }
}

variable "alert_ids" {
  description = "Complete IDs of Monitoring alerts created from module.observability.alert_specs."
  type        = map(string)
  nullable    = false

  validation {
    condition = toset(keys(var.alert_ids)) == toset([
      "alb_healthy_backend",
      "alb_5xx",
      "alb_latency",
      "sws_deny",
      "sws_arl",
      "vm_cpu",
      "vm_memory",
      "vm_disk",
      "postgres_availability",
      "postgres_storage",
      "postgres_connections",
      "postgres_backup_age",
      "certificate_risk",
      "readiness_optional_dependency_degradation",
      "deployment_failure",
      "runner_overrun",
    ]) && alltrue([for alert_id in values(var.alert_ids) : length(trimspace(alert_id)) > 0]) && length(toset(values(var.alert_ids))) == length(var.alert_ids)
    error_message = "alert_ids must contain exactly one unique, nonblank ID for every required alert category."
  }
}

variable "global_rate_limit" {
  description = "Maximum aggregate requests per ARL period; sized above normal CommerceML uploads."
  type        = number
  default     = 10000
  nullable    = false

  validation {
    condition     = var.global_rate_limit == floor(var.global_rate_limit) && var.global_rate_limit >= 1 && var.global_rate_limit <= 9999999999999
    error_message = "global_rate_limit must be an integer between 1 and 9999999999999."
  }
}

variable "per_ip_rate_limit" {
  description = "Maximum requests per client IP and ARL period; sized above normal CommerceML uploads."
  type        = number
  default     = 1000
  nullable    = false

  validation {
    condition     = var.per_ip_rate_limit == floor(var.per_ip_rate_limit) && var.per_ip_rate_limit >= 1 && var.per_ip_rate_limit <= 9999999999999
    error_message = "per_ip_rate_limit must be an integer between 1 and 9999999999999."
  }
}

variable "rate_limit_period_seconds" {
  description = "Shared ARL quota period in seconds."
  type        = number
  default     = 60
  nullable    = false

  validation {
    condition     = var.rate_limit_period_seconds == floor(var.rate_limit_period_seconds) && var.rate_limit_period_seconds >= 1
    error_message = "rate_limit_period_seconds must be at least one second."
  }
}

variable "folder_id" {
  description = "Production folder whose management and metric events are observed."
  type        = string
  nullable    = false
}

variable "audit_service_account_id" {
  description = "Service account used by both Audit Trails destinations."
  type        = string
  nullable    = false
}

variable "media_bucket_name" {
  description = "Media bucket selected as an Object Storage data-event source."
  type        = string
  nullable    = false
}

variable "audit_bucket_name" {
  description = "Dedicated Object Storage destination for durable audit archives."
  type        = string
  nullable    = false

  validation {
    condition     = var.audit_bucket_name != var.media_bucket_name
    error_message = "audit_bucket_name must be distinct from the media data-event source."
  }
}

variable "lockbox_secret_ids" {
  description = "Exact Lockbox secret IDs whose payload access data events are audited."
  type        = set(string)
  nullable    = false

  validation {
    condition     = length(var.lockbox_secret_ids) > 0 && alltrue([for secret_id in var.lockbox_secret_ids : length(trimspace(secret_id)) > 0])
    error_message = "lockbox_secret_ids must contain at least one nonblank secret ID."
  }
}

variable "load_balancer_id" {
  description = "Application Load Balancer ID used by production metric selectors."
  type        = string
  nullable    = false
}

variable "backend_group_id" {
  description = "ALB backend-group ID used by readiness and health metric producers."
  type        = string
  nullable    = false
}

variable "security_profile_id" {
  description = "Smart Web Security profile ID used by security metric selectors."
  type        = string
  nullable    = false
}

variable "rate_limiter_profile_id" {
  description = "Advanced Rate Limiter profile ID used by SWS ARL metric selectors."
  type        = string
  nullable    = false
}

variable "app_instance_id" {
  description = "Application VM ID used by Compute and guest-agent metric selectors."
  type        = string
  nullable    = false
}

variable "runner_instance_id" {
  description = "Runner VM ID used by Compute and runner-overrun metric selectors."
  type        = string
  nullable    = false
}

variable "postgres_cluster_id" {
  description = "Managed PostgreSQL cluster ID used by database metric selectors."
  type        = string
  nullable    = false
}

variable "certificate_id" {
  description = "Certificate Manager certificate ID used by expiry metric selectors."
  type        = string
  nullable    = false
}

variable "notification_channel_id" {
  description = "Existing Monitoring notification channel attached to every manual alert."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.notification_channel_id)) > 0
    error_message = "notification_channel_id must not be empty."
  }
}

variable "alert_ids" {
  description = "IDs of console-created Monitoring alerts that exactly implement alert_specs."
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
    ]) && alltrue([for alert_id in values(var.alert_ids) : length(trimspace(alert_id)) > 0])
    error_message = "alert_ids must contain exactly one nonblank ID for every required alert category."
  }
}

variable "labels" {
  description = "Common non-secret labels for observability resources."
  type        = map(string)
  nullable    = false
}

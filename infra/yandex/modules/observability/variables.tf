variable "folder_id" {
  description = "Production folder whose management and metric events are observed."
  type        = string
  nullable    = false
}

variable "application_log_group_id" {
  description = "Retained Cloud Logging group created independently so VM bootstrap can target it without a module dependency cycle."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.application_log_group_id)) > 0
    error_message = "application_log_group_id must not be empty."
  }
}

variable "audit_service_account_id" {
  description = "Service account used by both Audit Trails destinations."
  type        = string
  nullable    = false
}

variable "audit_log_group_id" {
  description = "Bootstrap-created Cloud Logging destination with writer access for the audit service account."
  type        = string
  nullable    = false
}

variable "state_bucket_name" {
  description = "Protected bootstrap state bucket name, used only to reject audit/media destination reuse."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.state_bucket_name)) > 0 && var.state_bucket_name != var.media_bucket_name && var.state_bucket_name != var.audit_bucket_name
    error_message = "state_bucket_name must be nonblank and distinct from media and audit buckets."
  }
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
    error_message = "audit_bucket_name must be distinct from the media bucket."
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

variable "postgres_cluster_id" {
  description = "Managed PostgreSQL cluster ID used by database metric selectors."
  type        = string
  nullable    = false
}

variable "certificate_ids" {
  description = "Ordered admin and kiosk Certificate Manager certificate IDs used by the shared expiry metric selector."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.certificate_ids) == 2 && alltrue([for certificate_id in var.certificate_ids : length(trimspace(certificate_id)) > 0]) && length(toset(var.certificate_ids)) == 2
    error_message = "certificate_ids must contain exactly two distinct, nonblank certificate IDs."
  }
}

variable "notification_channel_id" {
  description = "Existing Monitoring notification channel attached to every manual alert."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.observability_phase == "first" ? var.notification_channel_id == null : var.notification_channel_id != null && length(trimspace(var.notification_channel_id)) > 0
    error_message = "notification_channel_id must be absent in first phase and nonblank in protected phase."
  }
}

variable "alert_ids" {
  description = "IDs of console-created Monitoring alerts that exactly implement alert_specs."
  type        = map(string)
  default     = null
  nullable    = true

  validation {
    condition = var.observability_phase == "first" ? var.alert_ids == null : var.alert_ids != null && toset(keys(var.alert_ids)) == toset([
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
      "readiness_required_unavailable",
      "deployment_failure",
    ]) && alltrue([for alert_id in values(var.alert_ids) : length(trimspace(alert_id)) > 0]) && length(toset(values(var.alert_ids))) == 15
    error_message = "alert_ids must be absent in first phase and otherwise contain exactly 15 unique, nonblank IDs for every required alert category."
  }
}

variable "observability_phase" {
  description = "first emits alert specifications without console IDs; protected binds the reviewed alert IDs."
  type        = string
  nullable    = false

  validation {
    condition     = contains(["first", "protected"], var.observability_phase)
    error_message = "observability_phase must be first or protected."
  }
}

variable "labels" {
  description = "Common non-secret labels for observability resources."
  type        = map(string)
  nullable    = false
}

variable "folder_id" {
  description = "Yandex Cloud folder containing the protected object buckets."
  type        = string
  nullable    = false
}

variable "kms_key_id" {
  description = "Existing approved KMS key ID used for bucket SSE-KMS."
  type        = string
  nullable    = false
}

variable "state_bucket_name" {
  description = "Protected bootstrap state bucket name, used only to reject durable-bucket collisions."
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

variable "app_service_account_id" {
  description = "Application runtime identity limited to the media bucket."
  type        = string
  nullable    = false
}

variable "audit_service_account_id" {
  description = "Audit writer identity limited to archive uploads."
  type        = string
  nullable    = false
}

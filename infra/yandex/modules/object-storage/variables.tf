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
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.audit_bucket_name))
    error_message = "audit_bucket_name must be a 3-63 character lowercase S3 bucket name."
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

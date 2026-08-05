variable "folder_id" {
  description = "Yandex Cloud folder containing the private compute instances."
  type        = string
  nullable    = false
}

variable "zone" {
  description = "Availability zone for the application and runner instances."
  type        = string
  nullable    = false
}

variable "ubuntu_lts_image_family" {
  description = "Pinned Ubuntu LTS image family approved for production instances."
  type        = string
  nullable    = false
}

variable "kms_key_id" {
  description = "KMS key used to encrypt each managed boot disk."
  type        = string
  nullable    = false
}

variable "app_service_account_id" {
  description = "Runtime service-account ID attached to the application instance."
  type        = string
  nullable    = false
}

variable "runtime_secret_id" {
  description = "Identifier of the runtime Lockbox container, never its payload."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.runtime_secret_id)) > 0
    error_message = "runtime_secret_id must not be empty."
  }
}

variable "runner_service_account_id" {
  description = "Runtime service-account ID attached to the ephemeral runner instance."
  type        = string
  nullable    = false
}

variable "app_subnet_id" {
  description = "Private application subnet ID."
  type        = string
  nullable    = false
}

variable "management_subnet_id" {
  description = "Private management subnet ID used by the ephemeral runner."
  type        = string
  nullable    = false
}

variable "app_security_group_id" {
  description = "Security group that accepts only ALB and runner traffic for the application."
  type        = string
  nullable    = false
}

variable "runner_security_group_id" {
  description = "Security group for the ephemeral runner."
  type        = string
  nullable    = false
}

variable "labels" {
  description = "Common non-secret labels for compute resources."
  type        = map(string)
  nullable    = false
}

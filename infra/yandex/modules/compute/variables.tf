variable "folder_id" {
  description = "Yandex Cloud folder containing the private compute instances."
  type        = string
  nullable    = false
}

variable "zone" {
  description = "Availability zone for the application instance."
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

variable "application_log_group_id" {
  description = "Terraform-managed Cloud Logging group receiving sanitized VM application logs."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.application_log_group_id)) > 0
    error_message = "application_log_group_id must not be empty."
  }
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

variable "deployment_controller_service_account_id" {
  description = "Deployment-controller identity allowed to inspect the application VM."
  type        = string
  nullable    = false
}

variable "app_deploy_ssh_public_key" {
  description = "Exact Ed25519 public key for the dedicated deployment account."
  type        = string
  nullable    = false

  validation {
    condition = (
      can(regex("^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$", var.app_deploy_ssh_public_key)) &&
      !strcontains(var.app_deploy_ssh_public_key, "\n") &&
      !strcontains(var.app_deploy_ssh_public_key, "\r")
    )
    error_message = "app_deploy_ssh_public_key must be one canonical ssh-ed25519 public key without options or comments."
  }
}

variable "app_subnet_id" {
  description = "Private application subnet ID."
  type        = string
  nullable    = false
}

variable "app_security_group_id" {
  description = "Security group that accepts only ALB application traffic and key-authenticated deployment SSH."
  type        = string
  nullable    = false
}

variable "labels" {
  description = "Common non-secret labels for compute resources."
  type        = map(string)
  nullable    = false
}

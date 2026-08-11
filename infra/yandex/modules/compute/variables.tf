variable "folder_id" {
  description = "Yandex Cloud folder containing the application VM."
  type        = string
  nullable    = false
}

variable "zone" {
  description = "Availability zone for the application VM."
  type        = string
  nullable    = false
}

variable "ubuntu_lts_image_family" {
  description = "Pinned Ubuntu LTS image family approved for production."
  type        = string
  nullable    = false
}

variable "kms_key_id" {
  description = "KMS key used to encrypt the application boot disk."
  type        = string
  nullable    = false
}

variable "app_service_account_id" {
  description = "Runtime service account attached to the application VM."
  type        = string
  nullable    = false
}

variable "runtime_secret_id" {
  description = "Runtime Lockbox secret identifier, never its payload."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.runtime_secret_id)) > 0
    error_message = "runtime_secret_id must not be empty."
  }
}

variable "app_deploy_ssh_public_key" {
  description = "Exact Ed25519 public key for the dedicated deploy account."
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
  description = "Application subnet ID."
  type        = string
  nullable    = false
}

variable "app_security_group_id" {
  description = "Security group for public HTTP, HTTPS and key-authenticated SSH."
  type        = string
  nullable    = false
}

variable "labels" {
  description = "Common non-secret labels for compute resources."
  type        = map(string)
  nullable    = false
}

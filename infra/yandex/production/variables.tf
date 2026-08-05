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

variable "runner_service_account_id" {
  description = "Bootstrap-created runtime service account for the runner VM."
  type        = string
  nullable    = false
}

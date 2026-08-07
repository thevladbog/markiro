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

variable "organization_id" {
  description = "Yandex Cloud organization identifier that owns the production deployment."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.organization_id)) > 0
    error_message = "organization_id must not be empty."
  }
}

variable "github_repository" {
  description = "Exact GitHub owner/repository permitted to exchange production workload identity tokens."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_repository == "thevladbog/markiro"
    error_message = "github_repository must be exactly thevladbog/markiro."
  }
}

variable "github_repository_owner_id" {
  description = "Immutable GitHub repository owner ID permitted to exchange production workload identity tokens."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_repository_owner_id == "47273232"
    error_message = "github_repository_owner_id must be exactly 47273232."
  }
}

variable "github_repository_id" {
  description = "Immutable GitHub repository ID permitted to exchange production workload identity tokens."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_repository_id == "1308139775"
    error_message = "github_repository_id must be exactly 1308139775."
  }
}

variable "github_controller_environment" {
  description = "Exact protected GitHub environment permitted to control the deployment runner."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_controller_environment == "production-controller"
    error_message = "github_controller_environment must be exactly production-controller."
  }
}

variable "github_cleanup_environment" {
  description = "Exact protected GitHub environment permitted to clean up the deployment runner."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_cleanup_environment == "production-cleanup"
    error_message = "github_cleanup_environment must be exactly production-cleanup."
  }
}

variable "github_infrastructure_environment" {
  description = "Exact protected GitHub environment permitted to exchange infrastructure automation tokens."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_infrastructure_environment == "production-infrastructure"
    error_message = "github_infrastructure_environment must be exactly production-infrastructure."
  }
}

variable "state_bucket_name" {
  description = "Globally unique Object Storage bucket name for protected Terraform state."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.state_bucket_name)) >= 3
    error_message = "state_bucket_name must contain at least three characters."
  }
}

variable "kms_key_id" {
  description = "Existing KMS key used by production disks and encrypted buckets."
  type        = string
  nullable    = false
}

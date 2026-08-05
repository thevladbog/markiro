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
    condition     = var.github_repository == "thevladbog/q"
    error_message = "github_repository must be exactly thevladbog/q."
  }
}

variable "github_environment" {
  description = "Exact protected GitHub environment permitted to exchange production workload identity tokens."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_environment == "production"
    error_message = "github_environment must be exactly production."
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

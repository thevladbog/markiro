variable "folder_id" {
  description = "Yandex Cloud folder containing production identities and resources."
  type        = string
  nullable    = false
}

variable "organization_id" {
  description = "Yandex Cloud organization owning the infrastructure federation."
  type        = string
  nullable    = false
}

variable "github_repository" {
  description = "Exact GitHub owner/repository allowed by workload identity."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_repository == "thevladbog/markiro"
    error_message = "github_repository must be exactly thevladbog/markiro."
  }
}

variable "github_repository_owner_id" {
  description = "Immutable GitHub repository owner ID."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_repository_owner_id == "47273232"
    error_message = "github_repository_owner_id must be exactly 47273232."
  }
}

variable "github_repository_id" {
  description = "Immutable GitHub repository ID."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_repository_id == "1308139775"
    error_message = "github_repository_id must be exactly 1308139775."
  }
}

variable "github_infrastructure_environment" {
  description = "Protected GitHub environment allowed to create Terraform plans."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_infrastructure_environment == "production-infrastructure"
    error_message = "github_infrastructure_environment must be exactly production-infrastructure."
  }
}

variable "github_infrastructure_apply_environment" {
  description = "Separately protected GitHub environment allowed to apply reviewed Terraform plans."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_infrastructure_apply_environment == "production-infrastructure-apply"
    error_message = "github_infrastructure_apply_environment must be exactly production-infrastructure-apply."
  }
}

variable "state_bucket_name" {
  description = "Name of the protected Terraform state bucket."
  type        = string
  nullable    = false
}

variable "runtime_secret_id" {
  description = "Runtime Lockbox container readable only by the app service account."
  type        = string
  nullable    = false
}

variable "state_backend_secret_id" {
  description = "State-backend Lockbox container readable only by Terraform automation."
  type        = string
  nullable    = false
}

variable "labels" {
  description = "Common non-secret labels for production identities."
  type        = map(string)
  nullable    = false
}

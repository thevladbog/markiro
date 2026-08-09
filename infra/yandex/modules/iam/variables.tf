variable "folder_id" {
  description = "Yandex Cloud folder containing production identities and protected resources."
  type        = string
  nullable    = false
}

variable "organization_id" {
  description = "Yandex Cloud organization that owns the production identity boundary."
  type        = string
  nullable    = false
}

variable "github_repository" {
  description = "Exact GitHub owner/repository allowed by the workload credential."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_repository == "thevladbog/markiro"
    error_message = "github_repository must be exactly thevladbog/markiro."
  }
}

variable "github_repository_owner_id" {
  description = "Immutable GitHub repository owner ID allowed by the workload credential."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_repository_owner_id == "47273232"
    error_message = "github_repository_owner_id must be exactly 47273232."
  }
}

variable "github_repository_id" {
  description = "Immutable GitHub repository ID allowed by the workload credential."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_repository_id == "1308139775"
    error_message = "github_repository_id must be exactly 1308139775."
  }
}

variable "github_deploy_environment" {
  description = "Exact protected GitHub environment allowed to deploy through the hosted workflow."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_deploy_environment == "production-deploy"
    error_message = "github_deploy_environment must be exactly production-deploy."
  }
}

variable "github_infrastructure_environment" {
  description = "Exact protected GitHub environment allowed to manage Terraform infrastructure."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_infrastructure_environment == "production-infrastructure"
    error_message = "github_infrastructure_environment must be exactly production-infrastructure."
  }
}

variable "state_bucket_name" {
  description = "Name of the protected Terraform state bucket."
  type        = string
  nullable    = false
}

variable "runtime_secret_id" {
  description = "Lockbox runtime container readable only by the app service account."
  type        = string
  nullable    = false
}

variable "registry_secret_id" {
  description = "Lockbox registry container readable only by the hosted deployment controller."
  type        = string
  nullable    = false
}

variable "state_backend_secret_id" {
  description = "Lockbox state-backend container readable only by Terraform automation."
  type        = string
  nullable    = false
}

variable "labels" {
  description = "Common non-secret labels for production identity resources."
  type        = map(string)
  nullable    = false
}

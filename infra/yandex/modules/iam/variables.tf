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
    condition     = var.github_repository == "thevladbog/q"
    error_message = "github_repository must be exactly thevladbog/q."
  }
}

variable "github_environment" {
  description = "Exact protected GitHub environment allowed by the workload credential."
  type        = string
  nullable    = false

  validation {
    condition     = var.github_environment == "production"
    error_message = "github_environment must be exactly production."
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

variable "state_backend_secret_id" {
  description = "Lockbox state-backend container readable only by Terraform automation."
  type        = string
  nullable    = false
}

variable "runner_registration_secret_id" {
  description = "Lockbox runner-registration container readable only by the runner."
  type        = string
  nullable    = false
}

variable "labels" {
  description = "Common non-secret labels for production identity resources."
  type        = map(string)
  nullable    = false
}

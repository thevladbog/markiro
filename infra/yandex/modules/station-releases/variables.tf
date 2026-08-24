variable "folder_id" {
  description = "Yandex Cloud folder containing the Station release origin."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.folder_id)) > 0
    error_message = "folder_id must be nonblank."
  }
}

variable "dns_zone_id" {
  description = "Existing Cloud DNS zone that owns certificate challenges and the gated release hostname."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.dns_zone_id)) > 0
    error_message = "dns_zone_id must be nonblank."
  }
}

variable "domain" {
  description = "Fixed public Station release authority."
  type        = string
  nullable    = false

  validation {
    condition     = var.domain == "releases.markiro.app"
    error_message = "domain must be exactly releases.markiro.app."
  }
}

variable "bucket_name" {
  description = "Globally unique bucket dedicated to Station release objects."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be a 3-63 character lowercase S3 bucket name."
  }
}

variable "terraform_service_account_id" {
  description = "Terraform identity allowed to manage the dedicated release bucket."
  type        = string
  nullable    = false

  validation {
    condition     = length(trimspace(var.terraform_service_account_id)) > 0
    error_message = "terraform_service_account_id must be nonblank."
  }
}

variable "publisher_pgp_key" {
  description = "Base64-encoded PGP public key used to encrypt the publisher secret before it reaches Terraform state."
  type        = string
  nullable    = false
  sensitive   = true

  validation {
    condition     = length(trimspace(var.publisher_pgp_key)) > 0
    error_message = "publisher_pgp_key must be nonblank."
  }
}

variable "public_dns_enabled" {
  description = "Whether the final releases.markiro.app CNAME is published after separate approval."
  type        = bool
  default     = false
  nullable    = false
}

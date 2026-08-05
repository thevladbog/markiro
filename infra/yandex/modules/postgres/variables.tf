variable "folder_id" {
  description = "Yandex Cloud folder containing the managed PostgreSQL cluster."
  type        = string
  nullable    = false
}

variable "zone" {
  description = "Availability zone for the private PostgreSQL host."
  type        = string
  nullable    = false
}

variable "network_id" {
  description = "Production VPC ID containing the private PostgreSQL host."
  type        = string
  nullable    = false
}

variable "data_subnet_id" {
  description = "Private data subnet ID for the PostgreSQL host."
  type        = string
  nullable    = false
}

variable "data_security_group_id" {
  description = "Security group that accepts PostgreSQL traffic only from the application."
  type        = string
  nullable    = false
}

variable "kms_key_id" {
  description = "Existing approved KMS key ID used to encrypt PostgreSQL disks."
  type        = string
  nullable    = false
}

variable "database_name" {
  description = "PostgreSQL database and pre-provisioned owner identity name."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z_][a-z0-9_]{0,62}$", var.database_name))
    error_message = "database_name must be a lowercase PostgreSQL identifier no longer than 63 characters."
  }
}

variable "database_disk_size_gb" {
  description = "Allocated PostgreSQL SSD size in GiB; production starts at a recoverable minimum."
  type        = number
  nullable    = false

  validation {
    condition     = var.database_disk_size_gb >= 50
    error_message = "database_disk_size_gb must be at least 50 GiB."
  }
}

variable "labels" {
  description = "Common non-secret labels for the PostgreSQL cluster."
  type        = map(string)
  nullable    = false
}

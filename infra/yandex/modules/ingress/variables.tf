variable "folder_id" {
  description = "Yandex Cloud folder containing the protected ingress resources."
  type        = string
  nullable    = false
}

variable "zone" {
  description = "Availability zone for the reserved IPv4 address and ALB allocation."
  type        = string
  nullable    = false
}

variable "network_id" {
  description = "Production VPC network ID for the application load balancer."
  type        = string
  nullable    = false
}

variable "alb_subnet_id" {
  description = "ALB subnet ID in the production VPC."
  type        = string
  nullable    = false
}

variable "alb_security_group_id" {
  description = "Security group that permits public HTTP and HTTPS only to the ALB."
  type        = string
  nullable    = false
}

variable "app_target_group_id" {
  description = "Private application target group reached through Caddy on port 8080."
  type        = string
  nullable    = false
}

variable "domain" {
  description = "Exact public authority served by the protected ingress."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.domain))
    error_message = "domain must be a lowercase fully-qualified domain name."
  }
}

variable "dns_zone_id" {
  description = "Cloud DNS zone ID that owns the certificate validation and gated application records."
  type        = string
  nullable    = false
}

variable "public_dns_enabled" {
  description = "Whether to publish the application A record after explicit go-live approval."
  type        = bool
  default     = false
  nullable    = false
}

variable "log_group_id" {
  description = "Cloud Logging group ID for ALB and Smart Web Security events."
  type        = string
  nullable    = false
}

variable "global_rate_limit" {
  description = "Maximum aggregate requests per rate-limit period; sized above normal CommerceML upload traffic."
  type        = number
  default     = 10000
  nullable    = false

  validation {
    condition     = var.global_rate_limit == floor(var.global_rate_limit) && var.global_rate_limit >= 1 && var.global_rate_limit <= 9999999999999
    error_message = "global_rate_limit must be an integer between 1 and 9999999999999."
  }
}

variable "per_ip_rate_limit" {
  description = "Maximum requests from one client IP per rate-limit period; sized above normal CommerceML upload traffic."
  type        = number
  default     = 1000
  nullable    = false

  validation {
    condition     = var.per_ip_rate_limit == floor(var.per_ip_rate_limit) && var.per_ip_rate_limit >= 1 && var.per_ip_rate_limit <= 9999999999999
    error_message = "per_ip_rate_limit must be an integer between 1 and 9999999999999."
  }
}

variable "rate_limit_period_seconds" {
  description = "Shared ARL quota period in seconds."
  type        = number
  default     = 60
  nullable    = false

  validation {
    condition     = var.rate_limit_period_seconds == floor(var.rate_limit_period_seconds) && var.rate_limit_period_seconds >= 1
    error_message = "rate_limit_period_seconds must be at least one second."
  }
}

variable "labels" {
  description = "Common non-secret labels for ingress resources."
  type        = map(string)
  nullable    = false
}

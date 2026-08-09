variable "folder_id" {
  description = "Yandex Cloud folder containing the private production network."
  type        = string
  nullable    = false
}

variable "zone" {
  description = "Single availability zone for the initial production topology."
  type        = string
  nullable    = false
}

variable "app_subnet_cidr" {
  description = "CIDR for application virtual machines."
  type        = string
  nullable    = false
}

variable "data_subnet_cidr" {
  description = "CIDR for private data services."
  type        = string
  nullable    = false
}

variable "labels" {
  description = "Common non-secret labels for network resources."
  type        = map(string)
  nullable    = false
}

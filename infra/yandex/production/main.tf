locals {
  labels = {
    app         = "markiro"
    environment = "production"
    managed_by  = "terraform"
  }
}

module "network" {
  source = "../modules/network"

  folder_id              = var.folder_id
  zone                   = var.zone
  alb_subnet_cidr        = var.alb_subnet_cidr
  app_subnet_cidr        = var.app_subnet_cidr
  data_subnet_cidr       = var.data_subnet_cidr
  management_subnet_cidr = var.management_subnet_cidr
  labels                 = local.labels
}

module "compute" {
  source = "../modules/compute"

  folder_id                 = var.folder_id
  zone                      = var.zone
  ubuntu_lts_image_family   = var.ubuntu_lts_image_family
  kms_key_id                = var.kms_key_id
  app_service_account_id    = var.app_service_account_id
  runner_service_account_id = var.runner_service_account_id
  app_subnet_id             = module.network.app_subnet_id
  management_subnet_id      = module.network.management_subnet_id
  app_security_group_id     = module.network.security_group_ids.app
  runner_security_group_id  = module.network.security_group_ids.runner
  labels                    = local.labels
}

module "postgres" {
  source = "../modules/postgres"

  folder_id              = var.folder_id
  zone                   = var.zone
  network_id             = module.network.network_id
  data_subnet_id         = module.network.data_subnet_id
  data_security_group_id = module.network.security_group_ids.data
  kms_key_id             = var.kms_key_id
  database_name          = var.database_name
  database_disk_size_gb  = var.database_disk_size_gb
  labels                 = local.labels
}

module "object_storage" {
  source = "../modules/object-storage"

  folder_id                = var.folder_id
  kms_key_id               = var.kms_key_id
  media_bucket_name        = var.media_bucket_name
  audit_bucket_name        = var.audit_bucket_name
  app_service_account_id   = var.app_service_account_id
  audit_service_account_id = var.audit_service_account_id
}

module "ingress" {
  source = "../modules/ingress"

  folder_id                 = var.folder_id
  zone                      = var.zone
  network_id                = module.network.network_id
  alb_subnet_id             = module.network.alb_subnet_id
  alb_security_group_id     = module.network.security_group_ids.alb
  app_target_group_id       = module.compute.app_target_group_id
  domain                    = var.domain
  dns_zone_id               = var.dns_zone_id
  public_dns_enabled        = var.public_dns_enabled
  log_group_id              = var.log_group_id
  global_rate_limit         = var.global_rate_limit
  per_ip_rate_limit         = var.per_ip_rate_limit
  rate_limit_period_seconds = var.rate_limit_period_seconds
  labels                    = local.labels
}

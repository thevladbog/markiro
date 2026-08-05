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

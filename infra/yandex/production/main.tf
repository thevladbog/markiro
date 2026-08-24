locals {
  admin_dns_name      = "${trimsuffix(var.domain, ".")}."
  saas_admin_dns_name = "${trimsuffix(var.saas_admin_domain, ".")}."
  kiosk_dns_name      = "${trimsuffix(var.kiosk_domain, ".")}."
  landing_dns_name    = "${trimsuffix(var.landing_domain, ".")}."
  labels = {
    app         = "markiro"
    environment = "production"
    managed_by  = "terraform"
  }
}

check "workload_service_account_ids_are_distinct" {
  assert {
    condition = length(toset([
      var.app_service_account_id,
      var.terraform_service_account_id,
      ])) == 2 && alltrue([
      for identity in [
        var.app_service_account_id,
        var.terraform_service_account_id,
      ] : length(trimspace(identity)) > 0
    ])
    error_message = "app and Terraform service account IDs must be nonblank and distinct."
  }
}

module "network" {
  source = "../modules/network"

  folder_id        = var.folder_id
  zone             = var.zone
  app_subnet_cidr  = var.app_subnet_cidr
  data_subnet_cidr = var.data_subnet_cidr
  labels           = local.labels
}

module "compute" {
  source = "../modules/compute"

  folder_id                 = var.folder_id
  zone                      = var.zone
  ubuntu_lts_image_family   = var.ubuntu_lts_image_family
  kms_key_id                = var.kms_key_id
  app_service_account_id    = var.app_service_account_id
  runtime_secret_id         = var.runtime_secret_id
  app_deploy_ssh_public_key = var.app_deploy_ssh_public_key
  app_subnet_id             = module.network.app_subnet_id
  app_security_group_id     = module.network.security_group_ids.app
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

  folder_id                    = var.folder_id
  kms_key_id                   = var.kms_key_id
  state_bucket_name            = var.state_bucket_name
  media_bucket_name            = var.media_bucket_name
  audit_bucket_name            = var.audit_bucket_name
  app_service_account_id       = var.app_service_account_id
  terraform_service_account_id = var.terraform_service_account_id
}

module "station_releases" {
  source = "../modules/station-releases"

  folder_id                    = var.folder_id
  dns_zone_id                  = var.dns_zone_id
  domain                       = var.station_release_domain
  bucket_name                  = var.station_release_bucket_name
  terraform_service_account_id = var.terraform_service_account_id
  publisher_pgp_key            = var.station_release_publisher_pgp_key
  public_dns_enabled           = var.station_release_public_dns_enabled
}

resource "yandex_dns_recordset" "application" {
  count = var.public_dns_enabled ? 1 : 0

  zone_id = var.dns_zone_id
  name    = local.admin_dns_name
  type    = "A"
  ttl     = 300
  data    = [module.compute.app_public_ip]
}

resource "yandex_dns_recordset" "saas_admin_application" {
  count = var.public_dns_enabled ? 1 : 0

  zone_id = var.dns_zone_id
  name    = local.saas_admin_dns_name
  type    = "A"
  ttl     = 300
  data    = [module.compute.app_public_ip]
}

resource "yandex_dns_recordset" "kiosk_application" {
  count = var.public_dns_enabled ? 1 : 0

  zone_id = var.dns_zone_id
  name    = local.kiosk_dns_name
  type    = "A"
  ttl     = 300
  data    = [module.compute.app_public_ip]
}

resource "yandex_dns_recordset" "landing_application" {
  count = var.public_dns_enabled ? 1 : 0

  zone_id = var.dns_zone_id
  name    = local.landing_dns_name
  type    = "A"
  ttl     = 300
  data    = [module.compute.app_public_ip]
}

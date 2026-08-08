locals {
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
      var.runner_service_account_id,
      var.deployment_controller_service_account_id,
      var.audit_service_account_id,
      var.terraform_service_account_id,
      ])) == 5 && alltrue([
      for identity in [
        var.app_service_account_id,
        var.runner_service_account_id,
        var.deployment_controller_service_account_id,
        var.audit_service_account_id,
        var.terraform_service_account_id,
      ] : length(trimspace(identity)) > 0
    ])
    error_message = "app, runner, deployment controller, audit, and Terraform service account IDs must be nonblank and pairwise distinct."
  }
}

# Kept outside the observability module so both VM cloud-init templates can
# target the retained group without introducing a compute/observability cycle.
resource "yandex_logging_group" "application" {
  name             = "markiro-production-application"
  folder_id        = var.folder_id
  retention_period = "336h"
  labels           = local.labels
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

  folder_id                                = var.folder_id
  zone                                     = var.zone
  ubuntu_lts_image_family                  = var.ubuntu_lts_image_family
  kms_key_id                               = var.kms_key_id
  application_log_group_id                 = yandex_logging_group.application.id
  app_service_account_id                   = var.app_service_account_id
  runtime_secret_id                        = var.runtime_secret_id
  runner_service_account_id                = var.runner_service_account_id
  deployment_controller_service_account_id = var.deployment_controller_service_account_id
  app_subnet_id                            = module.network.app_subnet_id
  management_subnet_id                     = module.network.management_subnet_id
  app_security_group_id                    = module.network.security_group_ids.app
  runner_security_group_id                 = module.network.security_group_ids.runner
  labels                                   = local.labels
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
  audit_service_account_id     = var.audit_service_account_id
  terraform_service_account_id = var.terraform_service_account_id
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
  kiosk_domain              = var.kiosk_domain
  dns_zone_id               = var.dns_zone_id
  public_dns_enabled        = var.public_dns_enabled
  application_log_group_id  = module.observability.application_log_group_id
  security_log_group_id     = module.observability.security_log_group_id
  global_rate_limit         = var.global_rate_limit
  per_ip_rate_limit         = var.per_ip_rate_limit
  rate_limit_period_seconds = var.rate_limit_period_seconds
  labels                    = local.labels
}

module "observability" {
  source = "../modules/observability"

  folder_id                = var.folder_id
  application_log_group_id = yandex_logging_group.application.id
  audit_service_account_id = var.audit_service_account_id
  audit_log_group_id       = var.audit_log_group_id
  state_bucket_name        = var.state_bucket_name
  media_bucket_name        = module.object_storage.media_bucket_name
  audit_bucket_name        = module.object_storage.audit_bucket_name
  lockbox_secret_ids = toset([
    var.runtime_secret_id,
    var.registry_secret_id,
    var.runner_registration_secret_id,
  ])
  load_balancer_id        = module.ingress.load_balancer_id
  backend_group_id        = module.ingress.backend_group_id
  security_profile_id     = module.ingress.security_profile_id
  rate_limiter_profile_id = module.ingress.rate_limiter_profile_id
  app_instance_id         = module.compute.app_instance_id
  runner_instance_id      = module.compute.runner_instance_id
  postgres_cluster_id     = module.postgres.cluster_id
  certificate_ids = [
    module.ingress.certificate_id,
    module.ingress.kiosk_certificate_id,
  ]
  observability_phase     = var.observability_phase
  notification_channel_id = var.notification_channel_id
  alert_ids               = var.alert_ids
  labels                  = local.labels
}

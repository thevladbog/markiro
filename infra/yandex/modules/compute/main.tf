terraform {
  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "= 0.215.0"
    }
  }
}

data "yandex_compute_image" "ubuntu_lts" {
  family = var.ubuntu_lts_image_family
}

locals {
  app_cloud_init = templatefile("${path.module}/cloud-init-app.yaml.tftpl", {
    app_deploy_ssh_public_key = var.app_deploy_ssh_public_key
    runtime_secret_id         = var.runtime_secret_id
    runtime_env_script_b64    = base64encode(file("${path.module}/../../../../deploy/yandex/runtime-env.mjs"))
    registry_auth_script_b64  = base64encode(file("${path.module}/../../../../deploy/yandex/registry-auth.mjs"))
    container_runtime_script_b64 = base64encode(
      file("${path.module}/../../../../deploy/yandex/container-runtime.mjs")
    )
    container_installer_b64 = base64encode(file("${path.module}/../../../../deploy/yandex/install-container-runtime.sh"))
    cli_main_script_b64     = base64encode(file("${path.module}/../../../../deploy/yandex/cli-main.mjs"))
    environment_inventory_b64 = base64encode(
      file("${path.module}/../../../../.env.production.example")
    )
    compose_contract_env_b64 = base64encode(file("${path.module}/../../../../deploy/yandex/compose-contract.env"))
    production_compose_b64   = base64encode(file("${path.module}/../../../../compose.production.yml"))
    docker_unit_b64          = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/docker.service"))
    runtime_env_unit_b64 = base64encode(
      file("${path.module}/../../../../deploy/yandex/systemd/markiro-runtime-env.service")
    )
    compose_runtime_dropin_b64 = base64encode(
      file("${path.module}/../../../../deploy/yandex/systemd/markiro-compose.service.d/runtime-env.conf")
    )
    deploy_runtime_dropin_b64 = base64encode(
      file("${path.module}/../../../../deploy/yandex/systemd/markiro-deploy.service.d/runtime-env.conf")
    )
    registry_auth_tmpfiles_b64 = base64encode(
      file("${path.module}/../../../../deploy/yandex/tmpfiles.d/markiro-registry-auth.conf")
    )
  })
}

resource "yandex_vpc_address" "app" {
  name                = "markiro-production-app"
  folder_id           = var.folder_id
  deletion_protection = true
  labels              = var.labels

  external_ipv4_address {
    zone_id = var.zone
  }
}

resource "yandex_compute_instance" "app" {
  name                      = "markiro-production-app"
  hostname                  = "markiro-app"
  folder_id                 = var.folder_id
  zone                      = var.zone
  platform_id               = "standard-v3"
  service_account_id        = var.app_service_account_id
  allow_stopping_for_update = true
  labels                    = var.labels

  resources {
    cores         = 2
    memory        = 4
    core_fraction = 100
  }

  boot_disk {
    initialize_params {
      image_id   = data.yandex_compute_image.ubuntu_lts.id
      type       = "network-ssd"
      size       = 50
      kms_key_id = var.kms_key_id
    }
  }

  network_interface {
    subnet_id          = var.app_subnet_id
    security_group_ids = [var.app_security_group_id]
    nat                = true
    nat_ip_address     = yandex_vpc_address.app.external_ipv4_address[0].address
  }

  metadata = {
    enable-oslogin     = false
    serial-port-enable = false
    user-data          = local.app_cloud_init
  }
}

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
    cores         = 4
    memory        = 8
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
    nat                = false
  }

  metadata = {
    enable-oslogin     = true
    serial-port-enable = false
    user-data = templatefile("${path.module}/cloud-init-app.yaml.tftpl", {
      folder_id                      = var.folder_id
      runtime_secret_id              = var.runtime_secret_id
      runtime_env_script_b64         = base64encode(file("${path.module}/../../../../deploy/yandex/runtime-env.mjs"))
      readiness_observer_script_b64  = base64encode(file("${path.module}/../../../../deploy/yandex/readiness-observer.mjs"))
      monitoring_producer_script_b64 = base64encode(file("${path.module}/../../../../deploy/yandex/monitoring-producer.mjs"))
      log_sanitizer_script_b64       = base64encode(file("${path.module}/../../../../deploy/yandex/log-sanitizer.mjs"))
      registry_auth_script_b64       = base64encode(file("${path.module}/../../../../deploy/yandex/registry-auth.mjs"))
      container_runtime_script_b64   = base64encode(file("${path.module}/../../../../deploy/yandex/container-runtime.mjs"))
      container_installer_b64        = base64encode(file("${path.module}/../../../../deploy/yandex/install-container-runtime.sh"))
      cli_main_script_b64            = base64encode(file("${path.module}/../../../../deploy/yandex/cli-main.mjs"))
      environment_inventory_b64      = base64encode(file("${path.module}/../../../../.env.production.example"))
      compose_contract_env_b64       = base64encode(file("${path.module}/../../../../deploy/yandex/compose-contract.env"))
      production_compose_b64         = base64encode(file("${path.module}/../../../../compose.production.yml"))
      docker_unit_b64                = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/docker.service"))
      monitoring_unit_b64            = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-monitoring-producer.service"))
      monitoring_timer_b64           = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-monitoring-producer.timer"))
      log_sanitizer_unit_b64         = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-log-sanitizer.service"))
      log_sanitizer_timer_b64        = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-log-sanitizer.timer"))
      unified_agent_logs_b64 = base64encode(templatefile("${path.module}/../../../../deploy/yandex/unified-agent-logs.yaml.tftpl", {
        folder_id                = var.folder_id
        application_log_group_id = var.application_log_group_id
      }))
      runtime_env_unit_b64         = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-runtime-env.service"))
      readiness_observer_unit_b64  = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-readiness-observer.service"))
      readiness_observer_timer_b64 = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-readiness-observer.timer"))
      compose_runtime_dropin_b64   = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-compose.service.d/runtime-env.conf"))
      deploy_runtime_dropin_b64    = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-deploy.service.d/runtime-env.conf"))
    })
  }
}

resource "yandex_compute_instance" "runner" {
  name                      = "markiro-production-runner"
  hostname                  = "markiro-runner"
  folder_id                 = var.folder_id
  zone                      = var.zone
  platform_id               = "standard-v3"
  service_account_id        = var.runner_service_account_id
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
      size       = 30
      kms_key_id = var.kms_key_id
    }
  }

  network_interface {
    subnet_id          = var.management_subnet_id
    security_group_ids = [var.runner_security_group_id]
    nat                = false
  }

  metadata = {
    enable-oslogin     = true
    serial-port-enable = false
    user-data = templatefile("${path.module}/cloud-init-runner.yaml.tftpl", {
      runner_unit_b64             = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-runner.service"))
      monitoring_producer_b64     = base64encode(file("${path.module}/../../../../deploy/yandex/monitoring-producer.mjs"))
      log_sanitizer_script_b64    = base64encode(file("${path.module}/../../../../deploy/yandex/log-sanitizer.mjs"))
      runner_monitoring_unit_b64  = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-runner-monitoring.service"))
      runner_monitoring_timer_b64 = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-runner-monitoring.timer"))
      log_sanitizer_unit_b64      = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-log-sanitizer.service"))
      log_sanitizer_timer_b64     = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/markiro-log-sanitizer.timer"))
      unified_agent_logs_b64 = base64encode(templatefile("${path.module}/../../../../deploy/yandex/unified-agent-logs.yaml.tftpl", {
        folder_id                = var.folder_id
        application_log_group_id = var.application_log_group_id
      }))
      cli_main_script_b64     = base64encode(file("${path.module}/../../../../deploy/yandex/cli-main.mjs"))
      container_installer_b64 = base64encode(file("${path.module}/../../../../deploy/yandex/install-container-runtime.sh"))
      docker_unit_b64         = base64encode(file("${path.module}/../../../../deploy/yandex/systemd/docker.service"))
      folder_id               = var.folder_id
    })
  }
}

resource "yandex_compute_instance_iam_binding" "runner_operator" {
  instance_id = yandex_compute_instance.runner.id
  role        = "compute.operator"
  members = [
    "serviceAccount:${var.deployment_controller_service_account_id}",
    "serviceAccount:${var.runner_service_account_id}",
  ]
}

resource "yandex_compute_instance_iam_binding" "deployment_controller_app_viewer" {
  instance_id = yandex_compute_instance.app.id
  role        = "compute.viewer"
  members     = ["serviceAccount:${var.deployment_controller_service_account_id}"]
}

resource "yandex_compute_instance_iam_binding" "runner_app_os_login" {
  instance_id = yandex_compute_instance.app.id
  role        = "compute.osAdminLogin"
  members     = ["serviceAccount:${var.runner_service_account_id}"]
}

# Application Load Balancer does not expose a load-balancer-level IAM binding in
# yandex-cloud/yandex 0.215.0. Folder scope is therefore the narrowest
# provider-supported scope for the read-only target-state permission.
resource "yandex_resourcemanager_folder_iam_member" "runner_alb_viewer" {
  folder_id = var.folder_id
  role      = "alb.viewer"
  member    = "serviceAccount:${var.runner_service_account_id}"
}

resource "yandex_alb_target_group" "app" {
  name      = "markiro-production-app"
  folder_id = var.folder_id
  labels    = var.labels

  target {
    subnet_id  = var.app_subnet_id
    ip_address = yandex_compute_instance.app.network_interface.0.ip_address
  }
}

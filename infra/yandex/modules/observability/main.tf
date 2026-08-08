terraform {
  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "= 0.215.0"
    }
  }
}

locals {
  lockbox_data_events = [
    "yandex.cloud.audit.lockbox.GetPayload",
    "yandex.cloud.audit.lockbox.GetPayloadEx",
  ]
  media_data_events = [
    "yandex.cloud.audit.storage.ObjectCreate",
    "yandex.cloud.audit.storage.ObjectUpdate",
    "yandex.cloud.audit.storage.ObjectDelete",
    "yandex.cloud.audit.storage.ObjectGetByPresignURL",
  ]

  # Provider 0.215.0 has no Monitoring alert resource. These specifications are
  # the fail-closed contract for the console-created alert IDs supplied by the
  # operator. The same queries drive the Terraform-managed dashboard widgets.
  alert_specs = {
    alb_healthy_backend = {
      category                = "alb_healthy_backend"
      title                   = "ALB healthy backend"
      metric                  = "markiro.alb.healthy_backends"
      query                   = "\"markiro.alb.healthy_backends\"{folderId=\"${var.folder_id}\", service=\"custom\", load_balancer_id=\"${var.load_balancer_id}\", backend_group_id=\"${var.backend_group_id}\"}"
      comparison              = "LESS_THAN"
      warning_threshold       = 1
      alarm_threshold         = 0.5
      evaluation_window       = "2m"
      missing_data_behavior   = "ALARM"
      producer                = "app:markiro-monitoring-producer.timer"
      notification_channel_id = var.notification_channel_id
    }
    alb_5xx = {
      category                = "alb_5xx"
      title                   = "ALB 5xx rate"
      metric                  = "load_balancer.requests_count_per_second"
      query                   = "\"load_balancer.requests_count_per_second\"{folderId=\"${var.folder_id}\", service=\"application-load-balancer\", load_balancer=\"markiro-production\", code=\"5*\"}"
      comparison              = "GREATER_THAN"
      warning_threshold       = 1
      alarm_threshold         = 5
      evaluation_window       = "5m"
      notification_channel_id = var.notification_channel_id
    }
    alb_latency = {
      category                = "alb_latency"
      title                   = "ALB p99 latency"
      metric                  = "load_balancer.requests_latency_milliseconds"
      query                   = "histogram_percentile(99, \"bin\", \"load_balancer.requests_latency_milliseconds\"{folderId=\"${var.folder_id}\", service=\"application-load-balancer\", load_balancer=\"markiro-production\"})"
      comparison              = "GREATER_THAN"
      warning_threshold       = 750
      alarm_threshold         = 1500
      evaluation_window       = "5m"
      notification_channel_id = var.notification_channel_id
    }
    sws_deny = {
      category                = "sws_deny"
      title                   = "SWS deny rate"
      metric                  = "load_balancer.smart_web_security.requests_per_second"
      query                   = "\"load_balancer.smart_web_security.requests_per_second\"{folderId=\"${var.folder_id}\", service=\"application-load-balancer\", security_profile=\"${var.security_profile_id}\", antirobot_verdict=\"deny\"}"
      comparison              = "GREATER_THAN"
      warning_threshold       = 5
      alarm_threshold         = 20
      evaluation_window       = "5m"
      notification_channel_id = var.notification_channel_id
    }
    sws_arl = {
      category                = "sws_arl"
      title                   = "SWS ARL deny rate"
      metric                  = "load_balancer.smart_web_security.arl_requests_per_second"
      query                   = "\"load_balancer.smart_web_security.arl_requests_per_second\"{folderId=\"${var.folder_id}\", service=\"application-load-balancer\", arl_profile=\"${var.rate_limiter_profile_id}\", arl_verdict=\"deny\"}"
      comparison              = "GREATER_THAN"
      warning_threshold       = 10
      alarm_threshold         = 50
      evaluation_window       = "5m"
      notification_channel_id = var.notification_channel_id
    }
    vm_cpu = {
      category                = "vm_cpu"
      title                   = "VM CPU utilization"
      metric                  = "cpu_usage"
      query                   = "\"cpu_usage\"{folderId=\"${var.folder_id}\", service=\"compute\", resource_id=\"${var.app_instance_id}|${var.runner_instance_id}\"}"
      comparison              = "GREATER_THAN"
      warning_threshold       = 75
      alarm_threshold         = 90
      evaluation_window       = "10m"
      notification_channel_id = var.notification_channel_id
    }
    vm_memory = {
      category                = "vm_memory"
      title                   = "VM memory utilization"
      metric                  = "sys.memory.used_percent"
      query                   = "\"sys.memory.used_percent\"{folderId=\"${var.folder_id}\", service=\"custom\", resource_id=\"${var.app_instance_id}|${var.runner_instance_id}\"}"
      comparison              = "GREATER_THAN"
      warning_threshold       = 80
      alarm_threshold         = 90
      evaluation_window       = "10m"
      missing_data_behavior   = "ALARM"
      producer                = "app+runner:unified-agent.service"
      notification_channel_id = var.notification_channel_id
    }
    vm_disk = {
      category                = "vm_disk"
      title                   = "VM disk utilization"
      metric                  = "sys.filesystem.used_percent"
      query                   = "\"sys.filesystem.used_percent\"{folderId=\"${var.folder_id}\", service=\"custom\", resource_id=\"${var.app_instance_id}|${var.runner_instance_id}\"}"
      comparison              = "GREATER_THAN"
      warning_threshold       = 80
      alarm_threshold         = 90
      evaluation_window       = "10m"
      missing_data_behavior   = "ALARM"
      producer                = "app+runner:unified-agent.service"
      notification_channel_id = var.notification_channel_id
    }
    postgres_availability = {
      category                = "postgres_availability"
      title                   = "PostgreSQL availability"
      metric                  = "postgres-is_alive"
      query                   = "\"postgres-is_alive\"{folderId=\"${var.folder_id}\", service=\"managed-postgresql\", resource_id=\"${var.postgres_cluster_id}\"}"
      comparison              = "LESS_THAN"
      warning_threshold       = 1
      alarm_threshold         = 0.5
      evaluation_window       = "2m"
      notification_channel_id = var.notification_channel_id
    }
    postgres_storage = {
      category                = "postgres_storage"
      title                   = "PostgreSQL storage utilization"
      metric                  = "disk.used_bytes/disk.total_bytes"
      query                   = "100 * \"disk.used_bytes\"{folderId=\"${var.folder_id}\", service=\"managed-postgresql\", resource_id=\"${var.postgres_cluster_id}\"} / \"disk.total_bytes\"{folderId=\"${var.folder_id}\", service=\"managed-postgresql\", resource_id=\"${var.postgres_cluster_id}\"}"
      comparison              = "GREATER_THAN"
      warning_threshold       = 80
      alarm_threshold         = 90
      evaluation_window       = "10m"
      notification_channel_id = var.notification_channel_id
    }
    postgres_connections = {
      category                = "postgres_connections"
      title                   = "PostgreSQL connection utilization"
      metric                  = "postgres_total_connections/postgres_max_connections"
      query                   = "100 * \"postgres_total_connections\"{folderId=\"${var.folder_id}\", service=\"managed-postgresql\", resource_id=\"${var.postgres_cluster_id}\"} / \"postgres_max_connections\"{folderId=\"${var.folder_id}\", service=\"managed-postgresql\", resource_id=\"${var.postgres_cluster_id}\"}"
      comparison              = "GREATER_THAN"
      warning_threshold       = 75
      alarm_threshold         = 90
      evaluation_window       = "10m"
      notification_channel_id = var.notification_channel_id
    }
    postgres_backup_age = {
      category                = "postgres_backup_age"
      title                   = "PostgreSQL backup age"
      metric                  = "markiro.postgres.backup_age_seconds"
      query                   = "\"markiro.postgres.backup_age_seconds\"{folderId=\"${var.folder_id}\", service=\"custom\", resource_id=\"${var.postgres_cluster_id}\"}"
      comparison              = "GREATER_THAN"
      warning_threshold       = 90000
      alarm_threshold         = 172800
      evaluation_window       = "15m"
      missing_data_behavior   = "ALARM"
      producer                = "app:markiro-monitoring-producer.timer"
      notification_channel_id = var.notification_channel_id
    }
    certificate_risk = {
      category                = "certificate_risk"
      title                   = "Certificate expiry risk"
      metric                  = "certificate.days_until_expiration"
      query                   = "\"certificate.days_until_expiration\"{folderId=\"${var.folder_id}\", service=\"certificate-manager\", certificate=\"${var.certificate_id}\"}"
      comparison              = "LESS_THAN"
      warning_threshold       = 30
      alarm_threshold         = 14
      evaluation_window       = "1h"
      notification_channel_id = var.notification_channel_id
    }
    readiness_required_unavailable = {
      category                = "readiness_required_unavailable"
      title                   = "Readiness required dependency unavailable"
      metric                  = "markiro.readiness.required_unavailable"
      query                   = "\"markiro.readiness.required_unavailable\"{folderId=\"${var.folder_id}\", service=\"custom\", resource_id=\"${var.app_instance_id}\"}"
      comparison              = "GREATER_THAN"
      warning_threshold       = 0
      alarm_threshold         = 0.5
      evaluation_window       = "5m"
      missing_data_behavior   = "ALARM"
      producer                = "app:markiro-monitoring-producer.timer"
      notification_channel_id = var.notification_channel_id
    }
    deployment_failure = {
      category                = "deployment_failure"
      title                   = "Deployment failure"
      metric                  = "markiro.deployment.failure"
      query                   = "\"markiro.deployment.failure\"{folderId=\"${var.folder_id}\", service=\"custom\", resource_id=\"${var.app_instance_id}\"}"
      comparison              = "GREATER_THAN"
      warning_threshold       = 0
      alarm_threshold         = 0.5
      evaluation_window       = "5m"
      missing_data_behavior   = "OK"
      producer                = "runner:remote-deploy.mjs"
      notification_channel_id = var.notification_channel_id
    }
    runner_overrun = {
      category                = "runner_overrun"
      title                   = "Runner runtime overrun"
      metric                  = "markiro.runner.runtime_seconds"
      query                   = "\"markiro.runner.runtime_seconds\"{folderId=\"${var.folder_id}\", service=\"custom\", resource_id=\"${var.runner_instance_id}\"}"
      comparison              = "GREATER_THAN"
      warning_threshold       = 3300
      alarm_threshold         = 3600
      evaluation_window       = "5m"
      missing_data_behavior   = "OK"
      producer                = "runner:markiro-runner-monitoring.timer"
      notification_channel_id = var.notification_channel_id
    }
  }
}

resource "yandex_logging_group" "security" {
  name             = "markiro-production-security"
  folder_id        = var.folder_id
  retention_period = "336h"
  labels           = var.labels
}

resource "yandex_audit_trails_trail" "realtime" {
  name               = "markiro-production-audit-realtime"
  folder_id          = var.folder_id
  service_account_id = var.audit_service_account_id
  labels             = var.labels

  logging_destination {
    log_group_id = var.audit_log_group_id
  }

  filtering_policy {
    management_events_filter {
      resource_scope {
        resource_id   = var.folder_id
        resource_type = "resource-manager.folder"
      }
    }

    data_events_filter {
      service         = "lockbox"
      included_events = local.lockbox_data_events

      dynamic "resource_scope" {
        for_each = var.lockbox_secret_ids
        content {
          resource_id   = resource_scope.value
          resource_type = "lockbox.secret"
        }
      }
    }

    data_events_filter {
      service         = "storage"
      included_events = local.media_data_events

      resource_scope {
        resource_id   = var.media_bucket_name
        resource_type = "storage.bucket"
      }
    }
  }
}

resource "yandex_audit_trails_trail" "archive" {
  name               = "markiro-production-audit-archive"
  folder_id          = var.folder_id
  service_account_id = var.audit_service_account_id
  labels             = var.labels

  storage_destination {
    bucket_name   = var.audit_bucket_name
    object_prefix = "audit-trails/"
  }

  filtering_policy {
    management_events_filter {
      resource_scope {
        resource_id   = var.folder_id
        resource_type = "resource-manager.folder"
      }
    }

    data_events_filter {
      service         = "lockbox"
      included_events = local.lockbox_data_events

      dynamic "resource_scope" {
        for_each = var.lockbox_secret_ids
        content {
          resource_id   = resource_scope.value
          resource_type = "lockbox.secret"
        }
      }
    }

    data_events_filter {
      service         = "storage"
      included_events = local.media_data_events

      resource_scope {
        resource_id   = var.media_bucket_name
        resource_type = "storage.bucket"
      }
    }
  }
}

resource "yandex_monitoring_dashboard" "production" {
  name        = "markiro-production"
  title       = "Markiro production"
  description = "Required SaaS health, security, database, delivery, and runner signals."
  folder_id   = var.folder_id
  labels      = var.labels

  dynamic "widgets" {
    for_each = local.alert_specs
    content {
      chart {
        chart_id       = replace(widgets.key, "_", "-")
        title          = widgets.value.title
        display_legend = true

        queries {
          target {
            hidden    = false
            text_mode = true
            query     = widgets.value.query
          }
        }
      }

      position {
        x = index(keys(local.alert_specs), widgets.key) % 2 * 6
        y = floor(index(keys(local.alert_specs), widgets.key) / 2) * 4
        w = 6
        h = 4
      }
    }
  }
}

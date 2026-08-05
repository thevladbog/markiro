output "application_log_group_id" {
  description = "Cloud Logging group ID for ALB application traffic."
  value       = yandex_logging_group.application.id
}

output "security_log_group_id" {
  description = "Cloud Logging group ID for Smart Web Security events."
  value       = yandex_logging_group.security.id
}

output "audit_log_group_id" {
  description = "Cloud Logging group ID for near-real-time Audit Trails events."
  value       = var.audit_log_group_id
}

output "audit_trail_ids" {
  description = "Typed IDs for the one-destination near-real-time and archive trails."
  value = {
    realtime = yandex_audit_trails_trail.realtime.trail_id
    archive  = yandex_audit_trails_trail.archive.trail_id
  }
}

output "dashboard_id" {
  description = "Production Monitoring dashboard ID."
  value       = yandex_monitoring_dashboard.production.dashboard_id
}

output "alert_ids" {
  description = "Validated IDs of the console-created alerts implementing alert_specs."
  value       = var.alert_ids
}

output "alert_specs" {
  description = "Fail-closed specifications for the console-created Monitoring alerts."
  value       = local.alert_specs
}

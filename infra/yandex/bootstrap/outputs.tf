output "service_account_ids" {
  description = "Protected service-account relationships for downstream infrastructure modules."
  value       = module.iam.service_account_ids
  sensitive   = true
}

output "workload_identity_federation_id" {
  description = "Workload identity federation restricted to exact deployment and infrastructure GitHub subjects."
  value       = module.iam.workload_identity_federation_id
  sensitive   = true
}

output "state_bucket_name" {
  description = "Protected Object Storage bucket holding Terraform state."
  value       = yandex_storage_bucket.state.bucket
  sensitive   = true
}

output "runtime_secret_id" {
  description = "Empty runtime Lockbox container populated out of band."
  value       = yandex_lockbox_secret.runtime.id
  sensitive   = true
}

output "registry_secret_id" {
  description = "Empty deploy-only GHCR Lockbox container populated and rotated out of band."
  value       = yandex_lockbox_secret.registry.id
  sensitive   = true
}

output "state_backend_secret_id" {
  description = "Empty state-backend Lockbox container populated out of band."
  value       = yandex_lockbox_secret.state_backend.id
  sensitive   = true
}

output "runner_registration_tombstone_secret_id" {
  description = "Retired runner-registration Lockbox tombstone; it must remain empty and unused."
  value       = yandex_lockbox_secret.runner_registration.id
  sensitive   = true
}

output "audit_log_group_id" {
  description = "Pre-created Cloud Logging destination for the audit trail writer."
  value       = yandex_logging_group.audit.id
  sensitive   = true
}

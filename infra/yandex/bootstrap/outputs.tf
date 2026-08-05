output "service_account_ids" {
  description = "Protected service-account relationships for downstream infrastructure modules."
  value       = module.iam.service_account_ids
  sensitive   = true
}

output "workload_identity_federation_id" {
  description = "Workload identity federation restricted to the production GitHub subject."
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

output "state_backend_secret_id" {
  description = "Empty state-backend Lockbox container populated out of band."
  value       = yandex_lockbox_secret.state_backend.id
  sensitive   = true
}

output "runner_registration_secret_id" {
  description = "Empty runner-registration Lockbox container populated out of band."
  value       = yandex_lockbox_secret.runner_registration.id
  sensitive   = true
}

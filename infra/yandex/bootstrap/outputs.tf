output "service_account_ids" {
  description = "Retained service accounts for infrastructure, state and application runtime."
  value       = module.iam.service_account_ids
  sensitive   = true
}

output "workload_identity_federation_id" {
  description = "Workload identity federation restricted to infrastructure automation."
  value       = module.iam.workload_identity_federation_id
  sensitive   = true
}

output "state_bucket_name" {
  description = "Protected Object Storage bucket holding Terraform state."
  value       = yandex_storage_bucket.state.bucket
  sensitive   = true
}

output "runtime_secret_id" {
  description = "Runtime Lockbox container populated out of band."
  value       = yandex_lockbox_secret.runtime.id
  sensitive   = true
}

output "state_backend_secret_id" {
  description = "State-backend Lockbox container populated out of band."
  value       = yandex_lockbox_secret.state_backend.id
  sensitive   = true
}

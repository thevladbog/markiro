output "service_account_ids" {
  description = "IDs of retained production service accounts."
  value = {
    terraform = yandex_iam_service_account.terraform.id
    state     = yandex_iam_service_account.state.id
    app       = yandex_iam_service_account.app.id
  }
  sensitive = true
}

output "workload_identity_federation_id" {
  description = "ID of the infrastructure-only GitHub OIDC federation."
  value       = yandex_iam_workload_identity_oidc_federation.github.id
  sensitive   = true
}

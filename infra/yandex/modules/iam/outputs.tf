output "service_account_ids" {
  description = "IDs of the production service accounts."
  value = {
    terraform             = yandex_iam_service_account.terraform.id
    state                 = yandex_iam_service_account.state.id
    app                   = yandex_iam_service_account.app.id
    runner                = yandex_iam_service_account.runner.id
    deployment_controller = yandex_iam_service_account.deployment_controller.id
    audit                 = yandex_iam_service_account.audit.id
  }
  sensitive = true
}

output "workload_identity_federation_id" {
  description = "ID of the GitHub OIDC federation with exact deployment and infrastructure subjects."
  value       = yandex_iam_workload_identity_oidc_federation.github.id
  sensitive   = true
}

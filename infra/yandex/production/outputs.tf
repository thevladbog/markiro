output "app_private_ip" {
  description = "Private IPv4 address of the application ALB target."
  value       = module.compute.app_private_ip
}

output "app_target_group_id" {
  description = "ALB target group ID containing the private application target."
  value       = module.compute.app_target_group_id
}

output "runner_instance_id" {
  description = "ID of the normally stopped runner VM."
  value       = module.compute.runner_instance_id
}

output "postgres_cluster_id" {
  description = "ID of the protected production PostgreSQL cluster."
  value       = module.postgres.cluster_id
}

output "postgres_database_id" {
  description = "ID of the protected production PostgreSQL database."
  value       = module.postgres.database_id
}

output "postgres_fqdn" {
  description = "Private FQDN of the production PostgreSQL host."
  value       = module.postgres.fqdn
}

output "media_bucket_name" {
  description = "Private versioned bucket used for application media."
  value       = module.object_storage.media_bucket_name
}

output "audit_bucket_name" {
  description = "Private versioned bucket used for audit archives."
  value       = module.object_storage.audit_bucket_name
}

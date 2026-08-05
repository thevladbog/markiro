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

output "reserved_ipv4_address" {
  description = "Reserved public IPv4 address used by the protected ingress."
  value       = module.ingress.reserved_ipv4_address
}

output "certificate_id" {
  description = "Certificate Manager ID for the public HTTPS listener."
  value       = module.ingress.certificate_id
}

output "certificate_status" {
  description = "Current Certificate Manager issuance status."
  value       = module.ingress.certificate_status
}

output "load_balancer_id" {
  description = "Protected public application load balancer ID."
  value       = module.ingress.load_balancer_id
}

output "load_balancer_address" {
  description = "Reserved public IPv4 address served by the load balancer."
  value       = module.ingress.load_balancer_address
}

output "backend_group_id" {
  description = "ALB backend group that reaches the private app target."
  value       = module.ingress.backend_group_id
}

output "security_profile_id" {
  description = "Smart Web Security profile attached to the virtual host."
  value       = module.ingress.security_profile_id
}

output "approved_a_records" {
  description = "Exact application A-record set approved for gated publication."
  value       = module.ingress.approved_a_records
}

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

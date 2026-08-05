output "app_private_ip" {
  description = "Private IPv4 address registered as the application ALB target."
  value       = yandex_compute_instance.app.network_interface.0.ip_address
}

output "app_target_group_id" {
  description = "ALB target group ID containing the private application target."
  value       = yandex_alb_target_group.app.id
}

output "runner_instance_id" {
  description = "ID of the normally stopped, controller-started runner instance."
  value       = yandex_compute_instance.runner.id
}

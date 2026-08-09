output "app_private_ip" {
  description = "Private IPv4 address registered as the application ALB target."
  value       = yandex_compute_instance.app.network_interface.0.ip_address
}

output "app_public_ip" {
  description = "Reserved public IPv4 address used only for key-authenticated deployment SSH."
  value       = yandex_vpc_address.app.external_ipv4_address[0].address
}

output "app_instance_id" {
  description = "ID of the private application instance."
  value       = yandex_compute_instance.app.id
}

output "app_target_group_id" {
  description = "ALB target group ID containing the private application target."
  value       = yandex_alb_target_group.app.id
}

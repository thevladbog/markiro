output "app_private_ip" {
  description = "Private IPv4 address of the application VM."
  value       = yandex_compute_instance.app.network_interface.0.ip_address
}

output "app_public_ip" {
  description = "Reserved public IPv4 address of the direct application edge."
  value       = yandex_vpc_address.app.external_ipv4_address[0].address
}

output "app_instance_id" {
  description = "ID of the application VM."
  value       = yandex_compute_instance.app.id
}

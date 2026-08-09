output "network_id" {
  description = "ID of the production VPC."
  value       = yandex_vpc_network.production.id
}

output "app_subnet_id" {
  description = "ID of the application subnet."
  value       = yandex_vpc_subnet.app.id
}

output "data_subnet_id" {
  description = "ID of the data subnet."
  value       = yandex_vpc_subnet.data.id
}

output "security_group_ids" {
  description = "IDs of the retained production security groups."
  value = {
    app  = yandex_vpc_security_group.app.id
    data = yandex_vpc_security_group.data.id
  }
}

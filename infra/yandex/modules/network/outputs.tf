output "network_id" {
  description = "ID of the isolated production VPC."
  value       = yandex_vpc_network.production.id
}

output "alb_subnet_id" {
  description = "ID of the application load balancer subnet."
  value       = yandex_vpc_subnet.alb.id
}

output "app_subnet_id" {
  description = "ID of the private application subnet."
  value       = yandex_vpc_subnet.app.id
}

output "data_subnet_id" {
  description = "ID of the private data subnet."
  value       = yandex_vpc_subnet.data.id
}

output "security_group_ids" {
  description = "IDs of the production security groups."
  value = {
    alb  = yandex_vpc_security_group.alb.id
    app  = yandex_vpc_security_group.app.id
    data = yandex_vpc_security_group.data.id
  }
}

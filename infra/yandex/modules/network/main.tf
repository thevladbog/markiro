terraform {
  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "= 0.215.0"
    }
  }
}

resource "yandex_vpc_network" "production" {
  name      = "markiro-production"
  folder_id = var.folder_id
  labels    = var.labels
}

resource "yandex_vpc_gateway" "nat" {
  name      = "markiro-production-nat"
  folder_id = var.folder_id
  labels    = var.labels

  shared_egress_gateway {}
}

resource "yandex_vpc_route_table" "private_egress" {
  name       = "markiro-production-private-egress"
  network_id = yandex_vpc_network.production.id
  folder_id  = var.folder_id
  labels     = var.labels

  static_route {
    destination_prefix = "0.0.0.0/0"
    gateway_id         = yandex_vpc_gateway.nat.id
  }
}

resource "yandex_vpc_subnet" "alb" {
  name           = "markiro-production-alb"
  zone           = var.zone
  network_id     = yandex_vpc_network.production.id
  v4_cidr_blocks = [var.alb_subnet_cidr]
  route_table_id = yandex_vpc_route_table.private_egress.id
  folder_id      = var.folder_id
  labels         = var.labels
}

resource "yandex_vpc_subnet" "app" {
  name           = "markiro-production-app"
  zone           = var.zone
  network_id     = yandex_vpc_network.production.id
  v4_cidr_blocks = [var.app_subnet_cidr]
  route_table_id = yandex_vpc_route_table.private_egress.id
  folder_id      = var.folder_id
  labels         = var.labels
}

resource "yandex_vpc_subnet" "data" {
  name           = "markiro-production-data"
  zone           = var.zone
  network_id     = yandex_vpc_network.production.id
  v4_cidr_blocks = [var.data_subnet_cidr]
  route_table_id = yandex_vpc_route_table.private_egress.id
  folder_id      = var.folder_id
  labels         = var.labels
}

resource "yandex_vpc_subnet" "management" {
  name           = "markiro-production-management"
  zone           = var.zone
  network_id     = yandex_vpc_network.production.id
  v4_cidr_blocks = [var.management_subnet_cidr]
  route_table_id = yandex_vpc_route_table.private_egress.id
  folder_id      = var.folder_id
  labels         = var.labels
}

resource "yandex_vpc_security_group" "alb" {
  name       = "markiro-production-alb"
  network_id = yandex_vpc_network.production.id
  folder_id  = var.folder_id
  labels     = var.labels

  ingress {
    protocol       = "TCP"
    description    = "Public HTTP reaches only the application load balancer."
    from_port      = 80
    to_port        = 80
    v4_cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    protocol       = "TCP"
    description    = "Public HTTPS reaches only the application load balancer."
    from_port      = 443
    to_port        = 443
    v4_cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    protocol       = "ANY"
    description    = "The load balancer uses the NAT gateway for required egress."
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "yandex_vpc_security_group" "app" {
  name       = "markiro-production-app"
  network_id = yandex_vpc_network.production.id
  folder_id  = var.folder_id
  labels     = var.labels

  ingress {
    protocol          = "TCP"
    description       = "Only the ALB may reach the application listener."
    from_port         = 8080
    to_port           = 8080
    security_group_id = yandex_vpc_security_group.alb.id
  }

  ingress {
    protocol          = "TCP"
    description       = "Only the ephemeral runner may use OS Login SSH."
    from_port         = 22
    to_port           = 22
    security_group_id = yandex_vpc_security_group.runner.id
  }

  egress {
    protocol       = "ANY"
    description    = "The private application uses NAT for approved dependencies."
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "yandex_vpc_security_group" "data" {
  name       = "markiro-production-data"
  network_id = yandex_vpc_network.production.id
  folder_id  = var.folder_id
  labels     = var.labels

  ingress {
    protocol          = "TCP"
    description       = "Only the application may reach the PostgreSQL pooler."
    from_port         = 6432
    to_port           = 6432
    security_group_id = yandex_vpc_security_group.app.id
  }

  egress {
    protocol       = "ANY"
    description    = "Data services use private egress for platform maintenance."
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "yandex_vpc_security_group" "runner" {
  name       = "markiro-production-runner"
  network_id = yandex_vpc_network.production.id
  folder_id  = var.folder_id
  labels     = var.labels

  egress {
    protocol       = "ANY"
    description    = "The JIT runner uses NAT while it is explicitly started."
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
}

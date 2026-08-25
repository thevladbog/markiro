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

resource "yandex_vpc_security_group" "app" {
  name       = "markiro-production-app"
  network_id = yandex_vpc_network.production.id
  folder_id  = var.folder_id
  labels     = var.labels

  ingress {
    protocol       = "TCP"
    description    = "GitHub-hosted deployment reaches key-authenticated SSH."
    port           = 22
    v4_cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    protocol       = "TCP"
    description    = "Public HTTP reaches Caddy for redirects and ACME."
    port           = 80
    v4_cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    protocol       = "TCP"
    description    = "Public HTTPS reaches Caddy directly."
    port           = 443
    v4_cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    protocol       = "ANY"
    description    = "The application uses approved external dependencies."
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
    port              = 6432
    security_group_id = yandex_vpc_security_group.app.id
  }

  egress {
    protocol       = "ANY"
    description    = "Data services use private egress for platform maintenance."
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
}

terraform {
  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "= 0.215.0"
    }
  }
}

resource "yandex_mdb_postgresql_cluster" "production" {
  name                   = "markiro-production-postgres"
  description            = "Private production PostgreSQL cluster."
  folder_id              = var.folder_id
  network_id             = var.network_id
  environment            = "PRODUCTION"
  security_group_ids     = [var.data_security_group_id]
  disk_encryption_key_id = var.kms_key_id
  labels                 = var.labels

  config {
    version                   = "17"
    backup_retain_period_days = 14

    backup_window_start {
      hours   = 2
      minutes = 0
    }

    resources {
      resource_preset_id = "s3-c2-m8"
      disk_type_id       = "network-ssd"
      disk_size          = var.database_disk_size_gb
    }
  }

  host {
    zone             = var.zone
    subnet_id        = var.data_subnet_id
    assign_public_ip = false
  }

  maintenance_window {
    type = "WEEKLY"
    day  = "SUN"
    hour = 3
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Terraform deliberately does not create the database owner or its credential.
# The same-named identity is established out of band before this database is applied.
resource "yandex_mdb_postgresql_database" "application" {
  cluster_id = yandex_mdb_postgresql_cluster.production.id
  name       = var.database_name
  owner      = var.database_name

  lifecycle {
    prevent_destroy = true
  }
}

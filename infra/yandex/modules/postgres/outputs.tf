output "cluster_id" {
  description = "ID of the protected production PostgreSQL cluster."
  value       = yandex_mdb_postgresql_cluster.production.id
}

output "database_id" {
  description = "ID of the protected production PostgreSQL database."
  value       = yandex_mdb_postgresql_database.application.id
}

output "fqdn" {
  description = "Private FQDN of the single production PostgreSQL host."
  value       = yandex_mdb_postgresql_cluster.production.host[0].fqdn
}

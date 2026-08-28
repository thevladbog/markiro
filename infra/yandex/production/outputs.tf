output "app_private_ip" {
  description = "Private IPv4 address of the application VM."
  value       = module.compute.app_private_ip
}

output "app_public_ip" {
  description = "Reserved public IPv4 address of the direct application edge."
  value       = module.compute.app_public_ip
}

output "app_instance_id" {
  description = "ID of the application VM."
  value       = module.compute.app_instance_id
}

output "postgres_cluster_id" {
  description = "ID of the protected production PostgreSQL cluster."
  value       = module.postgres.cluster_id
}

output "postgres_database_id" {
  description = "ID of the protected production PostgreSQL database."
  value       = module.postgres.database_id
}

output "postgres_fqdn" {
  description = "Private FQDN of the production PostgreSQL host."
  value       = module.postgres.fqdn
}

output "media_bucket_name" {
  description = "Private versioned bucket used for application media."
  value       = module.object_storage.media_bucket_name
}

output "audit_bucket_name" {
  description = "Temporarily retained audit archive pending explicit cleanup."
  value       = module.object_storage.audit_bucket_name
}

output "station_release_bucket_name" {
  description = "Dedicated versioned bucket containing Station release objects."
  value       = var.station_release_bucket_name
}

output "station_release_publisher_access_key_id" {
  description = "Dedicated Station publisher access key ID."
  value       = module.station_releases.publisher_access_key_id
  sensitive   = true
}

output "station_release_publisher_encrypted_secret_key" {
  description = "PGP-encrypted Station publisher secret key."
  value       = module.station_releases.publisher_encrypted_secret_key
  sensitive   = true
}

output "station_release_cdn_provider_cname" {
  description = "Provider-assigned CNAME target for the Station release CDN."
  value       = module.station_releases.cdn_provider_cname
}

output "station_release_certificate_id" {
  description = "Certificate Manager ID for releases.markiro.app."
  value       = module.station_releases.certificate_id
}

output "admin_domain" {
  description = "Exact admin authority served directly by the app VM."
  value       = var.domain
}

output "saas_admin_domain" {
  description = "Exact platform SaaS administration authority served directly by the app VM."
  value       = var.saas_admin_domain
}

output "kiosk_domain" {
  description = "Exact kiosk authority served directly by the app VM."
  value       = var.kiosk_domain
}

output "landing_domain" {
  description = "Exact landing authority served directly by the app VM."
  value       = var.landing_domain
}

output "station_release_domain" {
  description = "Exact Station release authority served through Yandex Cloud CDN."
  value       = var.station_release_domain
}

output "approved_a_records" {
  description = "Direct-VM A records approved for gated publication."
  value = var.public_dns_enabled ? {
    (local.admin_dns_name)      = module.compute.app_public_ip
    (local.saas_admin_dns_name) = module.compute.app_public_ip
    (local.kiosk_dns_name)      = module.compute.app_public_ip
    (local.landing_dns_name)    = module.compute.app_public_ip
  } : {}
}

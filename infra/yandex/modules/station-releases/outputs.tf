output "publisher_access_key_id" {
  description = "Dedicated Station publisher access key ID."
  value       = yandex_iam_service_account_static_access_key.publisher.access_key
  sensitive   = true
}

output "publisher_encrypted_secret_key" {
  description = "PGP-encrypted Station publisher secret key."
  value       = yandex_iam_service_account_static_access_key.publisher.encrypted_secret_key
  sensitive   = true
}

output "cdn_provider_cname" {
  description = "Provider-assigned CNAME target for the Station release CDN resource."
  value       = yandex_cdn_resource.releases.provider_cname
}

output "certificate_id" {
  description = "Certificate Manager ID requested for releases.markiro.app."
  value       = yandex_cm_certificate.releases.id
}

output "media_bucket_name" {
  description = "Private versioned bucket used for application media."
  value       = yandex_storage_bucket.media.bucket
}

output "audit_bucket_name" {
  description = "Temporarily retained audit archive pending explicit cleanup."
  value       = yandex_storage_bucket.audit.bucket
}

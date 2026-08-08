output "reserved_ipv4_address" {
  description = "Reserved public IPv4 address used by both ALB listeners."
  value       = yandex_vpc_address.markiro.external_ipv4_address.0.address
}

output "certificate_id" {
  description = "Certificate Manager ID presented by the HTTPS listener."
  value       = data.yandex_cm_certificate.issued.id
}

output "certificate_status" {
  description = "Current Certificate Manager issuance status."
  value       = data.yandex_cm_certificate.issued.status
}

output "kiosk_certificate_id" {
  description = "Certificate Manager ID presented for the kiosk authority."
  value       = data.yandex_cm_certificate.kiosk_issued.id
}

output "kiosk_certificate_status" {
  description = "Current kiosk Certificate Manager issuance status."
  value       = data.yandex_cm_certificate.kiosk_issued.status
}

output "admin_domain" {
  description = "Exact admin authority served by the protected ingress."
  value       = var.domain
}

output "kiosk_domain" {
  description = "Exact kiosk authority served by the protected ingress."
  value       = var.kiosk_domain
}

output "load_balancer_id" {
  description = "Protected public application load balancer ID."
  value       = yandex_alb_load_balancer.markiro.id
}

output "load_balancer_address" {
  description = "Reserved IPv4 address of the public application load balancer."
  value       = yandex_vpc_address.markiro.external_ipv4_address.0.address
}

output "backend_group_id" {
  description = "ALB backend group that targets the private Caddy listener."
  value       = yandex_alb_backend_group.app.id
}

output "security_profile_id" {
  description = "Smart Web Security profile attached to virtual-host routes."
  value       = yandex_sws_security_profile.markiro.id
}

output "rate_limiter_profile_id" {
  description = "Advanced Rate Limiter profile ID attached to Smart Web Security."
  value       = yandex_sws_advanced_rate_limiter_profile.markiro.id
}

output "approved_a_records" {
  description = "Exact A-record set approved for publication when public DNS is enabled."
  value       = [yandex_vpc_address.markiro.external_ipv4_address.0.address]
}

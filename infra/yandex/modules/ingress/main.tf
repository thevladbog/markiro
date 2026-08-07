terraform {
  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "= 0.215.0"
    }
  }
}

resource "yandex_vpc_address" "markiro" {
  name                = "markiro-production-ingress"
  folder_id           = var.folder_id
  deletion_protection = true
  labels              = var.labels

  external_ipv4_address {
    zone_id = var.zone
  }
}

resource "yandex_cm_certificate" "markiro" {
  name      = "markiro-production-${var.domain}"
  folder_id = var.folder_id
  domains   = [var.domain]
  labels    = var.labels

  managed {
    challenge_type  = "DNS_CNAME"
    challenge_count = 1
  }
}

resource "yandex_dns_recordset" "certificate_validation" {
  count = 1

  zone_id = var.dns_zone_id
  name    = yandex_cm_certificate.markiro.challenges[count.index].dns_name
  type    = yandex_cm_certificate.markiro.challenges[count.index].dns_type
  ttl     = 300
  data    = [yandex_cm_certificate.markiro.challenges[count.index].dns_value]
}

data "yandex_cm_certificate" "issued" {
  certificate_id  = yandex_cm_certificate.markiro.id
  wait_validation = true

  depends_on = [yandex_dns_recordset.certificate_validation]
}

resource "yandex_alb_backend_group" "app" {
  name      = "markiro-production-app"
  folder_id = var.folder_id
  labels    = var.labels

  http_backend {
    name             = "app-http"
    port             = 8080
    target_group_ids = [var.app_target_group_id]

    healthcheck {
      interval = "5s"
      timeout  = "2s"

      http_healthcheck {
        host = var.domain
        path = "/health/ready"
      }
    }
  }
}

resource "yandex_sws_advanced_rate_limiter_profile" "markiro" {
  name      = "markiro-production-rate-limits"
  folder_id = var.folder_id
  labels    = var.labels

  advanced_rate_limiter_rule {
    name     = "global-request-rate"
    priority = 100

    static_quota {
      action = "DENY"
      limit  = var.global_rate_limit
      period = var.rate_limit_period_seconds
    }
  }

  advanced_rate_limiter_rule {
    name     = "per-ip-request-rate"
    priority = 200

    dynamic_quota {
      action = "DENY"
      limit  = var.per_ip_rate_limit
      period = var.rate_limit_period_seconds

      characteristic {
        simple_characteristic {
          type = "IP"
        }
      }
    }
  }
}

resource "yandex_sws_security_profile" "markiro" {
  name                             = "markiro-production"
  folder_id                        = var.folder_id
  default_action                   = "ALLOW"
  advanced_rate_limiter_profile_id = yandex_sws_advanced_rate_limiter_profile.markiro.id
  labels                           = var.labels

  log_options {
    enable       = true
    log_group_id = var.security_log_group_id
  }
}

resource "yandex_alb_http_router" "markiro" {
  name      = "markiro-production"
  folder_id = var.folder_id
  labels    = var.labels
}

resource "yandex_alb_virtual_host" "markiro" {
  name           = "markiro-production"
  http_router_id = yandex_alb_http_router.markiro.id
  authority      = [var.domain]

  route_options {
    security_profile_id = yandex_sws_security_profile.markiro.id
  }

  route {
    name = "application"

    http_route {
      http_route_action {
        backend_group_id = yandex_alb_backend_group.app.id
      }
    }
  }
}

resource "yandex_alb_load_balancer" "markiro" {
  name               = "markiro-production"
  folder_id          = var.folder_id
  network_id         = var.network_id
  security_group_ids = [var.alb_security_group_id]
  labels             = var.labels

  allocation_policy {
    location {
      zone_id   = var.zone
      subnet_id = var.alb_subnet_id
    }
  }

  listener {
    name = "http-redirect"

    endpoint {
      ports = [80]

      address {
        external_ipv4_address {
          address = yandex_vpc_address.markiro.external_ipv4_address.0.address
        }
      }
    }

    http {
      redirects {
        http_to_https = true
      }
    }
  }

  listener {
    name = "https"

    endpoint {
      ports = [443]

      address {
        external_ipv4_address {
          address = yandex_vpc_address.markiro.external_ipv4_address.0.address
        }
      }
    }

    tls {
      default_handler {
        certificate_ids = [data.yandex_cm_certificate.issued.id]

        http_handler {
          http_router_id = yandex_alb_http_router.markiro.id
        }
      }
    }
  }

  log_options {
    log_group_id = var.application_log_group_id
  }
}

resource "yandex_dns_recordset" "application" {
  count = var.public_dns_enabled ? 1 : 0

  zone_id = var.dns_zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  data    = [yandex_vpc_address.markiro.external_ipv4_address.0.address]
}

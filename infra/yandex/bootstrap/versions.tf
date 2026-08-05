terraform {
  required_version = "= 1.15.8"

  backend "s3" {}

  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "= 0.215.0"
    }
  }
}

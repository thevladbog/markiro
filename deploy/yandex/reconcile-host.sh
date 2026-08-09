#!/usr/bin/env bash
set -euo pipefail
umask 022

if [[ $# -ne 2 || $2 != markiro-host-assets || ! $1 =~ ^/opt/markiro/releases/[0-9a-f]{40}$ ]]; then
  exit 1
fi

release_root=$1
install -d -m 0755 /usr/local/lib/markiro
install -d -m 0755 /etc/systemd/system/markiro-compose.service.d
install -d -m 0755 /etc/systemd/system/markiro-deploy.service.d
install -d -m 0755 /etc/tmpfiles.d

install -m 0700 "$release_root/deploy/yandex/runtime-env.mjs" /usr/local/lib/markiro/runtime-env.mjs
install -m 0700 "$release_root/deploy/yandex/registry-auth.mjs" /usr/local/lib/markiro/registry-auth.mjs
install -m 0644 "$release_root/deploy/yandex/cli-main.mjs" /usr/local/lib/markiro/cli-main.mjs
install -m 0644 "$release_root/.env.production.example" /usr/local/lib/markiro/.env.production.example
install -m 0644 "$release_root/deploy/yandex/systemd/markiro-runtime-env.service" /etc/systemd/system/markiro-runtime-env.service
install -m 0644 "$release_root/deploy/yandex/systemd/markiro-compose.service.d/runtime-env.conf" /etc/systemd/system/markiro-compose.service.d/runtime-env.conf
install -m 0644 "$release_root/deploy/yandex/systemd/markiro-deploy.service.d/runtime-env.conf" /etc/systemd/system/markiro-deploy.service.d/runtime-env.conf
install -m 0644 "$release_root/deploy/yandex/tmpfiles.d/markiro-registry-auth.conf" /etc/tmpfiles.d/markiro-registry-auth.conf

systemd-tmpfiles --create /etc/tmpfiles.d/markiro-registry-auth.conf
systemctl daemon-reload
systemctl enable markiro-runtime-env.service

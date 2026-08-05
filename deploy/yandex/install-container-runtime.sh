#!/usr/bin/env bash
set -euo pipefail
umask 022

DOCKER_VERSION=28.5.2
DOCKER_SHA256=ea90cfd12e1eeb12aa1c971741adb8bd4ed88e2a574eaac13f5029a1dbc6300d
COMPOSE_VERSION=2.40.3
COMPOSE_SHA256=dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372

test "$(uname -m)" = x86_64
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

docker_archive="$workdir/docker.tgz"
compose_binary="$workdir/docker-compose"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
  --output "$docker_archive"
printf '%s  %s\n' "$DOCKER_SHA256" "$docker_archive" | sha256sum --check --status
tar -xzf "$docker_archive" -C "$workdir" --no-same-owner
find "$workdir/docker" -maxdepth 1 -type f -exec install -m 0755 '{}' /usr/local/bin/ \;

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
  --output "$compose_binary"
printf '%s  %s\n' "$COMPOSE_SHA256" "$compose_binary" | sha256sum --check --status
install -d -m 0755 /usr/local/lib/docker/cli-plugins
install -m 0755 "$compose_binary" /usr/local/lib/docker/cli-plugins/docker-compose

test "$(docker --version | sed -E 's/^Docker version ([0-9.]+),.*/\1/')" = "$DOCKER_VERSION"
test "$(docker compose version --short)" = "$COMPOSE_VERSION"

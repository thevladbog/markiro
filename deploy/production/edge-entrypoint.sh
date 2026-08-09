#!/bin/sh
set -eu

test "${MARKIRO_EDGE_MODE:-direct}" = direct || {
  echo "edge configuration invalid" >&2
  exit 64
}
test -n "${ACME_EMAIL:-}" || {
  echo "edge configuration invalid" >&2
  exit 64
}

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

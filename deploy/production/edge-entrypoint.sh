#!/bin/sh
set -eu

case "${MARKIRO_EDGE_MODE:-direct}" in
  direct)
    test -n "${ACME_EMAIL:-}" || { echo "edge configuration invalid" >&2; exit 64; }
    config=/etc/caddy/Caddyfile.direct
    ;;
  behind-alb)
    config=/etc/caddy/Caddyfile.alb
    ;;
  *)
    echo "edge configuration invalid" >&2
    exit 64
    ;;
esac

exec caddy run --config "$config" --adapter caddyfile

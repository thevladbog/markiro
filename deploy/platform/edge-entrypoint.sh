#!/bin/sh
set -eu
# Caddy expands these values before parsing. A matching line is insufficient:
# reject every whitespace/control character before using anchored line regexes.
for value in "${MARKIRO_RELEASE_SHA:-}" "${MARKIRO_SAAS_ADMIN_DOMAIN:-}" "${MARKIRO_LANDING_DOMAIN:-}" "${MARKIRO_RETIRED_ADMIN_DOMAIN:-}" "${MARKIRO_RETIRED_KIOSK_DOMAIN:-}" "${S3_PUBLIC_ORIGIN:-}" "${ACME_EMAIL:-}"; do
  case "$value" in *[!a-zA-Z0-9._%+@:/-]*) echo 'platform edge configuration invalid' >&2; exit 64 ;; esac
done
invalid() { echo 'platform edge configuration invalid' >&2; exit 64; }
[ "${SERVER_PROFILE:-}" = platform-only ] || invalid
[ "${VITE_SERVER_PROFILE:-}" = platform-only ] || invalid
printf '%s\n' "${MARKIRO_RELEASE_SHA:-}" | grep -Eq '^[a-f0-9]{40}$' || invalid
for value in "${MARKIRO_SAAS_ADMIN_DOMAIN:-}" "${MARKIRO_LANDING_DOMAIN:-}" "${MARKIRO_RETIRED_ADMIN_DOMAIN:-}" "${MARKIRO_RETIRED_KIOSK_DOMAIN:-}"; do
  printf '%s\n' "$value" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$' || invalid
done
[ "$(printf '%s\n' "$MARKIRO_SAAS_ADMIN_DOMAIN" "$MARKIRO_LANDING_DOMAIN" "$MARKIRO_RETIRED_ADMIN_DOMAIN" "$MARKIRO_RETIRED_KIOSK_DOMAIN" | sort -u | wc -l | tr -d ' ')" = 4 ] || invalid
printf '%s\n' "${S3_PUBLIC_ORIGIN:-}" | grep -Eq '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*(:[0-9]{1,5})?$' || invalid
printf '%s\n' "${ACME_EMAIL:-}" | grep -Eq '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$' || invalid
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

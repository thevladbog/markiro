# DERIVED LOCAL RUNTIME EVIDENCE ONLY: host-built assets, exact runtime stage below
FROM caddy:2.11.4-alpine AS runtime
COPY deploy/platform/Caddyfile /etc/caddy/Caddyfile
COPY deploy/platform/edge-entrypoint.sh /usr/bin/edge-entrypoint
COPY --from=compactprecompiled /saas-dist /srv/saas-admin
COPY --from=compactprecompiled /landing-dist /srv/landing
RUN addgroup -S -g 10001 markiro \
 && adduser -S -D -H -u 10001 -G markiro markiro \
 && chmod 0555 /usr/bin/edge-entrypoint \
 && setcap -r /usr/bin/caddy \
 && chown -R 10001:10001 /srv /data /config
ENV SERVER_PROFILE=platform-only VITE_SERVER_PROFILE=platform-only
COPY deploy/platform/retired.html /srv/retired/index.html
EXPOSE 8080 8443
USER 10001:10001
ENTRYPOINT ["/usr/bin/edge-entrypoint"]

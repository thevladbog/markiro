FROM node:24.19.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY patches ./patches
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/kiosk/package.json ./apps/kiosk/package.json
COPY apps/landing/package.json ./apps/landing/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN pnpm install --frozen-lockfile
COPY apps/admin ./apps/admin
COPY apps/kiosk ./apps/kiosk
COPY apps/landing ./apps/landing
COPY packages/db ./packages/db
COPY packages/domain ./packages/domain
COPY packages/ui ./packages/ui
RUN pnpm turbo build --filter @markiro/admin... --filter @markiro/kiosk... --filter @markiro/landing...

FROM caddy:2.11.4-alpine AS runtime
COPY deploy/production/Caddyfile /etc/caddy/Caddyfile
COPY deploy/production/edge-entrypoint.sh /usr/bin/edge-entrypoint
COPY --from=build /workspace/apps/admin/dist /srv/admin
COPY --from=build /workspace/apps/kiosk/dist /srv/kiosk
COPY --from=build /workspace/apps/landing/dist /srv/landing
RUN addgroup -S -g 10001 markiro \
 && adduser -S -D -H -u 10001 -G markiro markiro \
 && chmod 0555 /usr/bin/edge-entrypoint \
 && setcap -r /usr/bin/caddy \
 && chown -R 10001:10001 /srv /data /config
EXPOSE 8080 8443
USER 10001:10001
ENTRYPOINT ["/usr/bin/edge-entrypoint"]

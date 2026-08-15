FROM node:24.19.0-bookworm-slim AS build-base
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY patches ./patches
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/kiosk/package.json ./apps/kiosk/package.json
COPY apps/landing/package.json ./apps/landing/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/legal-documents/package.json ./packages/legal-documents/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN pnpm install --frozen-lockfile
COPY apps/admin ./apps/admin
COPY apps/kiosk ./apps/kiosk
COPY apps/landing ./apps/landing
COPY packages/db ./packages/db
COPY packages/domain ./packages/domain
COPY packages/legal-documents ./packages/legal-documents
COPY packages/ui ./packages/ui
COPY deploy/production/cli-main.mjs ./deploy/production/cli-main.mjs
COPY deploy/production/verify-legal-artifacts.mjs ./deploy/production/verify-legal-artifacts.mjs
COPY deploy/production/legal-artifacts-attestation.json ./deploy/production/legal-artifacts-attestation.json

FROM build-base AS application-build
RUN pnpm turbo build --filter @markiro/admin... --filter @markiro/kiosk...

FROM build-base AS landing-build
ARG PUBLIC_DEMO_SUBMISSION_ENABLED=false
ARG PUBLIC_SMARTCAPTCHA_CLIENT_KEY=
ARG PUBLIC_PHONE=
ENV PUBLIC_DEMO_SUBMISSION_ENABLED=${PUBLIC_DEMO_SUBMISSION_ENABLED}
ENV PUBLIC_SMARTCAPTCHA_CLIENT_KEY=${PUBLIC_SMARTCAPTCHA_CLIENT_KEY}
ENV PUBLIC_PHONE=${PUBLIC_PHONE}
RUN pnpm --filter @markiro/domain build
RUN pnpm --filter @markiro/ui build
RUN pnpm --filter @markiro/legal-documents build
RUN node deploy/production/verify-legal-artifacts.mjs apps/landing/public/legal deploy/production/legal-artifacts-attestation.json
RUN pnpm --filter @markiro/landing build

FROM caddy:2.11.4-alpine AS runtime
COPY deploy/production/Caddyfile /etc/caddy/Caddyfile
COPY deploy/production/edge-entrypoint.sh /usr/bin/edge-entrypoint
COPY --from=application-build /workspace/apps/admin/dist /srv/admin
COPY --from=application-build /workspace/apps/kiosk/dist /srv/kiosk
COPY --from=landing-build /workspace/apps/landing/dist /srv/landing
RUN addgroup -S -g 10001 markiro \
 && adduser -S -D -H -u 10001 -G markiro markiro \
 && chmod 0555 /usr/bin/edge-entrypoint \
 && setcap -r /usr/bin/caddy \
 && chown -R 10001:10001 /srv /data /config
EXPOSE 8080 8443
USER 10001:10001
ENTRYPOINT ["/usr/bin/edge-entrypoint"]

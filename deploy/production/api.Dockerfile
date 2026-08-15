FROM node:24.19.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY patches ./patches
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/email/package.json ./packages/email/package.json
COPY packages/legal-documents/package.json ./packages/legal-documents/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api ./apps/api
COPY packages/db ./packages/db
COPY packages/domain ./packages/domain
COPY packages/email ./packages/email
COPY packages/legal-documents ./packages/legal-documents
RUN pnpm --filter @markiro/domain build
RUN pnpm --filter @markiro/db build
RUN pnpm --filter @markiro/email build
RUN pnpm --filter @markiro/legal-documents build
RUN pnpm --filter @markiro/api build
RUN pnpm --config.allow-unused-patches=true --filter @markiro/api deploy --legacy --prod /out/api
RUN find /out/api -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' \) \
 ! -name '*.d.ts' ! -name '*.d.tsx' ! -name '*.d.mts' ! -name '*.d.cts' -delete \
 && rm -rf /out/api/src /out/api/test /out/api/tests /out/api/scripts /out/api/.turbo \
 && find /out/api -type d \( -name test -o -name tests -o -name scripts -o -name .turbo \) -prune -exec rm -rf {} + \
 && find /out/api -type f \( -name nest-cli.json -o -name 'tsconfig*.json' \) -delete \
 && find /out/api/dist -type f \( -name '*.d.ts' -o -name '*.d.tsx' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete \
 && find -L /out/api/node_modules/@markiro -type f \( -name '*.d.ts' -o -name '*.d.tsx' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete \
 && rm -f /out/api/turbo.json \
 && find /out/api -type d -empty -delete

FROM node:24.19.0-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install --no-install-recommends -y tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out/api /app
COPY --from=build --chown=node:node /workspace/packages/db/migrations /app/node_modules/@markiro/db/migrations
COPY --chown=node:node deploy/production/healthcheck.mjs /opt/markiro/healthcheck.mjs
COPY --chown=root:root deploy/production/yandex-cloud-ca.pem /etc/ssl/certs/yandex-cloud-ca.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/yandex-cloud-ca.pem
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

FROM node:24.19.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY patches ./patches
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/email/package.json ./packages/email/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api ./apps/api
COPY packages/db ./packages/db
COPY packages/domain ./packages/domain
COPY packages/email ./packages/email
RUN pnpm turbo build --filter @markiro/api...
RUN pnpm --filter @markiro/api deploy --legacy --prod /out/api

FROM node:24.19.0-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install --no-install-recommends -y tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out/api /app
COPY --from=build --chown=node:node /workspace/packages/db/migrations /app/node_modules/@markiro/db/migrations
COPY --chown=node:node deploy/production/healthcheck.mjs /opt/markiro/healthcheck.mjs
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

# Markiro

SaaS product for SSCC label generation, scan tracking, and offline-first line station management in Russian manufacturing.

## Quick start

### Prerequisites

- Node 24 (LTS)
- pnpm 11
- Docker & Docker Compose

### Setup

```bash
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro pnpm --filter @markiro/db db:migrate
export $(grep -v '^#' .env | xargs)
pnpm --filter @markiro/api dev
```

Note: Drizzle Kit reads `DATABASE_URL` from its own working directory (hence the inline variable for migrate); the API dev server also requires these exports to connect to the database at startup.

### Admin app

```bash
pnpm --filter @markiro/admin dev
```

Serves the admin panel at `http://localhost:5173`. Its Vite dev server proxies
`/api/*` to the API on `http://localhost:3000` (see
`apps/admin/vite.config.ts`). For sign-up/sign-in and any authenticated
request to succeed, the API must be running with `ADMIN_ORIGIN=http://localhost:5173`
(already the default in `.env.example`) so CORS and Better Auth's
`trustedOrigins` accept the admin's origin.

## Verification

```bash
pnpm turbo lint typecheck test build
```

Note: Database tests require `DATABASE_URL` environment variable; they skip if unset.

## Repo structure

```text
apps/
  api/            NestJS backend + Better Auth + Scalar OpenAPI docs
  admin/          React + Vite admin panel (org profile, counterparties, catalog, shifts)
packages/
  domain/         GS1 validation, SSCC, ZPL/TSPL, Cyrillic rasterization
  db/             Drizzle schemas (Postgres + SQLite mirror)
docs/
  architecture.md Design decisions, stack rationale, data/auth/retention
```

Station, landing, and the platform-admin app arrive in later plans — see [docs/superpowers/plans/](./docs/superpowers/plans/).

## Endpoints

- `GET /health` — Health check
- `GET /docs` — Scalar OpenAPI explorer (full API reference)
- `GET /openapi.json` — OpenAPI schema
- `ALL /api/auth/*` — Better Auth endpoints (session, sign-up, sign-in)
- `http://localhost:5173` — Admin app (dev server, see [Admin app](#admin-app) above)

## Docs

- **Architecture:** [docs/architecture.md](./docs/architecture.md)
- **Roadmap:** [docs/superpowers/plans/](./docs/superpowers/plans/)

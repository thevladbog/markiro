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

## Verification

```bash
pnpm turbo lint typecheck test build
```

Note: Database tests require `DATABASE_URL` environment variable; they skip if unset.

## Repo structure

```text
apps/
  api/            NestJS backend + Better Auth + Scalar OpenAPI docs
packages/
  domain/         GS1 validation, SSCC, ZPL/TSPL, Cyrillic rasterization
  db/             Drizzle schemas (Postgres + SQLite mirror)
docs/
  architecture.md Design decisions, stack rationale, data/auth/retention
```

Admin, station, landing, and the UI kit arrive in later plans — see [docs/superpowers/plans/](./docs/superpowers/plans/).

## Endpoints

- `GET /health` — Health check
- `GET /docs` — Scalar OpenAPI explorer
- `GET /openapi.json` — OpenAPI schema
- `ALL /api/auth/*` — Better Auth endpoints (session, sign-up, sign-in)

## Docs

- **Architecture:** [docs/architecture.md](./docs/architecture.md)
- **Roadmap:** [docs/superpowers/plans/](./docs/superpowers/plans/)

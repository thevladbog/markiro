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
pnpm --filter @markiro/db db:migrate
pnpm turbo dev
```

Dev server runs on `localhost:3000` (api only for now; station and admin apps build but don't auto-run).

## Verification

```bash
pnpm turbo lint typecheck test build
```

Note: Database tests require `DATABASE_URL` environment variable; they skip if unset.

## Repo structure

```
apps/
  api/       NestJS backend + Better Auth + Scalar OpenAPI docs
  admin/     React admin panel (office mode)
  station/   Tauri app (line station, Windows MVP)
  landing/   Astro marketing site
packages/
  domain/    GS1 validation, SSCC, ZPL/TSPL, Cyrillic rasterization
  ui/        Design system (tokens + components)
  db/        Drizzle schemas (Postgres + SQLite mirror)
docs/
  architecture.md  Design decisions, stack rationale, data/auth/retention
  superpowers/plans/  Roadmap (Plans 01–02 delivered)
```

## Docs

- **Architecture:** [docs/architecture.md](./docs/architecture.md)
- **Roadmap:** [docs/superpowers/plans/](./docs/superpowers/plans/)
- **API docs:** `http://localhost:3000/docs` (Scalar OpenAPI, after `pnpm turbo dev`)

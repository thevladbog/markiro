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

The local stack also starts Mailpit (SMTP `localhost:1025`, UI
`http://localhost:8025`) and a private MinIO bucket (S3 `localhost:9000`,
console `http://localhost:9001`). Credentials and API defaults are documented
in `.env.example` and are development-only.

To create the first tenant owner without putting a password in a shell or log,
build the API and run:

```bash
pnpm --silent --filter @markiro/api provision:tenant-owner -- \
  --email owner@example.com \
  --tenant-name "Первый завод" \
  --tenant-slug first-factory
```

The command is idempotent for the same tenant/email and prints only tenant,
user, membership, and delivery IDs. The one-time link verifies possession of
the address. A new global account chooses its first password; an existing
multi-tenant account keeps its current password and only confirms the new
owner access.

If an unused activation expires, repeat the same command with
`--renew-activation`. This explicit recovery switch cancels and scrubs an
unsent delivery, invalidates the old token, and queues one replacement. It is
refused after the address has already been verified; use normal password
recovery in that case.

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
  admin/          React + Vite admin panel (org profile, counterparties, catalog, shifts, label templates)
  kiosk/          React + Vite self-service pickup kiosk, offline-first installable PWA (device-token pairing, cached bootstrap snapshot in IndexedDB, local badge resolution, queued orders)
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

## Label templates

WYSIWYG label editor in the admin app (`/labels` for the library, `/labels/new`
and `/labels/:id` for the editor). All rasterization and ZPL/TSPL generation
happens **client-side**, in the browser — the API only stores and
zod-validates the template's JSON spec (`@markiro/domain`'s `LabelTemplateSpec`)
and never renders or rasterizes anything itself.

- **Editor:** drag-and-drop canvas for text, data fields (product name/GTIN,
  KM code, SSCC, shift no., date, qty, operator, counterparty), barcode
  placeholders (DataMatrix/Code128/EAN-13/QR — schematic in the editor;
  the real barcode symbology is emitted by the printer via ZPL/TSPL commands),
  lines and boxes, plus a properties panel and a live "предпросмотр = печать"
  preview pane. The preview rasterizes any non-Latin-1 text through the same
  canvas-based rasterizer used for the final document, so Cyrillic renders
  exactly as it will print, and warns when the selected font lacks Cyrillic
  glyph coverage.
- **Download:** the editor's "Скачать ZPL/TSPL" button generates a full
  document with sample data and downloads it as a `.zpl`/`.tspl` file, using
  the same `packages/domain` generators (`generateZpl`/`generateTspl`) the
  station will use to print in Plan 05.
- **Binding:** products can have a default label template
  (`defaultLabelTemplateId`); shifts can override it per shift
  (`labelTemplateId`), falling back to the product's default when left unset.

## Docs

- **Architecture:** [docs/architecture.md](./docs/architecture.md)
- **Roadmap:** [docs/superpowers/plans/](./docs/superpowers/plans/)

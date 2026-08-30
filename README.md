<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/readme/logo-en-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./docs/assets/readme/logo-en.svg">
    <img alt="Markiro" src="./docs/assets/readme/logo-en.svg" width="280" height="64">
  </picture>
</p>

<p align="center"><strong>English</strong> · <a href="./README.ru.md">Русский</a></p>

<p align="center">
  Offline-first production workflows for Chestny ZNAK: serialization, aggregation, traceability, and shop-floor operations.
</p>

<p align="center">
  <a href="https://github.com/thevladbog/markiro/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/thevladbog/markiro/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/thevladbog/markiro/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/thevladbog/markiro/actions/workflows/codeql.yml/badge.svg"></a>
  <img alt="Node.js 24+" src="https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white">
  <img alt="pnpm 11.22" src="https://img.shields.io/badge/pnpm-11.22-F69220?logo=pnpm&logoColor=white">
  <img alt="TypeScript 6" src="https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white">
  <img alt="PostgreSQL 17" src="https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white">
  <a href="./LICENSE"><img alt="Proprietary license" src="https://img.shields.io/badge/License-Proprietary-17161A"></a>
</p>

![Markiro line station screenshot](./docs/assets/readme/station.webp)

<p align="center"><em>Aggregation mode on the offline-capable line station — rendered by the app's built-in screen gallery with fixture data.</em></p>

## What is Markiro?

Markiro is an industrial platform for Russian Chestny ZNAK production workflows. It connects office administration, line-side scanning, aggregation and label printing, employee pickup, traceability, and external integrations without making continuous connectivity a condition for safe factory work.

The platform is built for real production constraints: multiple terminals in one shift, device-local journals, duplicate and foreign-GTIN rejection, degraded hardware states, auditable recovery actions, and eventual synchronization with the server.

## Why it exists

- **Keep the line moving.** Station and kiosk workflows retain local state and recover after connectivity returns.
- **Reject bad input at the edge.** Shared GS1/GTIN/KM logic catches malformed, duplicate, and wrong-product codes before they become reporting problems.
- **Aggregate and print consistently.** SSCC allocation, box workflows, and ZPL/TSPL output use shared domain rules.
- **Close the inventory loop.** Inventory tasks, station recount and repack, and generated GISMT documents replace manual file exchange with the state system.
- **Keep every boundary explicit.** Tenant data, cabinet sessions, device credentials, and operator identity have separate enforcement paths.
- **Integrate with existing operations.** The API, CommerceML/1C exchange, and the Chestny ZNAK True API agent connect Markiro to surrounding systems without moving factory recovery online-only.

## Product surfaces

<table>
  <tr>
    <td width="50%"><a href="./docs/assets/readme/admin.webp"><img alt="Markiro admin panel screenshot" src="./docs/assets/readme/admin.webp"></a></td>
    <td width="50%"><a href="./docs/assets/readme/kiosk.webp"><img alt="Markiro pickup kiosk screenshot" src="./docs/assets/readme/kiosk.webp"></a></td>
  </tr>
  <tr>
    <td><strong>Admin panel.</strong> Dashboard, products, shifts, inventories, label templates, integrations, billing, teams, and operational audit.</td>
    <td><strong>Disposal kiosk.</strong> Badge-based employee pickup with local limits, offline snapshots, queued orders, and recovery.</td>
  </tr>
</table>

<p align="center"><em>The admin panel runs against a seeded local API; the kiosk screen is rendered from the app's own components with fixture data.</em></p>

## Core capabilities

| Area                  | What is implemented                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Codes and validation  | GS1 check digits, GTIN normalization, KM parsing, scan classification, duplicate/error handling                     |
| Production            | Shifts, multi-terminal scanning, offline journals, synchronization, conflicts, operator recovery actions, dashboard |
| Aggregation           | SSCC pools, boxes, box labels, disassembly/reprint audit, shared aggregation state                                  |
| Inventory             | Inventory tasks, station recount and repack, corrections and late events, GISMT aggregation XML and report package  |
| Labels                | WYSIWYG templates, Cyrillic rasterization, ZPL/TSPL generation, product/shift bindings                              |
| Disposal              | Paired kiosks, badge resolution, daily limits, offline queue/quarantine, cabinet reconciliation                     |
| Chestny ZNAK          | Signer agent for the True API authentication flow, encrypted token storage, product groups, code-status exports     |
| SaaS and integrations | Multi-tenant cabinet, roles/capabilities, billing and limits, CommerceML/1C exchange, mail, private object storage  |

## Architecture

```mermaid
flowchart LR
  Admin["Admin · React/Vite"] --> API["NestJS API"]
  Kiosk["Kiosk · React/Vite PWA"] --> API
  Station["Station · Tauri 2 + React"] -. "sync when connected" .-> API
  Station --> SQLite["Local SQLite journal"]
  Signer["Signer · Tauri 2 + React"] -- "True API token" --> API
  API -. "True API" .-> CHZ["Chestny ZNAK"]
  API --> PG["PostgreSQL 17"]
  Shared["domain · db · ui · email · platform-contracts"] --> Admin
  Shared --> Kiosk
  Shared --> Station
  Shared --> Signer
  Shared --> API
```

Read [the architecture document](./docs/architecture.md) for tenant boundaries, authentication, retention, offline synchronization, deployment, and operational trade-offs.

## Quick start

### Prerequisites

- Node.js 24 or newer
- Corepack and pnpm 11.22.0
- Docker with Docker Compose

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter '@markiro/api^...' --filter '@markiro/admin^...' build
if [ ! -e .env ]; then
  cp .env.example .env
fi
docker compose -f docker-compose.dev.yml up -d
set -a
source .env
set +a
pnpm --filter @markiro/db db:migrate
pnpm --filter @markiro/api dev
```

Run the admin app in another terminal:

```bash
pnpm --filter @markiro/admin dev
```

The admin UI is available at `http://localhost:5173`; the API and Scalar OpenAPI explorer use `http://localhost:3000` and `http://localhost:3000/docs`. The development stack also exposes Mailpit at `http://localhost:8025` and MinIO Console at `http://localhost:9001`. Values in `.env.example` are development-only.

<details>
<summary>Provision the first tenant owner</summary>

Build the API, then create an activation without putting a password in shell history:

```bash
pnpm --filter @markiro/api build
pnpm --silent --filter @markiro/api provision:tenant-owner -- \
  --email owner@example.com \
  --tenant-name "First factory" \
  --tenant-slug first-factory
```

The command is idempotent for the same tenant/email and prints identifiers only. Use `--renew-activation` only for an unused expired activation.
</details>

## Development

```text
apps/
  api/         NestJS API, auth, jobs, integrations
  admin/       React/Vite production cabinet
  kiosk/       Offline-first pickup PWA
  station/     Tauri/React line workstation
  signer/      Tauri/React Chestny ZNAK signing agent (Windows)
  landing/     Public marketing website
  saas-admin/  SaaS operator panel
packages/
  domain/              GS1, KM, SSCC, labels, shared policy
  db/                  PostgreSQL schema, migrations, SQLite mirror
  platform-contracts/  Shared platform, tenant, and agent API schemas
  email/               Transactional email templates
  ui/                  Shared design tokens and React components
  legal-documents/     Legal document sources and rendering
```

Focused iteration:

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/api exec vitest run test/relevant-file.test.ts
```

Full validation:

```bash
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm format:check
```

Database-backed tests require the exported `DATABASE_URL`. Report intentional skips and external/browser/hardware verification separately.

## Documentation

- [Agent guide](./AGENTS.md)
- [Architecture](./docs/architecture.md)
- [Design briefs](./docs/design-briefs/)
- [Operational runbooks](./docs/runbooks/)
- [Implementation plans](./docs/superpowers/plans/)
- [MVP roadmap](./docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md)
- [OpenAPI explorer](http://localhost:3000/docs) when the API is running

## Contributing, security, and support

- External contributions are not accepted; see [CONTRIBUTING.md](./CONTRIBUTING.md).
- Report vulnerabilities privately; see [SECURITY.md](./SECURITY.md).
- Questions, bug reports, and commercial licensing; see [SUPPORT.md](./SUPPORT.md).

## License

Copyright © 2026 Vladislav Bogatyrev. This repository is proprietary and all rights are reserved. See [LICENSE](./LICENSE).

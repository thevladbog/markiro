# Markiro — Architecture

> Approved decisions from the architecture discussion (2026-07-21).
> Product scope and UX: see `docs/design-briefs/00–05` and the accepted
> design handoff in `docs/design-briefs/design_handoff_markiro/`.

## 1. Monorepo & stack

pnpm workspaces + **Turborepo** (Nx rejected: overkill at this size; its
`latest` dist-tag was anomalous at decision time — supply-chain caution).

```
apps/
  api/        NestJS 11 + Drizzle + Postgres — SaaS backend, public API
  admin/      React 19 + Vite 8 — admin panel (office mode)
  station/    Tauri 2 + React 19 — line station (floor mode), Windows MVP
  landing/    Astro 7 — marketing site
packages/
  domain/     GS1 validation, SSCC, ZPL/TSPL generation, Cyrillic
              rasterization, export formats — shared by api/admin/station
  ui/         Markiro design system (tokens, office+floor components)
  db/         Drizzle schemas: Postgres (server) + SQLite (station mirror)
```

One domain package, three consumers — station validates offline, api builds
exports, admin previews labels, all from the same tested code.

### Pinned toolchain (registry-checked 2026-07-21, exact versions in lockfile)

| Package                   | Version          |
| ------------------------- | ---------------- |
| Node                      | 24 LTS (engines) |
| pnpm                      | 11.10            |
| turbo                     | 2.10             |
| TypeScript                | 6.0              |
| NestJS                    | 11.1             |
| drizzle-orm / drizzle-kit | 0.45 / 0.31      |
| better-auth               | 1.6              |
| React                     | 19.2             |
| Vite                      | 8.1              |
| Tauri (cli/api)           | 2.11             |
| pg-boss                   | 12               |
| Astro                     | 7.0              |
| Zod                       | 4.4              |

Root `.npmrc` (single, applies to the whole workspace): standard npm
registry, `save-exact`, `engine-strict`, `minimum-release-age=10080`
(7-day quarantine for freshly published versions — supply-chain guard).

## 2. Line station (Tauri all-in-one)

- **Hardware in Rust core:** COM/USB scanner (serial), raw ZPL/TSPL printing
  to system/serial/network printers. The internal hardware module mirrors the
  idento-agent HTTP contract (`/scan/consume`, `/print`, discovery) so it can
  be extracted into a standalone agent later without touching the UI.
- **Local DB:** SQLite via `tauri-plugin-sql`, accessed with
  `drizzle-orm/sqlite-proxy`; schema defined in `packages/db`, mirrors the
  server's shift entities (shift, codes, scan journal, boxes, pallets).
- **Updates:** Tauri updater. **All assets bundled** — fonts (IBM Plex,
  OFL), icons, sounds; zero CDN (the shop floor is offline).
- Windows targets for MVP; Linux later; Android deferred (serial is painful).
- Station cleanup: a shift is purged N days after confirmed sync.
- Foundation delivered in Plan 05a (`docs/superpowers/plans/2026-07-23-05a-station-foundation.md`):
  Tauri scaffold, Rust config/lockdown/updater skeletons, SQLite mirror, device
  enrollment (api-key), shift bundle download, and offline operator auth.
  The scan pipeline, hardware module, and signal behavior land in 05b.

## 3. Offline & sync

- Shift downloads to the station in full: product, label template,
  capacities, counterparty GLN, **pre-allocated SSCC serial ranges per
  terminal** — boxes/pallets print offline with no collisions.
- Scans append to a local journal; background sync pushes idempotent batches
  (terminal-sequenced). Online cross-terminal duplicates are caught by the
  server instantly; offline ones — at sync, surfaced as conflicts for the
  manager (design screen 8), the line never stops.
- Operator sign-in works offline: PIN hashes / badge tokens sync to the
  station at enrollment.

## 4. Data & retention (hot / warm / cold)

- Postgres (Yandex Managed), multi-tenant via `tenant_id` on every row.
- `codes` and the scan-event journal are **month-partitioned from day one**
  (native RANGE partitions managed by the API's `ensure-partitions` job —
  portable across docker dev and managed PG; pg_partman intentionally not required);
  PK `(tenant_id, code_hash, scanned_at)` (partition key must be part of the PK);
  BRIN time indexes planned in the hardening pass (plan 09).
- Scale estimate: ~12–18M codes/year per line → hundreds of millions of rows
  across tenants within a few years.
- **Warm:** partitions older than the active months serve only exact-code
  lookups and reports.
- **Cold (18+ months):** background job exports a partition to **Parquet
  per tenant/month in Object Storage** (10–20× compression), drops the
  partition, keeps in Postgres: `code_hash → archive ref` lookup + immutable
  shift aggregates (dashboards never touch archives).
- Code-history screen: hot first, then archive fetch with an honest
  "loading from archive" state.
- Retention: **5 years** default, configurable per tenant; full takeout
  before deletion.

## 5. Backend services

- **Jobs:** pg-boss (queue in Postgres — exports, archiving, notifications).
  No Redis: one less service in SaaS and in the future on-prem compose.
  Migration path to BullMQ is localized if ever needed.
- **Live dashboard:** SSE (unidirectional fits; simpler than WS).
- **Public API from MVP:** REST + OpenAPI (Nest Swagger), API keys with
  read/write scopes.
- **Exports:** format adapters (GIS MT files, 1C); the future direct
  Chestny ZNAK API (SUZ/GIS MT + UKEP signing) plugs in as another adapter.

## 6. AuthN/AuthZ

- **Admin panel & public API: Better Auth 1.6** with Drizzle adapter.
  Plugins: `organization` (tenancy: orgs, invites, admin/manager roles),
  `api-key` (public API), email+password with Argon2, httpOnly sessions;
  2FA available later.
- **Station: custom** (offline-first, outside Better Auth): device enrolled
  with an org token; operators authenticate locally by numeric PIN or badge
  barcode against synced hashes.

## 7. Tolling (contract manufacturing)

- `counterparties` per tenant: name, GLN, INN, GS1 prefixes.
- Product has optional default counterparty; shift can override. Tolling
  shift ⇒ SSCC from the counterparty's GLN; exports filterable per
  counterparty (files go to the customer's GIS MT account).
- GTIN owner auto-detection in the catalog: foreign GS1 prefix → suggest
  matching counterparty.

## 8. Deployment

- MVP: one Yandex Cloud VM + Docker Compose (api, admin, landing behind
  Caddy) + Managed Postgres + Object Storage. RF residency (152-ФЗ).
- CI: GitHub Actions — lint/test/build, DB migrations, Docker images,
  Tauri Windows installer build + signing, release channels for the updater.
- Future on-prem = the same compose bundle.

## Open items (tracked for later phases)

- Direct Chestny ZNAK integration (SUZ code ordering, report submission,
  UKEP).
- Billing/tariffs; customer portal for tolling counterparties.
- Linux/Android stations; optional standalone hardware agent (web mode).
- Optional code-pool tracking is in scope for MVP dashboards (KPI «остатки
  кодов») when clients pre-load ordered code files.

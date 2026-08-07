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
  kiosk/      React 19 + Vite 8 + IndexedDB — offline-first self-service
              pickup kiosk (installable PWA), paired to the api by device token
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
- A station is pre-created in the cabinet and pairs by a short-lived one-time
  code. Re-pair rotates its credential on the same durable device record; the
  paired line is the default floor filter, not an authorization boundary.

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
- Credential rejection seals the current generation before recovery. Local
  outbox, journal, boxes, exceptions, conflicts, SSCC ranges, stable
  machine/device IDs, idempotency keys and sync ceilings remain intact.
  Cleanup is limited to the rejected credential and reproducible
  operator/shift/product caches; same-device re-pair reseeds those caches and
  resumes the unchanged queue.

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
- **1C exchange:** another format adapter, inbound this time — CommerceML
  over the "Обмен с сайтом" protocol at `/1c_exchange`, live in the
  Integrations section of the cabinet (`docs/design-briefs/08-integrations.md`,
  `docs/superpowers/specs/2026-07-29-commerceml-design.md`).

## 6. AuthN/AuthZ

- **Admin panel & public API: Better Auth 1.6** with Drizzle adapter.
  Plugins: `organization` (tenancy: orgs, invites, admin/manager roles),
  `api-key` (public API), email+password with Argon2, httpOnly sessions;
  2FA available later.
- **Station device: Better Auth API key.** A pre-created durable station
  redeems a single-use pairing code for an organization-owned key from Better
  Auth's dedicated `station` API-key configuration. Operators authenticate
  locally by numeric PIN or badge barcode against synced hashes.
- **Kiosk device: separate token.** Kiosk pairing generates its own random
  device token and stores only that token's hash; it is not a Better Auth API
  key. Station and kiosk share pairing-code generation, expiry,
  single-consumption, attempt-lockout, and source/global rate-limit policy —
  not credential generation. Their credentials retain separate headers,
  guards, persistence, and device tables.

### Cabinet authorization

Better Auth organization membership identifies a **cabinet user**; it is
separate from the production operator identity used for station badge/PIN
flows. On every cabinet request the API reloads the user's membership for the
active organization, so removal and role changes take effect without waiting
for a session refresh. A centralized resolver converts recognized membership
roles into capabilities and fails closed for `member` and unknown roles.

Controllers declare one explicit policy: `RequirePermissions` for
cabinet-only capability checks, `AllowStationOrPermissions` for the product
and shift routes shared with a station, or `RequireMembership` for the
membership-only `/access/me` bootstrap. Station-only roster and scan routes
use `StationOnlyGuard`. The admin loads `/access/me` and uses the returned
capabilities for navigation, route, and control visibility; those UI checks
are usability controls and never replace the server policy. Better Auth's
organization mutation surface remains owner-only, and its generic HTTP API-key
management endpoints are blocked.

See the approved
[capability-based cabinet RBAC design](superpowers/specs/2026-08-03-capability-rbac-design.md)
and the [cabinet RBAC rollout runbook](runbooks/cabinet-rbac-rollout.md).

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
- `KIOSK_ORIGIN` must be set whenever the pickup kiosk PWA is served from a
  different origin than the API — which is the normal on-prem case, since the
  kiosk's pairing screen takes a server address. It is optional (an
  admin-only deployment leaves it unset and trusts no kiosk origin). It is
  trusted **only on the `/kiosk/*` routes** (`corsDelegate` in
  `apps/api/src/cors.ts`): the kiosk calls nothing else, and a global
  credentialed allowlist would let anything running on that origin read every
  session-guarded response using an administrator's cookies — a real exposure
  when kiosk and admin are sibling subdomains of one site. For the same
  reason it is **not** in Better Auth's `trustedOrigins`, which is fed the
  non-kiosk list (`sessionAllowedOrigins`, `apps/api/src/env.ts`); the kiosk
  authenticates with a device token and never calls `/api/auth/*`. The value
  is canonicalized to a bare `scheme://host[:port]` on load, so a configured
  trailing slash or path cannot silently match nothing.
- Leaving it unset in a split-origin install fails only in the browser, and
  every kiosk call is affected because every one of them is preflighted —
  for two different reasons. `GET /kiosk/bootstrap` and `POST /kiosk/orders`
  send an `x-kiosk-token` header, which is not a CORS-safelisted request
  header. `POST /kiosk/pair` carries no token at all — a device has no
  credential until it succeeds, so it is the one route outside
  `KioskDeviceGuard` — but its `Content-Type: application/json` is not a
  safelisted value, so it is preflighted too, and pairing itself fails
  without this variable. Dev never sees any of it —
  `apps/kiosk/vite.config.ts` proxies `/api` same-origin.
- Station webviews use a separate exact `STATION_ORIGIN`, trusted only for
  `/station` and `/station/*`; it is never a Better Auth trusted origin and
  never broadens kiosk or cabinet routes. Fresh station pairing uses the
  canonical HTTP(S) API base embedded as `VITE_STATION_API_URL`, not the
  webview's own origin. A paired station retains its server URL in durable
  config for same-device recovery.
- CI: GitHub Actions — lint/test/build, DB migrations, Docker images,
  Tauri Windows installer build + signing, release channels for the updater.
- Future on-prem = the same compose bundle.
- The API needs `TRUST_PROXY_HOPS=1` behind Caddy (it defaults to 0, i.e.
  untrusted, for direct exposure and for dev/tests) — otherwise Express's
  `req.ip` resolves to Caddy's own address for every request. IP-keyed rate
  limiting belongs in Caddy itself as the primary layer (it sees the real
  client address unconditionally and can shed load before it reaches the
  app); the API's own DB-backed limiter for station and kiosk pairing is a
  backstop for when that layer is missing or misconfigured, not a replacement
  for it.
- **Deployment checklist item:** the API container must run with both
  `NODE_ENV=production` **and** `TRUST_PROXY_HOPS` set to the number of
  reverse proxies that append to `X-Forwarded-For` (`1` behind the single
  Caddy hop above). Both matter together: `main.ts`'s only safety net for
  this misconfiguration — a startup `Logger.warn` — fires only when
  `NODE_ENV=production`, so leaving `NODE_ENV` unset makes that warning
  silent in exactly the deployment it exists to protect. Get either
  variable wrong and every caller's `req.ip` collapses to the same
  socket-peer/proxy address, so the kiosk-pairing limiter's per-source
  budget covers all callers combined instead of one each — one blocked
  source then keeps charging the shared bucket on every subsequent
  request, taking down kiosk pairing for every tenant for the rest of the
  window.

### Yandex SaaS production status

The repository now contains a Yandex SaaS implementation: reviewed Terraform
roots, protected GitHub plan/apply and deployment workflows, a private ALB
path, managed PostgreSQL, private versioned state/media/audit storage, Lockbox
boundaries, and operator runbooks. This is repository implementation, not a
live deployment. No real cloud IDs, domain, secret payloads, SMTP delivery,
alert delivery, restore evidence, or DNS convergence evidence is committed.

The one-customer MVP has one private 2 vCPU / 4 GiB application VM and one
private Managed PostgreSQL `s3-c2-m8` host. The public ALB remains attached to
SWS and global/per-IP ARL; WAF is deferred only for this one-customer phase. A
host failure or deployment can interrupt service; the design does not claim
high availability or zero downtime. The deferred HA path adds an application target
and a multi-host PostgreSQL topology after load and recovery evidence justify
it. GHCR keeps digest-addressed API and edge releases under its approved
retention policy. The shared media bucket remains private and separates avatar
and future product-image keys by prefix; the application controls access.

Runbooks require the exact protected GitHub environments `production`,
`production-infrastructure`, `production-public-dns`, and
`production-postgres-owner`. Public DNS stays false until the separately
approved first go-live procedure passes. The database-only owner environment
attests the completed cluster apply, exact owner creation, and runtime Lockbox
write before the saved database plan can proceed. The
production controller uses serial-console host-key evidence and OS Login for
the private app host; it does not trust a static SSH key.

## Open items (tracked for later phases)

- Direct Chestny ZNAK integration (SUZ code ordering, report submission,
  UKEP).
- Billing/tariffs; customer portal for tolling counterparties.
- Linux/Android stations; optional standalone hardware agent (web mode).
- Optional code-pool tracking is in scope for MVP dashboards (KPI «остатки
  кодов») when clients pre-load ordered code files.

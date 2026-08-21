# Markiro: working map

Status: curated repository orientation derived from the local Graphify snapshot.

Snapshot: 2026-08-21. This is an orientation aid built from the repository graph,
not a replacement for the nearest `AGENTS.md`, current source, tests, migrations,
or runtime configuration.

## Evidence boundary

- Corpus: 1,921 files, approximately 2.66 million detected words.
- Graph: 12,428 nodes, 26,542 edges, 828 communities.
- Semantic extraction: 339 documents, PDFs, and images; all 55 fragments passed
  the Graphify JSON-schema check.
- Known graph defects: 5,629 dangling-endpoint edges, 679 undirected endpoint
  collapses, 2,973 weakly connected nodes, and partial parsing of 31 source files
  (mostly Astro).
- `.npmrc`, `deploy/production/yandex-cloud-ca.pem`, and
  `packages/ui/src/tokens.css` were excluded as sensitive.
- Cross-application paths involving generic labels such as `Header`, `tag`,
  `run`, or `binding` need source verification before being treated as real
  architecture.

## System at a glance

```text
Public web          Platform office       Tenant office
apps/landing        apps/saas-admin        apps/admin
      |                    |                    |
      +--------------------+--------------------+
                           |
                    apps/api (authority)
                           |
          +----------------+----------------+
          |                |                |
      PostgreSQL       object/media      pg-boss jobs
          |             storage          mail/exports
          |
   device contracts and sync endpoints
          |                                 |
  apps/kiosk (paired PWA)          apps/station (Tauri)
  IndexedDB queue/cache            SQLite mirror/journal/outbox
  scanner + pickup flow            scanner + printer + floor work
```

The API is the server authority. Admin surfaces are online clients. Kiosk and
station are device identities with local durable state and recovery semantics;
they must not be reduced to ordinary cabinet sessions.

## Product surfaces

| Area              | Responsibility                                                                                                            | Main graph hubs                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/api`        | Tenant-scoped server authority, authorization, subscriptions, devices, shifts, pickup, catalog, integrations, jobs, audit | `RequestWithTenant`, `RequirePermissions`, `RequireSubscriptionWrite`, `AppModule` |
| `apps/admin`      | Tenant office for catalog, employees, shifts, labels, kiosks, integrations and exception handling                         | `apiFetch`, per-page API modules, `toast`                                          |
| `apps/saas-admin` | Platform-level tenants, catalog versions, subscriptions, billing, offers, platform team and audit                         | `platformApiFetch`, tenant/catalog/billing panels                                  |
| `apps/kiosk`      | Paired self-service pickup PWA, scanning, local cart, offline queue, outcomes and quarantine                              | `KioskShell`, `worker`, `cart`, `store/db`                                         |
| `apps/station`    | Offline line workstation and Tauri hardware shell                                                                         | `App`, `WorkScreen`, `SqlExecutor`, `createSyncEngine`, Rust printer module        |
| `apps/landing`    | Public product, localized content, demo form, SEO and legal publication                                                   | page content, SEO, legal artifacts, demo form                                      |

## Shared packages

- `packages/domain` is the reusable rule boundary: GS1/KM/GTIN/SSCC,
  check digits, scan classification, label models, ZPL/TSPL import and generation,
  raster rules, shift-export formatting, cabinet capabilities, and deterministic
  domain errors.
- `packages/db` owns PostgreSQL schemas and migrations plus the station SQLite
  schema and runtime migration list. Consumers can execute compiled exports, so
  source changes require rebuilding the package before consumer verification.
- `packages/ui` owns shared UI primitives and tokens.
- `packages/email` owns mail templates and rendering helpers.
- `packages/legal-documents` owns controlled legal-document sources, DOCX/PDF
  artifact generation, manifests, and verification.

## Trust and authorization boundaries

1. Cabinet users authenticate through the API auth module and are resolved to a
   tenant at protected server boundaries. `RequestWithTenant` is imported by most
   business controllers and is the strongest graph hub (187 edges).
2. Cabinet capabilities are enforced separately by `RequirePermissions` and the
   authorization guard. Subscription write/read-only rules add another gate.
3. Platform administration uses its own client and auth boundary in
   `apps/saas-admin`; it is not a tenant-admin route set.
4. Kiosks use paired device credentials. Their bootstrap data, branding, registry,
   queue, outcomes, and scanner settings are locally persisted and owner-bound.
5. Stations use station pairing/device identity plus synced offline operator
   PIN/badge credentials. Credential generations and recovery can retire or seal
   floor work without erasing the durable journal.
6. Exact audit evidence matters: tenant, actor, action, target, result, and relevant
   metadata must be asserted, not merely the presence of an audit row.

## Main operational flows

### Tenant office

`apps/admin` page APIs call the shared `apiFetch` client. The API reloads tenant,
permission, and subscription state at protected routes, validates DTOs, writes
tenant-scoped PostgreSQL records, and emits audit effects. Large/background work
is delegated to jobs or storage rather than performed in the browser.

### Station

1. App boot loads local configuration, applies SQLite migrations, resolves
   pairing/device identity, and loads the local shift/operator/product mirror.
2. Scans are classified with shared domain rules and admitted to the local journal.
3. Box state, exceptions, print recovery, pending shift close, credential
   generations, and the outbox survive restart.
4. `createSyncEngine` establishes install and batch ceilings, drains accepted work,
   publishes degraded/conflict state, and schedules bounded retry.
5. Server conflicts and credential rejection become explicit recovery state; they
   must not stop unrelated offline floor work.

### Kiosk

1. Pairing produces device configuration and bootstrap snapshots.
2. `KioskShell` coordinates local branding, credentials, scanner transports,
   product images, cart state, daily limits, queue ownership, and outcome display.
3. The sync worker refreshes snapshots/box registries, submits queued orders,
   records accepted/rejected/partial outcomes, quarantines unsafe work, and uses
   bounded retry with stale-data warnings.
4. Keyboard-wedge and Web Serial scanners are separate transports. Physical HID
   key decoding and OS layout behavior must be verified at the transport boundary.

### Labels and printing

The API validates and stores label-template JSON. `packages/domain` provides the
shared model and ZPL/TSPL/raster logic. Preview and physical output should consume
the same model. Station printing crosses the Tauri boundary into Rust and supports
raw document/byte output plus installed, USB, and network targets. Host tests do
not prove Windows driver, printer, Cyrillic, barcode, or media acceptance.

### Integrations and background work

The API integration registry and journal cover external channels, credentials,
candidates, sessions, and status. CommerceML parsing/apply/order export is one
channel family. `PgBossService` owns readiness, shift-export enqueue/reconciliation,
partition maintenance, retention/pruning, and mail queues. Infrastructure failures
must remain retryable; malformed business records should become precise per-record
errors.

## Persistence map

| Store                  | Owner                              | Purpose                                                                                       |
| ---------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| PostgreSQL             | API / `packages/db`                | Server authority, tenant data, audit, integrations, jobs and subscriptions                    |
| Station SQLite         | Station / `packages/db/src/sqlite` | Mirror, journal, outbox, credentials, boxes, exceptions, cached images and recovery state     |
| Kiosk IndexedDB stores | Kiosk                              | Device config, snapshots, credentials, branding, images, order queue, quarantine and outcomes |
| Object/media storage   | API storage/media modules          | Product images and generated/downloadable artifacts                                           |
| pg-boss                | API jobs module                    | Durable background job orchestration                                                          |

## Delivery and operations

- `infra/yandex` declares Yandex Cloud IAM, networking, compute, managed
  PostgreSQL, DNS, KMS and production variables/outputs.
- `deploy/production` owns immutable Compose deployment, edge routing, preflight,
  smoke and contract checks.
- `deploy/yandex` materializes runtime inventory and remote deployment/diagnostics.
- CI separates static checks, API/database tests, app tests, production bundle
  contracts, Rust checks, Windows Station builds, image publication and Station
  beta release provenance.
- Live cloud changes, DNS/public exposure, production deployment, release
  publication and job replay remain approval-gated external actions.

## Where to start a change

| Change                                          | Start here                                                | Then verify                                                                 |
| ----------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| GS1, KM, SSCC, scan, label or print-format rule | `packages/domain`                                         | affected API/admin/kiosk/station consumers                                  |
| PostgreSQL or Station SQLite shape              | `packages/db` plus a new migration                        | DB build/tests, actual migration state, affected consumers                  |
| Tenant business behavior                        | API controller/service plus authorization and audit tests | cross-tenant denial, exact audit, OpenAPI/client contract                   |
| Tenant office UX                                | `apps/admin` page and its API module                      | component tests and real browser review when visual                         |
| Kiosk pickup/offline behavior                   | kiosk session/store/sync worker                           | restart, stale cache, legacy queue, pairing and scanner boundaries          |
| Station floor/offline behavior                  | station mirror/journal/outbox/sync and WorkScreen         | restart, degraded sync, Rust boundary, Windows/hardware acceptance          |
| Hardware print/scanner/update                   | Station TypeScript contract and `src-tauri`               | Cargo/host tests plus real Windows/device acceptance                        |
| Platform SaaS/billing/catalog                   | `apps/saas-admin` and platform API modules                | platform auth/capabilities, tenant lifecycle and billing contracts          |
| Deployment/infrastructure                       | `deploy` and `infra/yandex`                               | contract tests first; live approval and post-change verification separately |

## Current architectural signals

- The API, admin, and station dominate the graph. Centrality confirms that tenant
  context and permission metadata are architectural choke points, not helpers.
- Station local persistence is another choke point: `SqlExecutor` is imported
  throughout authentication, boxes, conflicts, journal, outbox, setup and recovery.
- The repository contains three reported Station import cycles around
  `api-client`, `credential-recovery`, `shift-bundle`, and `product-image-cache`.
  Verify whether these are runtime cycles or type/import structure before refactoring.
- Several large API communities have low cohesion (about 0.03-0.04). This is a
  prioritization signal, not proof that they should be split: generic framework
  nodes and collapsed edges distort community boundaries.
- Cross-area edge counts are under-represented because many imports terminate in
  generic/external nodes and 5,629 endpoints are dangling. Never infer that two
  applications are independent from a missing graph edge.

## Working protocol

1. Start with `git status --short` and preserve unrelated work.
2. Read the nearest `AGENTS.md`, the affected implementation, focused tests,
   migrations/contracts, and comparable history.
3. Use Graphify to identify hubs and candidate paths, then verify every material
   path in current source before changing behavior.
4. Write or update a focused failing test before implementing a feature or bug fix.
5. Make the smallest coherent change and run narrow checks during iteration.
6. Rebuild `@markiro/db` or other compiled workspace packages before consumer
   tests when their sources changed.
7. Report automated proof separately from browser, database infrastructure,
   Windows, printer, scanner, 1C, mail, object storage, DNS and live-cloud proof.
8. Use `graphify update` after material repository changes; use `graphify query`,
   `path`, or `explain` for navigation instead of rebuilding the full corpus.

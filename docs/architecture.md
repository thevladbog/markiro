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
  handheld/   Kotlin + Compose — Android app for industrial handheld terminals (ТСД);
              a station-kind device reusing the station credential and endpoints
              (validates codes offline with the station's rules and syncs scan batches
              through the same /station/scans protocol; inventory check runs the
              station's inventory protocol — digest-checked snapshot bundle, event
              batches with payloadDigest, progress feed — with a second sync engine;
              renders labels on the device with a Kotlin port of the domain package's
              ZPL/TSPL emitters and prints over Wi-Fi or Bluetooth, with no hardware agent;
              packs boxes from its own SSCC block, burning a serial at close rather than
              at open so an empty or abandoned box costs none, and closing a box even
              with no printer — the label queues instead, because a dead printer must
              not stop a line and the box is already numbered and reported.
              Box closures are acknowledged UNCONDITIONALLY, unlike the station's
              conditional ack: nothing in a handheld closure payload can change after
              the box closes, because print state never leaves the device.
              Product-label events are the opposite and acknowledged PER EVENT,
              because the server answers each with a receipt and may quarantine one.
              The device advertises validation-dm-duplicate-v1, so it may enter a
              shift whose validation policy prints a duplicate: one job at a time,
              bytes prepared once and replayed rather than re-rendered, and an
              unknown delivery resolved by scanning the printed sticker under either
              policy. Durable work belongs to the normalized server origin, tenant,
              device ID and handheld kind. Credential rejection seals that owner's
              database generation, removes the rejected secret and operator roster,
              and preserves operational rows for authorized same-device recovery.)
  kiosk/      React 19 + Vite 8 + IndexedDB — offline-first self-service
              pickup kiosk (installable PWA), paired to the api by device token
  landing/    Astro 7 — marketing site
packages/
  domain/     GS1 validation, SSCC, ZPL/TSPL generation, Cyrillic
              rasterization, export formats — shared by api/admin/station
  platform-contracts/
              Zod request, response, error, and primitive contracts shared by
              the platform API, SaaS administration browser, and OpenAPI
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
- **Multiple COM scanners:** every saved port has an independent reader and
  reconnect loop. Any scanner can feed the existing scan queue without operator
  switching; one failed port does not stop the others. Local settings retain
  compatibility with the legacy single-scanner configuration. See
  [runtime and acceptance](acceptance/station-multiple-com-scanners.md).
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

### Product Data Matrix duplicate labels

A validation shift can print one duplicate of the full product Data Matrix on its
outer packaging. This does not create another product unit, SSCC or aggregation.
The administrator or station operator chooses `validationPrint` before activation:
`none`, or `duplicate_dm` with `verification=required|none`. Opening freezes the
policy revision and a validated `product_duplicate` template snapshot. Box-purpose
templates and organization/category box defaults remain separate.

The station prepares a GS1 raster with the canonical full code and saved label
fields/date. Its local accept command atomically creates the accepted scan, job,
first attempt and outboxes through SQLite triggers. At most one unresolved job
exists per credential owner; pooled connections never depend on a multi-call
BEGIN/COMMIT. A durable `sending` claim precedes transport. Restart maps an unfinished
send to `delivery_unknown` without resending. Explicit reprints keep the original
bytes and require a reason. Required verification durably compares the full code,
including separators and crypto tail, before accepting the next unit.
The handheld also offers an explicit verification skip after a successful send:
`verification_skipped` settles that attempt with outcome `skipped`, preserves the
operator and timestamp, and permits the next unit without claiming verification.
A skip cannot settle unknown delivery or an unsent attempt. Reprinting resets
verification to pending. Deploy the expanded event contract on the API and cabinet
before distributing handheld builds that can emit the new event.

`POST /station/scans` carries ordered `productLabelEvents` and explicit per-event
receipts. The full combined request is pinned before HTTP and retried unchanged;
late verification remains queued after earlier acknowledgements. Server records
are keyed by tenant/device/job and event, with quarantined physical facts retained.
Cabinet history separates attempts, sends, verification and accepted product counts.
Local print copies retire only after the shift closes, every channel is acknowledged,
and no conflict, quarantine or pinned request remains. Product identity is retained.

`VALIDATION_DM_DUPLICATE_ENABLED` defaults to false and only gates new policy
creation/enablement. Existing compatible bundle/recovery/sync remain available when
it is disabled. Hardware/Windows acceptance and staged rollout are documented in
[the acceptance runbook](acceptance/validation-dm-duplicate.md); browser mock transport
is not evidence that any specific printer/scanner combination is supported.

## 3. Offline & sync

- Shift downloads to the station in full: product, label template,
  capacities, counterparty GLN, **pre-allocated SSCC serial ranges per
  terminal** — boxes/pallets print offline with no collisions.
- Product snapshots carry an optional private image descriptor. Device mirrors
  treat an absent `image` field as a legacy/unknown value and retain any
  already-published local pointer; only explicit `image: null` clears it. This
  keeps older API payloads safe during rolling deployment while kiosk and station
  clients publish only validated WebP bytes offline.
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

### Inventory v1 boundary and release status

Inventory is a dedicated tenant-scoped aggregate, not a synthetic production shift. Tenant admin
owns preparation and lifecycle; Station devices execute the frozen task through their own offline
journal, participant, claim, repack, and sync models. One inventory contains one product, one line,
one inclusive production-date range, and either check or repack mode. `INTRODUCED` is the expected
status, while `MOVING_BY_UD` is always protected and excluded from expected stock and destructive
outputs. Reopen increments the result revision and invalidates older document artifacts; completed
inventories are immutable. The detailed invariants and API surface are defined in
`docs/superpowers/specs/2026-08-24-inventory-v1-architecture.md`.

The preparation, execution, reconciliation, correction, close/reopen, document-job, download, and
tenant-admin UI infrastructure has automated coverage recorded in
`docs/acceptance/inventory-admin.md`. One continuous DB-backed acceptance journey retains the same
inventory through six imports, snapshot fixation, start, two Station devices, simple/repack work,
and a cross-device duplicate. It voids and restores the accepted protected result implicated in
that duplicate with projection-digest and append-only audit evidence, then continues through
leave/close, document generation, reopen/regeneration, and completion. The production registry
exposes exactly `inventory_xml_gismt_aggregation` v1 and
`inventory_xml_gismt_disaggregation` v1. Their approved fixtures, XSD evidence, and real API-runner
path cover frozen result loading, deterministic XML, verified artifact publication, individual and
ZIP download/checksums, reopen invalidation, regeneration, and completion; protected
`MOVING_BY_UD` contents remain excluded from both outputs. The runner acceptance makes the
parent-level rule observable: an eligible repack item shares its frozen old-box parent with a
protected code, that shared old SSCC is excluded from disaggregation, and a second clean repacked
old SSCC is emitted.
This is still not a complete-v1 document release: TXT, CSV, and XLSX formats remain unapproved and
absent. Synthetic generators remain test-only and do not establish production format or external
portal compatibility.

### Platform administration contract boundary

`packages/platform-contracts` owns the platform administration wire contract. Its exported Zod
objects are the single source of truth for API boundary validation, SaaS browser parsing, and the
success, request-body, and strict error schemas embedded into OpenAPI. Controllers bind their
declarative OpenAPI metadata directly to those objects; copying nested field lists into Swagger
decorators is not an accepted contract path.

Some response contracts normalize database `Date` values and timestamp strings. Zod 4 cannot
represent those output transforms as JSON Schema, so OpenAPI publishes the shared schema's accepted
JSON wire-input shape (without the JSON Schema `$schema` marker). The controller response boundary
still parses that shape and returns the normalized contract output, including canonical ISO
timestamps.

The current SaaS OpenAPI inventory covers the platform principal, public activation, team, audit,
tenants and subscription assignment, catalog and demo-plan setting, legal profiles and bank
accounts for Markiro and tenants, offers and their documents and payment, invoices and their
documents/application/cancellation, and payments. Protected operations
declare the named `platformSession` Better Auth cookie scheme using the initialized Better Auth
session-cookie name (`markiro-platform.session_token` for HTTP and the `__Secure-`-prefixed name
for HTTPS); public activation deliberately declares no cookie security.

Legal and banking data is revisioned. Issued offers and invoices keep immutable seller, buyer, and
selected bank-account snapshots, so later profile edits or account archival cannot rewrite an
already-issued document. A tenant and Markiro each have one legal profile and may have multiple
bank accounts with one active default. DaData is an optional suggestion adapter for organizations,
addresses, and banks; it never makes a suggestion authoritative or blocks manual entry.

Commercial P0 adds explicit catalog document names, seller-policy revisions and frozen line terms.
Resource quotas distinguish zero (not included), positive limits and null (unlimited); trial days
remain positive or null. Paid license intervals use the original calendar anchor in Europe/Moscow,
not the display unit or quantity as a period multiplier. Invoice and direct accepted-offer
application share lifecycle and sold-line ownership; repeated application cannot grant twice.
Issued bytes and historical snapshots remain unchanged after catalog or seller edits.

P0 platform clients negotiate `X-Markiro-Commercial-Version: 2`; legacy positive/null
representations remain strict and truthful, and unrepresentable zero values fail with
`client_update_required`. Review and issuance revalidate the current seller revision. Calculated
invoice/offer amounts fail with `commercial_amount_out_of_range` before overflowing money columns.
See the [rollout and recovery guide](operations/commercial-p0-rollout.md) for additive migration,
client order, read-only impact reporting and rollback limits. This P0 does not enable P1 module
or offline licensing enforcement and does not implement P2 recurring services.

P1A adds an explicit Commercial V3 and a coherent entitlement snapshot with separate current and
candidate conditions. New module mappings remain nullable on legacy versions. Prepared temporary
and compatibility sources retain their operation-version scope, immutable proof and audit; they
affect shadow calculations only. Terms and occupied-capacity revisions commit with their owning
writes, and confirmation also binds time and policy identity. V3 plans require four explicit
module values. Catalog publication for plans, add-ons and services may omit the additional
lifecycle policy and retain current subscription rules; this also permits offers and invoices.
An explicitly selected policy must be approved and intact, and its identity remains bound to
publication review. Publication does not activate candidate P1 restrictions. The customer projection excludes
internal source metadata, while platform preparation requires both tenant and billing write
capabilities. Tenant readiness/impact is a read-only current observation that does not assign or
activate rights, migrate customers, or verify native clients. See the
[P1A preparation and recovery guide](operations/entitlements-p1a.md) for
version negotiation, preview recovery and migration order. Device allocation, offline grants and
production activation remain P1B–P1D.

P1B.2 introduces a current licensed-place assignment and append-only transition journal
for each Station/handheld identity; both kinds use the same `stations` pool. Creation,
pairing, security revocation and re-pairing maintain assignments under the existing
quota lock. Missing or contradictory facts retain capacity and disable reservation
cancellation until diagnosed. An authorized user may cancel a never-paired, keyless
reservation without production references; its device record remains, its live code
is retired, and the cancelled assignment cannot be reused. Cancellation compares a
revision and stores an actor-bound idempotent receipt. It is permitted in read-only
subscription state without enabling creation or credential issuance. Separate cabinet
and platform inspection routes expose licensing independently of connection status.
The deployment image compatibility floor rejects old readers/writers for both deploy
and rollback; see the [device reservations runbook](operations/entitlements-p1b2.md).
Replacement preparation uses separate previews and saved projects with the same
tenant, actor and transactional journal boundaries. It records target intent and
known server work while local queues remain unknown. Confirming or cancelling a
project never changes the source assignment, credential or operational authority.
Fresh source/pool/commercial facts invalidate stale previews and mark saved projects
for review. Actual transfer, downgrade retention and offline grants remain later deliveries.

Bank imports retain the bounded source row as reconciliation evidence, while the public match and
audit contracts expose only the payer account's last four digits and whether it is a known active,
known archived, unknown, or unavailable account. Active known accounts may be suggested. Archived
known and unknown accounts require an explicit operator decision. Confirming an unknown payer does
not create a tenant bank account; adding legal details remains a separate audited action.

Every platform error response has the safe `{ code, message, requestId }` envelope. Request IDs are
the diagnostic correlation boundary: neither response bodies nor secrets belong in browser errors
or server logs. The SaaS application treats independent panels as independent contract boundaries,
so one failed panel exposes its endpoint context and request ID without erasing already-valid data
from another panel.

OpenAPI and automated contract tests prove repository-level route, schema, status, and declared
security agreement only. They do not prove a live reverse proxy, database, deployed browser,
external integration, or production environment.

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

## National Catalog product import and confirmed links

The cabinet import workflow is implemented with explicit own-feed and GTIN entries,
selection and immutable review preparations. Provider import flags default off;
production access, CDN hosts and live recovery acceptance remain unverified.
[The import runbook](runbooks/national-catalog-import.md) defines operational and
rollout boundaries; [delivery evidence](evidence/national-catalog-import/delivery-verification.md)
records current local verification separately from external acceptance.

Product cards render regulatory attributes from the profile's pinned schema definition.
Production, code-ordering, circulation and EGAIS readiness remain separate. Category
binding/change requires an explicit preview and confirmed value transfer; operational
base fields and category attributes use separate saves. Background read failures preserve
cached cards and unsaved drafts; a conflict reload fetches the current revision before
an explicit discard. Read-only cabinet access opens the same product route in view mode.
National Catalog numeric values retain the exact supported source unit across preview,
apply, observation and reviewed baselines; missing or unsupported units are not inferred.
[Catalog delivery evidence](evidence/catalog-category-readiness.md) records local checks
and the remaining live schema/assortment acceptance for groups 23, 33 and 35.

A confirmed link binds tenant, provider environment, card, canonical GTIN and revision.
GTIN equality only offers a link. One card may expose several GTINs. New import
requires owned/granted feed access, never public-card fallback. Canonical GTIN edits
require explicit revision-pinned atomic detach. Local unlink retains values, active
photo, immutable snapshots and history; `externalRef` remains the 1C association.

Accepted product fields, initial category, link, snapshot and exact audit evidence
commit together per position. Observed projections record provider freshness while
reviewed projections preserve accepted choices. Background checks never overwrite
accepted fields/category/photo. Explicit archive disables v1 comparison/import and
suppresses the changes indicator without discarding baseline evidence; unknown is
not archive. Additive public identity/dependency projections read legacy stored rows
without rewriting receipt/source bytes or hashes.

Confirmation advances review independently of observation and attempt chronology.
A later observation/status or newer failed attempt survives applying an older
comparison; displayed check time uses the stored fetch/preparation anchor. Pending
refresh work uses the current link revision and existing identity/step/run fencing,
preserving same-step actor, retry budget and provider delay. Photo checks reselect
from the verified latest snapshot when the reviewed selector changes, without
reusing another photo's checksum.

Public cancellation serializes with accepted work and stops remaining core/photo
continuations even after temporary TTL. Bounded per-record cleanup removes expired
unconfirmed session/item/preparation payloads and impossible photo retention while
preserving identity stubs, exact audit, accepted decisions and applied evidence.

Photos have independent durable outcomes and explicit READY-candidate choices.
Accepted cached bytes remain referenced for eligible post-TTL recovery; preview and
active image use the same normalized WebP. GC serializes its reference recheck with
attachment and performs object deletion outside the lock. Image errors do not undo
a committed product. Existing Kiosk/Station private image descriptors and caches
remain the delivery path; host tests are not physical offline/Windows proof.

Tenant-fenced external coordination, durable checkpoints and repair queues support
partial discovery, cancellation and retries. Current WRITE and subscription state
are checked again before queued mutations. Immutable operation receipts remain
readable after temporary expiry. The cabinet preserves unknown pending apply intent
across TTL/access failure and scopes it to actual auth identity outside the query
boundary. Local storage must round-trip before a new POST.

Enumeration flags do not disable confirmed-link observation refresh; that separately
requires explicit provider configuration, environment, credential and eligibility.
Accepted cached photo completion and local unlink remain provider-independent.
Rollback disables provider work without deleting additive schema or evidence. The
0122 dispatch-attempt fairness history is retained, grows by logical work step and
cascades on tenant deletion; no additional history GC is introduced.

## Open items (tracked for later phases)

- Direct Chestny ZNAK integration (SUZ code ordering, report submission,
  UKEP).
- Billing/tariffs; customer portal for tolling counterparties.
- Linux/Android stations; optional standalone hardware agent (web mode).
- Optional code-pool tracking is in scope for MVP dashboards (KPI «остатки
  кодов») when clients pre-load ordered code files.

# Operational report exports

Platform operational exports are durable, creator-scoped intents processed asynchronously from a read-only, repeatable-read snapshot. The platform API exposes fixed templates and typed filters instead of production SQL. Artifacts are verified private ZIP objects with bounded signed downloads and seven-day retention; PostgreSQL remains authoritative for lifecycle and audit state. See [the operational guide](operations/platform-report-exports.md).

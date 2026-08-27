# Task 6 Report: Platform Request Workflow, Linked Invoices, and Acts

## Status

Implemented and verified on branch `codex/tenant-admin-billing` from base
`39f1fce841880f6458bda4e309fa8deec23dc1cf`.

Commit: enclosing commit `feat(api): add billing request operations and acts`; the final SHA is
reported in the Task 6 handoff because a commit cannot contain its own content-derived hash.

## Behavior changed

- Added platform billing-request list/detail, comment, status, and typed-link endpoints with the
  existing `billing.read` / `billing.write` capability boundary. Comment, transition, and link
  mutations reload and lock the server-owned request, use a tenant-scoped durable UUID
  idempotency ledger, and atomically write the tenant-visible event plus exact platform audit.
- Implemented the prescribed request transition graph and deterministic `responsibleSide`
  mapping. Invalid, repeated, and terminal transitions return a precise 409 without an event,
  audit, or partial request update.
- Added offer revision after the current latest-published family revision's latest canonical
  `changes_requested` decision. Revision serializes the family, locks revisions and decision in a
  consistent order, ignores a later draft when identifying the published revision, rejects a
  second draft, copies the editable terms and literal line values into revision + 1, and leaves
  prior print snapshots and documents immutable.
- Invoice creation now optionally accepts a tenant-scoped accepted `sourceOfferId` and
  `sourceRequestId`. It locks the request, offer family, current published offer, and latest
  canonical accepted decision; stores `sourceOfferId` physically on the invoice; and stores
  request provenance as a typed `tenantBillingRequestLinks` row in the same transaction.
- Invoice issue preserves the Task 3 issue/payment contract while atomically emitting the
  platform-actor `invoice_linked` request event/audit and, when valid, the
  `offer_prepared -> awaiting_payment` transition event/audit together with invoice issue.
- Added platform act list/detail/create/issue/cancel endpoints. Creation tenant-scopes every
  optional request/invoice/service source. Issue accepts one PDF up to 5 MiB, validates MIME,
  byte length, and PDF magic, and uses the canonical
  `tenant-billing/{safeTenant}/acts/{actUuid}/{documentUuid}.pdf` key already accepted by the
  private-storage boundary and Task 4 tenant reader.
- Act issue uses a durable pending document intent and mutation ledger before object PUT,
  verifies size/SHA-256, reconciles an ambiguous PUT acknowledgement, and finalizes the ready
  document, issued act, optional request link/event, platform audits, and idempotency result in one
  transaction. A lost final COMMIT acknowledgement is resolved by exact operation/target/payload
  lookup and never deletes a committed document.
- Act issue is allowed once and only after a linked ordered service is completed, or for a
  period-only act when `periodEnd` is strictly before the current Europe/Moscow business date.
  Cancellation is idempotent and never deletes or hides an issued PDF.
- Added forward migration `0070_tenant_billing_platform_workflow` for the shared platform billing
  mutation ledger and act-document `pending` / `ready` / `failed` / `cleanup_required` lifecycle.
  Existing act documents are backfilled to `ready` with their original creation timestamp.
- Task 4 tenant act document listing/download now exposes and signs only `ready` rows and requires
  the exact tenant/act/document canonical key.
- OpenAPI and route inventories now include the real request, revise, act, multipart upload,
  status-code, UUID-idempotency, response, and capability shapes.

## TDD evidence

### RED

- The first contract run had 3 intended failures because request mutation/event/link contracts,
  offer revise, source UUIDs, and act lifecycle/upload contracts did not exist.
- Focused request, source-invoice, revision, and act service tests initially could not import the
  missing modules/methods.
- The platform route inventory reported the seven new unsafe mutations as unclassified until each
  was registered under the existing platform capability policy.
- The first combined regression exposed two old sequential DB mocks that had no result slot for
  the newly required server-side tenant reload. After the fixture represented the real query
  order, the focused snapshot file passed 5/5.
- Appending migrations 0069/0070 made a historical 0068 test's “latest migration” lookup select
  0070. The test was corrected to address 0068 by its immutable timestamp; its SQL hash/id and
  no-reapply assertions remain exact.

### GREEN

Focused Task 6 plus adjacent invoice, reader, route, storage, and document-snapshot regression:

```text
PLATFORM_AUTH_URL=http://localhost:3001 SAAS_ADMIN_ORIGIN=http://localhost:5174 \
node --env-file=/Users/thevladbog/PRSOME/q/.env ./node_modules/vitest/vitest.mjs \
  --config vitest.task6.config.ts run \
  test/platform-billing-requests.service.test.ts \
  test/billing-acts.service.test.ts \
  test/platform-offers.service.test.ts \
  test/platform-contract-openapi.test.ts \
  test/tenant-billing-read.service.test.ts \
  test/tenant-billing-read.integration.test.ts \
  test/subscription-route-inventory.test.ts \
  test/billing-invoices.test.ts \
  test/billing-offer-snapshot.test.ts \
  test/document-account-snapshot.test.ts \
  test/object-storage.test.ts
```

Result: **PASS, 11 files / 88 tests**.

The service/integration files create UUID-named scratch databases, apply the current migration
chain, exercise real row/advisory locks and uniqueness, and drop those databases afterward. The
suite proves all request transitions and responsible sides; exact event/audit facts; payload
collision and replay; foreign-tenant denial; accepted/current offer sourcing with a later draft;
source-request provenance; atomic invoice issue transition; family decision/draft locking;
concurrent revision replay; canonical pending act intent before PUT; ambiguous acknowledgement
recovery; issue-once; completed-service/closed-period readiness; cancellation without object
deletion; ready-only tenant reads; multipart OpenAPI; and the real private-object key validator.

Focused DB fresh/upgrade/history suite:

```text
node --env-file=/Users/thevladbog/PRSOME/q/.env ./node_modules/vitest/vitest.mjs run \
  test/tenant-billing-platform-workflow-migration.test.ts \
  test/tenant-billing-migration.test.ts \
  test/tenant-billing-action-reconciliation-migration.test.ts \
  test/tenant-billing-document-pagination-migration.test.ts
```

Result: **PASS, 4 files / 17 tests**. The new schema contract separately passed **5/5**.

Contract parsing passed **19/19**. Offer service's complete focused file passed **16/16**;
request/source-invoice passed **11/11**; acts passed **6/6**; OpenAPI passed **3/3**; and route
inventory passed **4/4**.

## Automated checks

- Focused API/security/storage/scratch-Postgres suite: **PASS, 11 files / 88 tests**.
- Focused DB schema/fresh/upgrade/history suite: **PASS, 5 files / 22 tests**.
- Platform commercial contract suite: **PASS, 1 file / 19 tests**.
- Drizzle migration no-diff: **PASS** — `No schema changes, nothing to migrate`.
- API source typecheck with temporary worktree source aliases: **PASS**.
- API emitted TypeScript build with those aliases to an isolated `/private/tmp` directory:
  **PASS**; the directory was removed afterward.
- DB and platform-contract source/test typecheck, emitted build, and scoped ESLint: **PASS**.
- Scoped API ESLint with source aliases: **PASS**.
- Scoped Prettier check and `git diff --check`: **PASS**.

The temporary Vitest, TypeScript, and ESLint source-alias configs were removed after the gates.
Existing dependency symlinks were not modified. The repository's `pnpm` launcher attempted to
fetch unavailable `@pnpm/exe@11.22.0` from the configured private registry, so the same checked-in
configs and package-local installed binaries were invoked directly instead of weakening install
policy or changing dependencies.

## Files changed

- `packages/platform-contracts/src/commercial.ts`
- `packages/platform-contracts/src/index.ts`
- `packages/platform-contracts/test/commercial.test.ts`
- `packages/db/src/schema/tenant-billing.ts`
- `packages/db/migrations/0070_tenant_billing_platform_workflow.sql`
- `packages/db/migrations/meta/0070_snapshot.json`
- `packages/db/migrations/meta/_journal.json`
- `packages/db/test/tenant-billing-platform-workflow-migration.test.ts`
- `packages/db/test/tenant-billing-schema.test.ts`
- `packages/db/test/tenant-billing-migration.test.ts`
- `packages/db/test/tenant-billing-action-reconciliation-migration.test.ts`
- `packages/db/test/tenant-billing-document-pagination-migration.test.ts`
- `apps/api/src/modules/platform-billing-idempotency.ts`
- `apps/api/src/modules/platform-billing-requests/`
- `apps/api/src/modules/billing-acts/`
- `apps/api/src/modules/billing/billing.service.ts`
- `apps/api/src/modules/platform-offers/dto.ts`
- `apps/api/src/modules/platform-offers/platform-offers.controller.ts`
- `apps/api/src/modules/platform-offers/platform-offers.service.ts`
- `apps/api/src/modules/tenant-billing/tenant-billing-read.service.ts`
- `apps/api/src/app.module.ts`
- `apps/api/test/platform-billing-requests.service.test.ts`
- `apps/api/test/billing-acts.service.test.ts`
- `apps/api/test/platform-offers.service.test.ts`
- `apps/api/test/platform-contract-openapi.test.ts`
- `apps/api/test/platform-route-contracts.ts`
- `apps/api/test/subscription-route-inventory.test.ts`
- `apps/api/test/billing-offer-snapshot.test.ts`
- `apps/api/test/tenant-billing-read.service.test.ts`
- `apps/api/test/tenant-billing-read.integration.test.ts`

## Deviations, limits, and risks

- Migration 0070 was required because Task 6 needs a durable, payload-sensitive idempotency record
  shared by request, revise, and act mutations, plus tracked act upload reconciliation states.
- Existing Task 4 reader tests and historical migration tests changed in addition to the brief's
  original file list so pending objects cannot become tenant-visible and appending 0070 does not
  weaken earlier migration identity checks.
- No autonomous reconciliation scheduler was added. Indeterminate uploads remain durable and
  non-downloadable as `pending` or `cleanup_required`; retry of the exact issue mutation performs
  safe inline reconciliation.
- Full API, DB, and repository-wide suites were not run. The task used the requested focused
  contracts, service, OpenAPI, migration, source-invoice/payment-regression, typecheck, lint,
  format, build, and diff gates.
- No live S3/MinIO provider was used. Upload behavior is proven against the production service
  boundary with controlled verification/ambiguity mocks; provider-specific consistency remains an
  external check.

## Manual/external checks

- No shared development or production database was migrated, seeded, dropped, or otherwise
  mutated. `DATABASE_URL` was used only as a maintenance endpoint for isolated scratch databases.
- No live object storage, browser UI, production deployment, mail, Windows, printer, scanner, 1C,
  DNS, or hardware surface was exercised.

## Self-review

- Rechecked every request, offer, decision, invoice source, act source, link, event, document, and
  audit query for tenant predicates and server-side reloads.
- Rechecked lock order, latest-published selection with later drafts, latest canonical decision,
  second-draft rejection, and issue-once concurrency.
- Rechecked exact actor, tenant, action, outcome, target, before/after, and bounded metadata on all
  new platform audit facts.
- Rechecked that invoices physically retain only tenant-scoped `sourceOfferId`; request provenance
  is the typed relation and Task 3 partial-payment/application behavior remains covered.
- Rechecked PDF MIME/magic/size, safe canonical UUID key, ready-only tenant reads, checksum
  verification, ambiguous acknowledgements, and the rule never to delete a committed act document.
- Rechecked that staged scope excludes dependency symlinks, generated build output, local env,
  temporary configs, and unrelated files.

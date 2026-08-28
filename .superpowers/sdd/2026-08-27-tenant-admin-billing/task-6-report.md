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
- Appending migrations 0069/0070 made a historical 0068 test's “latest migration” lookup select 0070. The test was corrected to address 0068 by its immutable timestamp; its SQL hash/id and
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

## Fix Round 1

### Status and commit

All nine reviewer findings were addressed on top of
`99b3f5d90c8f44dd0fdcebe8e2bf58ebc749b4a7`. The enclosing follow-up commit is
`fix(api): harden billing workflow concurrency`; its SHA is reported in the handoff because a
commit cannot contain its own content-derived hash.

### Behavior corrected

- Publishing a revised draft now atomically changes every prior `published` revision in that
  family to persisted `superseded`. Current-generation lookup uses the complete family ordered by
  revision, ignores only a still-unpublished draft, never falls back after a newer generation is
  paid or cancelled, and allocates a revision from the full family maximum. Payment and invoice
  source validation both require that exact current published generation plus its latest
  canonical `accepted` decision before any payment, fulfilment, invoice, or request relation is
  written.
- Forward migration `0071_tenant_billing_target_cardinality` adds the `superseded` enum state and
  immutable published-offer transition support, fails upgrades deterministically when legacy
  offer/invoice/act links are ambiguous, and replaces the three request-scoped partial indexes
  with tenant-plus-target partial unique indexes. Concurrent different-request claims now return
  one success and exact `billing_target_already_linked` conflict rather than leaking `23505`.
- Added one shared, tenant-scoped, sorted advisory resource-lock protocol for offer families,
  offers, invoices, payments, acts, services, requests, act numbers, and payment keys. Request
  links, invoice create/issue/cancel, act create/prepare/finalize/cancel, offer
  revise/publish/pay, and tenant offer decisions acquire these locks before entity row locks.
  Zero-or-one relation reads no longer hide ambiguity behind `limit(1)`.
- Act cancellation now locks the act and current document and returns exact
  `act_issue_in_progress` while a durable `pending` or `cleanup_required` upload intent exists.
  An exact issue retry verifies and reconciles that canonical object before upload/finalization;
  a lost storage or final COMMIT acknowledgement cannot delete a committed ready document.
- UUIDs used by platform mutations are canonicalized before advisory-lock keys, idempotency
  fingerprints, comparisons, and persistence. Upper/lower aliases therefore share one serialized
  mutation and return canonical IDs; a different payload still returns exact
  `idempotency_key_reused`.
- Request and act list query schemas are emitted into OpenAPI as their actual validated query
  parameters. Act issue documents its real multipart body and exact 413 schema. The shared Multer
  filter maps a platform 5 MiB overflow to `billing_act_pdf_too_large`, while retaining the legacy
  tenant attachment response.
- The public tenant identifier and act object-key boundary now share one contract helper. Safe
  identifiers containing `.` or `:` work end-to-end; slash, backslash, traversal, control, and
  percent ambiguity are rejected. The act writer, tenant reader, and storage validator all require
  the exact canonical
  `tenant-billing/{tenant}/acts/{actUuid}/{documentUuid}.pdf` key.
- Invoice creation emits `invoice_linked` history when it inserts the relation; invoice issue does
  not repeat it. Act finalization emits `act_linked` history only for a newly inserted relation.
  Explicitly pre-linked issue still performs the issue/status work without duplicating tenant or
  platform facts.
- The scratch request matrix now covers every allowed transition and every forbidden edge from
  every source state exposed by the mutation contract, including cancellation and both terminal
  states, with exact `responsibleSide`, event, audit, metadata, and no-write assertions.

### TDD evidence

#### RED

- The first 0071 migration test failed because the forward migration and snapshot did not exist;
  the pre-migration schema also allowed the same offer/invoice/act target to belong to two
  requests.
- The stale-family scenario initially left P1 `published`, allowing old commercial terms to be
  considered current after D2 publication. Further-revision tests also exposed revision lookup
  that did not use the full family maximum.
- The controlled two-phase upload interleaving initially allowed cancellation after a pending
  document intent had committed and before upload/finalization.
- Upper/lower UUID service calls initially produced distinct payload fingerprints or retained the
  supplied alias instead of one canonical mutation identity.
- OpenAPI initially omitted the validated list-query parameters and the real 413 upload response;
  a real oversized multipart request did not return the documented platform error shape.
- A tenant act reader test using a canonical key plus `.bak` initially received a presigned result,
  proving that prefix-only comparison was insufficient.
- Mixed request-link/issue tests initially observed duplicate `invoice_linked` or `act_linked`
  history when issue followed an explicit relation insert.

#### GREEN

The final adjacent API regression passed **17 files / 194 tests**:

```text
platform-billing-requests.service.test.ts
billing-acts.service.test.ts
platform-offers.service.test.ts
tenant-billing-offers.service.test.ts
platform-contract-openapi.test.ts
subscription-route-inventory.test.ts
billing-invoices.test.ts
billing-offer-snapshot.test.ts
document-account-snapshot.test.ts
billing-payments.service.test.ts
billing-application-flow.test.ts
tenant-billing-read.service.test.ts
tenant-billing-read.integration.test.ts
tenant-billing-read.authorization.test.ts
tenant-billing-requests.service.test.ts
tenant-billing-actions.e2e.test.ts
object-storage.test.ts
```

Those scratch-Postgres tests cover the full transition table, same-target concurrent claims,
upper/lower mutation aliases, P1 changes-requested to D2 published/current acceptance, no stale
payment or fulfilment, no revision fallback/collision, decision versus invoice-create/revise,
link versus invoice/act issue, pending-upload cancellation, ambiguous storage acknowledgement,
issue retry/finalization, issue once, exact link-history counts, tenant/source isolation, and exact
audit/event metadata. Every mixed operation completed or returned a domain conflict; none leaked
`40P01`, raw `23505`, or a 500.

The final DB schema/migration chain passed **6 files / 24 tests**, including fresh migration,
real 0065/0068/0070 upgrade fixtures, deterministic legacy-ambiguity failures for all three target
kinds, successful 0071 application after disambiguation, partial uniqueness, immutable historical
migration identity, and runtime no-reapply behavior. Drizzle generation reported exactly
`No schema changes, nothing to migrate`.

Platform contract primitive and commercial suites passed **30/30**. API source plus test
typecheck, DB source plus test typecheck, and platform-contract source plus test typecheck passed
with worktree-local source mappings. Scoped API/DB/contracts ESLint passed. DB and contract emitted
builds and the Nest API build passed with output isolated under `/private/tmp`. Scoped Prettier,
`git diff --check`, and the final staged diff check passed.

### Files and migration scope

- Added `apps/api/src/modules/billing-workflow-locks.ts` and adopted it in request, invoice, act,
  platform-offer, and tenant-decision services.
- Updated request/invoice/act/offer services, upload filtering, OpenAPI decorators and route
  inventory, Task 4 tenant reads, and object-storage key validation, with their focused tests.
- Added `packages/platform-contracts/src/tenant-billing-object-key.ts`; updated UUID/tenant
  primitives, offer lifecycle and upload-error contracts, exports, and parse tests.
- Updated DB offer status and request-link indexes; added
  `packages/db/migrations/0071_tenant_billing_target_cardinality.sql`, its generated snapshot and
  journal entry, a dedicated real-upgrade test, and appended-migration handling in historical
  upgrade tests. No earlier migration, including 0070, was rewritten.

### Deviations, limits, and risks

- The repository `pnpm` launcher attempted to fetch `@pnpm/exe@11.22.0` from the configured
  unavailable private registry. No dependency or install-policy change was made. The same checked
  in configs were exercised with already-installed package-local binaries and temporary
  worktree-source aliases; all temporary configs were removed before staging.
- Full unrelated monorepo suites were not run. The complete affected contract/API/DB/OpenAPI/
  route/security/typecheck/lint/build/format/no-diff/diff gates above were run.
- No shared database or live object storage was used. Database tests created UUID-named scratch
  databases and dropped them; storage ambiguity and validation used controlled service boundaries.
  No browser, production deployment, mail, Windows, printer, scanner, 1C, DNS, or hardware check
  was in scope.

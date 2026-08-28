# Task 11 — Platform operator request and act UI

## Result

`apps/saas-admin` provides the internal Markiro operator counterpart for tenant billing requests.
`billing.read` protects the registry and detail; every comment, transition, link, offer, invoice,
revision, and act action requires `billing.write`. The list serializes the exact Task 6 filters.
Detail renders server status, responsible side, event and linked-object history, and only the
transitions returned by the API. A revoked or 403 authority becomes the existing non-actionable
forbidden surface.

Mutation-time authority loss is latched independently of cached principal data. A 403 from
request-bound offer creation, accepted-offer invoice creation, or act create/issue/reconcile
invalidates `platform/me` plus the scoped request/document authority and replaces the editor with a
read-only forbidden surface. No retry, resume, reconcile, or alternative write remains live. If an
act draft was already created, its id remains retained and visible read-only.

Request mutations retain one immutable `{ action, payload, idempotencyKey }` after an ambiguous
network/5xx result. While retained, all fields and alternate actions are frozen; only the exact
attempt can be retried. Terminal 4xx/409 results clear it and refetch server authority. Pending
actions lock synchronously against double clicks, and successful mutations invalidate the request
list family and exact detail.

Request-bound offer creation is now one server transaction:
`POST /platform/billing/requests/:id/offer`. The route body has no `tenantId`; the service locks the
request, derives its tenant, creates the draft and lines, links the draft, writes one request event
and one exact audit event, and commits one replayable result. A conflict rolls the whole transaction
back, so no orphan offer remains. The SaaS route reads `requestId` from the route, loads the request,
renders its tenant read-only, posts once, and navigates to the returned draft. Direct offer creation
is unchanged.

An ambiguous request-bound offer attempt is also a stateful immutable client operation. The first
POST freezes the exact offer lines, terms, and idempotency key. During a network/5xx outcome the
composer, catalogue picker, terms editor, add/remove controls, and alternative navigation are not
rendered as editable state. The operator can only repeat that exact retained attempt, with a
synchronous double-click lock, or decline the retry and return to the refetched request authority.
Terminal errors clear the retained attempt and refetch authority.

The request offer projection now follows the current family revision and reads the latest structured
decision for that revision. A real lifecycle test covers original `changes_requested` → revise →
publish current → accept current and proves `offerAction` points to the new revision with
`canCreateInvoice: true`. Revision controls remain server-authoritative.

Invoice creation from a request no longer trusts router state as acceptance authority. The
destination always refetches request detail on mount and waits for that response before loading the
offer or rendering the live composer. It requires matching `offerId`, `currentOfferId`,
`sourceOfferId`, `sourceRequestId`, and `canCreateInvoice`. Stale, crafted, or mismatched state is
non-actionable; request 403 invalidates principal authority and renders forbidden. Both source ids
survive draft prefill, edits, validation, and `toInvoiceCreateInput`; direct source-free invoice
creation is unchanged. Provenance remains a Task 2 relation, not a physical invoice column.

Act issue is an explicit two-phase state machine. Once create returns, the client persists the act
id and exact create/file/issue identity independently of issue outcome, freezes all fields and the
PDF, and never creates the draft again. Network/5xx and terminal service/period conflicts keep a
resumable exact issue attempt. The operator can resume or reconcile the saved draft; no deletion is
implied because the API has no such operation. Act list, exact act/document, and request families
are invalidated immediately after draft creation, including issue failure. Issued appears only from
issued API metadata. Only one non-empty PDF up to 5 MiB is accepted; private storage details are not
rendered.

Every act create, issue, and reconcile outcome invalidates the whole request registry family as
well as exact request/act/document keys, so registry `latestEvent` cannot stay stale. Reconciliation
to an issued act with a ready PDF resets the earlier ambiguous issue error before showing success;
the red failure and green issued states are never rendered together.

The platform request registry is bounded to the newest 100 requests before event selection. Its
second query uses PostgreSQL `DISTINCT ON (tenant_id, request_id)` with index-compatible reverse
ordering and exact `(created_at DESC, id DESC)` tie-breaking, tenant and returned-request filters,
and therefore materializes at most one latest event row for each returned request rather than full
event histories.

All new visible and accessibility copy is present in RU and EN. Existing SaaS-admin components and
tokens are reused; no tenant cabinet shell or new visual token layer was introduced.

## Contract-gap ruling

Task 6 owned the authoritative workflow but originally did not project `allowedTransitions` or
structured current-offer actionability. Task 11 added typed server projections instead of mirroring
workflow in the client. Review exposed a second gap: generic offer-create plus request-link could not
make a request-bound draft atomic or prevent client tenant trust. The smallest coherent correction
adds the strict request-owned endpoint and factors the existing offer-draft insert into a
transaction-aware helper shared by direct and request-bound creation. No schema, migration, invoice
provenance column, or privacy model changed.

## RED / GREEN

- **RED:** commercial contracts failed **1 of 21** because `billingRequests.createOffer` did not
  exist.
- **RED:** clean SaaS focused run passed **19 of 27** and failed the eight new authority/state cases:
  atomic request route, whole-surface mutation freeze, invoice authority/403, terminal act resume,
  and an existing provenance fixture that still entered through an unauthoritative offer action.
- **GREEN:** focused SaaS workflows pass **4 files / 28 tests**.
- **GREEN:** complete SaaS suite passes **25 files / 223 tests**. It emits two pre-existing React
  `act(...)` warnings in catalog tests.
- **GREEN:** platform contracts pass **9 files / 68 tests**.
- **GREEN:** isolated Postgres request service passes **1 file / 72 tests**. It creates a UUID-named
  scratch database, applies migrations, runs lifecycle/concurrency/rollback/audit proof, and drops
  the database.
- **GREEN:** API OpenAPI passes **1 file / 4 tests** and guarded route inventory passes **1 file / 4
  tests**.
- **Fix round 2 RED:** focused SaaS passed **20 of 29** and failed nine new mutation-403,
  immutable-offer, act invalidation, and reconcile-state cases. The isolated Postgres suite passed
  **72 of 73** and returned 101 registry requests, proving the missing bound before implementation.
- **Fix round 2 GREEN:** focused SaaS passes **3 files / 29 tests**. The complete SaaS suite passes
  **25 files / 230 tests**. The isolated Postgres service passes **1 file / 73 tests**; the new real
  query proof creates 101 requests, 44 historical events for the newest two, and a foreign-tenant
  event, then observes a 100-request result and exactly two rows materialized by the event query.

## Changed areas

- `packages/platform-contracts` — strict tenant-less atomic offer action and typed response.
- `apps/api/src/modules/platform-billing-requests` — current-revision projection and atomic
  request-bound offer transaction/controller, bounded registry, and one-row latest-event query.
- `apps/api/src/modules/platform-offers` — transaction-aware draft insertion shared with direct
  offer creation.
- request, invoice, offer, act, composer, routing, and RU/EN SaaS files — whole-surface retry freeze,
  locked request tenant, mutation-time forbidden latches, destination authority, exact provenance,
  immutable offer retry, and resumable act issue.
- focused contract, OpenAPI, real DB service, and SaaS tests.

## Verification

- PASS — latest fix-round SaaS focused Vitest: **3 files / 29 tests**.
- PASS — full SaaS Vitest with temporary alias directory excluded: **25 files / 230 tests**.
- PASS — SaaS source/test TypeScript no-emit, full ESLint, and production Vite build. The existing
  > 500-kB chunk advisory remains.
- PASS — platform-contracts Vitest **9 files / 68 tests**, typecheck, ESLint, and build.
- PASS — isolated Postgres API service **1 file / 73 tests**, no skips. The suite creates and drops
  its unique UUID-named scratch database.
- PASS — API OpenAPI **4/4** and guarded route inventory **4/4**. Loopback/database access used the
  approved local permission; inventory used localhost-only values for two missing optional `.env`
  URLs.
- PASS — API TypeScript no-emit, full ESLint, and Nest build with temporary current-worktree aliases.
- PASS — scoped Prettier, `git diff --check`, and final staged-diff review.

One unbounded SaaS Vitest attempt traversed `node_modules.shared`, so it was discarded as alias
noise. The valid full run explicitly excluded that temporary directory. All aliases were restored
before commit; no registry, manifest, or lockfile changed.

## Limits

No live browser, responsive screenshot, live object-storage flow, or external deployment was run.
Those remain Task 13 gates; DOM, contract, database, type, lint, and build evidence does not claim
visual or live-storage confirmation.

## Commit

The scoped fix commit SHA is reported in the handoff because a commit cannot contain its own SHA.

# Task 11 — Platform operator request and act UI

## Result

`apps/saas-admin` provides the internal Markiro operator counterpart for tenant billing requests.
`billing.read` protects the registry and detail; every comment, transition, link, offer, invoice,
revision, and act action requires `billing.write`. The list serializes the exact Task 6 filters.
Detail renders server status, responsible side, event and linked-object history, and only the
transitions returned by the API. A revoked or 403 authority becomes the existing non-actionable
forbidden surface.

Mutation-time authority loss is latched independently of cached principal data. A 403 from
direct or request-bound offer creation, accepted-offer invoice creation, or act
create/issue/reconcile
invalidates `platform/me` plus the scoped request/document authority and replaces the editor with a
read-only forbidden surface. No retry, resume, reconcile, or alternative write remains live. If an
act draft was already created, its id, number, and recovery status remain retained and visible
read-only. The offer latch remains visible even when the principal refetch confirms a real
admin-to-support downgrade.

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
keeps its existing path and payload contract.

An ambiguous request-bound offer attempt is also a stateful immutable client operation. The first
POST freezes the exact offer lines, terms, and idempotency key. During a network/5xx outcome the
composer, catalogue picker, terms editor, add/remove controls, and alternative navigation are not
rendered as editable state. Browser unload and app/sidebar route changes are guarded while the
attempt is pending or retained. The operator can only repeat that exact retained attempt, with a
synchronous double-click lock, or decline the retry and return to the refetched request authority.
Successful exact retry explicitly permits its result navigation; terminal errors clear the retained
attempt and refetch authority.

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

The act recovery workspace now remains mounted above the `billing.write` capability branch. A real
principal downgrade after create therefore cannot discard the retained act or its exact issue
attempt. The read-only forbidden view keeps navigation/unload guarded; when server authority later
restores `billing.write`, the same draft can be resumed or reconciled without a second create POST
or a new UUID.

Retained offer and act identities now use the shared navigation guard's non-discardable operation
state rather than its ordinary dirty-document state. Sidebar, in-app back links, and browser unload
remain blocked without exposing the generic discard action, so an operator cannot unmount and lose
the only retained idempotency key, act id, or PDF. Exact retry and authoritative reconciliation keep
the same operation identity; successful retry or reconciliation releases navigation. Ordinary
unsaved forms continue to use the existing discard confirmation contract.

The shared guard also clears an earlier discard/success allowance when either a new dirty form or a
new busy operation activates. This matters because `AppShell` and its guard provider persist across
child routes: a discard confirmed on one route can no longer authorize a later retained offer or act
route. The reset effect depends on both aggregate states, so it does not re-run and deadlock the same
explicitly allowed navigation while that activation remains unchanged.

Every act create, issue, and reconcile outcome invalidates the whole request registry family as
well as exact request/act/document keys, so registry `latestEvent` cannot stay stale. Reconciliation
to an issued act with a ready PDF resets the earlier ambiguous issue error before showing success;
the red failure and green issued states are never rendered together.

The platform request registry reads a 101-row sentinel window, returns at most the newest 100
requests, and includes the required typed `truncated` boolean. RU and EN surfaces warn when more
requests exist and tell the operator to narrow tenant/status/type filters; exactly 100 results set
`truncated: false`. Event selection remains after the request bound. Its second query uses
PostgreSQL `DISTINCT ON (tenant_id, request_id)` with index-compatible reverse ordering and exact
`(created_at DESC, id DESC)` tie-breaking, tenant and returned-request filters, and therefore
materializes at most one latest event row for each returned request rather than full histories.

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
- **Fix round 3 RED:** focused SaaS passed **24 of 30** and failed six new direct-offer authority,
  retained-navigation, durable act-recovery, and truncation-warning cases. The focused contract
  suite failed **1 of 22** because `truncated` was not part of the strict response. Strengthening
  offer tests with a real admin-to-support principal response then produced two additional expected
  RED failures before the latch was lifted above the route capability branch.
- **Fix round 3 GREEN:** focused SaaS passes **3 files / 30 tests**, complete SaaS passes **25 files /
  234 tests**, contracts pass **9 files / 69 tests**, and isolated Postgres service passes **1 file /
  73 tests**. The DB proof asserts 101 → 100 with `truncated: true`, exact 100 with
  `truncated: false`, two materialized latest-event rows, exact tie-break, and no foreign event.
- **Fix round 4 RED:** the retained-operation regression run passed **20 of 22** tests and failed the
  offer and act cases because both route attempts opened the generic discard dialog with an active
  `Отменить изменения` action.
- **Fix round 4 GREEN:** retained-operation tests pass **2 files / 22 tests**; the broader offer,
  act, request, and ordinary document-guard run passes **4 files / 39 tests**; complete SaaS passes
  **25 files / 234 tests**.
- **Fix round 5 RED:** the same-shell act regression passed **0 of 1** because an ordinary catalog
  discard left the provider allowance set; the later retained busy-only act navigated to Catalog
  instead of showing the busy guard and preserving its act identity.
- **Fix round 5 GREEN:** the same-shell regression passes **1 of 1**; navigation, ordinary dirty,
  retained offer, and retained act coverage passes **4 files / 65 tests**; complete SaaS passes
  **25 files / 235 tests**.

## Changed areas

- `packages/platform-contracts` — strict tenant-less atomic offer action and typed registry
  completeness response.
- `apps/api/src/modules/platform-billing-requests` — current-revision projection and atomic
  request-bound offer transaction/controller, bounded registry, and one-row latest-event query.
- `apps/api/src/modules/platform-offers` — transaction-aware draft insertion shared with direct
  offer creation.
- request, invoice, offer, act, composer, routing, navigation guard, and RU/EN SaaS files —
  whole-surface retry freeze, locked request tenant, mutation-time forbidden latches, destination
  authority, exact provenance, immutable offer retry, same-shell guard activation reset, durable act
  recovery, and resumable act issue.
- focused contract, OpenAPI, real DB service, and SaaS tests.

## Verification

- PASS — latest fix-round SaaS focused Vitest: **4 files / 65 tests**.
- PASS — full SaaS Vitest: **25 files / 235 tests**.
- PASS — SaaS source/test TypeScript no-emit, full ESLint, and production Vite build. The existing
  > 500-kB chunk advisory remains.
- PASS — platform-contracts Vitest **9 files / 69 tests**, typecheck, ESLint, and build.
- PASS — isolated Postgres API service **1 file / 73 tests**, no skips. The suite creates and drops
  its unique UUID-named scratch database.
- PASS — API OpenAPI **5/5** and guarded route inventory **4/4**. Loopback/database access used the
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

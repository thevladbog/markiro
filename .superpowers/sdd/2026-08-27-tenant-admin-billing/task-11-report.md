# Task 11 — Platform operator request and act UI

## Result

`apps/saas-admin` provides the internal Markiro operator counterpart for tenant billing requests.
`billing.read` protects the registry and detail; every comment, transition, link, offer, invoice,
revision, and act action requires `billing.write`. The list serializes the exact Task 6 filters.
Detail renders server status, responsible side, event and linked-object history, and only the
transitions returned by the API. A revoked or 403 authority becomes the existing non-actionable
forbidden surface.

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

## Changed areas

- `packages/platform-contracts` — strict tenant-less atomic offer action and typed response.
- `apps/api/src/modules/platform-billing-requests` — current-revision projection and atomic
  request-bound offer transaction/controller.
- `apps/api/src/modules/platform-offers` — transaction-aware draft insertion shared with direct
  offer creation.
- request, invoice, offer, act, composer, routing, and RU/EN SaaS files — whole-surface retry freeze,
  locked request tenant, destination authority, exact provenance, and resumable act issue.
- focused contract, OpenAPI, real DB service, and SaaS tests.

## Verification

- PASS — SaaS focused Vitest: **4 files / 28 tests**.
- PASS — full SaaS Vitest with temporary alias directory excluded: **25 files / 223 tests**.
- PASS — SaaS source/test TypeScript no-emit, full ESLint, and production Vite build. The existing
  >500-kB chunk advisory remains.
- PASS — platform-contracts Vitest **9 files / 68 tests**, typecheck, ESLint, and build.
- PASS — isolated Postgres API service **1 file / 72 tests**, no skips.
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

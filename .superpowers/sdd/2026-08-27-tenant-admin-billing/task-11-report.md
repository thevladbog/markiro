# Task 11 — Platform operator request and act UI

## Result

`apps/saas-admin` now has the internal Markiro operator counterpart for tenant
billing requests. The request registry serializes the Task 6 tenant, status,
and type filters, renders server status, responsible side, latest event, and a
linked-object detail history, and exposes only the transitions returned by the
server. `billing.read` guards inspection; every comment, transition, link,
offer, invoice, revision, and act control additionally requires
`billing.write`. A revoked or 403 request becomes the existing non-actionable
forbidden surface, while the API remains authoritative.

All synchronous actions lock while pending. Comment, status, link, revision,
and act issue attempts retain their immutable logical payload and UUID across
ambiguous network/5xx retries. Terminal 4xx/409 outcomes do not offer the same
retry and refetch the affected request authority. Successful mutations
invalidate the request family and exact detail rather than broad unrelated
queries.

The operator can create a tenant-prefilled offer from a request. The created
offer is linked back through the Task 6 request-link endpoint; an ambiguous link
retry reuses the returned offer id and exact idempotency key rather than
creating a second offer. Revision visibility comes exclusively from the new
server projection. A latest `changes_requested` decision on the current
published revision exposes `Create new version`, calls the revise endpoint,
and navigates to the returned new draft; the superseded offer is never edited
or republished in place.

Invoice creation from a request is visible only for the server-projected
accepted current offer. `sourceOfferId` and `sourceRequestId` now survive
`DocumentDraft`, `sourceOfferDraft`, editing/validation, and
`toInvoiceCreateInput`. Navigation without the accepted source marker is
rejected before the offer query runs. Direct invoice creation remains
source-free. Request provenance stays a Task 2 relationship and does not assume
a physical invoice column.

The act route collects number, civil period, tenant, request, invoice, and
ordered-service links plus exactly one PDF. The client rejects non-PDF, empty,
and over-5-MiB files before POST. Creation and issue are separate progress
phases; after a draft id is returned, retries reuse that id and the exact issue
key, so they cannot recreate the act. The UI shows issued only when the API
returns `status: issued`, `issuedAt`, and ready document metadata. It never
renders private storage keys or signed object details.

The pages use the existing SaaS-admin operational components, tokens, table,
forms, focus treatment, compact layout, and responsive breakpoints. All visible
and accessibility copy exists in RU and EN. No tenant cabinet shell was copied.

## Contract-gap ruling

Task 6 contained the authoritative request transition table and offer workflow,
but its response DTO did not project either decision to clients. Mirroring that
policy in Task 11 would have violated the approved server-authority rule. The
small coherent correction therefore adds typed `allowedTransitions` to request
list/detail and typed `offerAction` to detail. The service computes both from
the existing transition table, tenant-scoped offer family, current published
generation, latest structured tenant decision, and existing-draft state.

The list query also exposes the already supported request type as an exact typed
filter. Contract, service, and OpenAPI coverage accompany the correction; no
database or privacy model changed.

## RED / GREEN

- **RED:** the new SaaS-admin suites failed collection/render because the
  request and act pages did not exist. The source-provenance test then showed
  both source ids being dropped. Contract RED rejected the unknown
  `allowedTransitions`, followed by a second focused RED rejecting unknown
  `offerAction`.
- **GREEN:** focused SaaS-admin workflow plus composer regression passes **4
  files / 21 tests**. It covers read denial, exact filters, detail and
  server-returned transitions, accepted-only invoice action, immutable comment
  retry/double-click/invalidation, RU and EN, exact source preservation, direct
  invoice behavior, PDF/size validation, two-phase issue metadata, and issue
  retry without duplicate act creation.
- **GREEN:** platform commercial contract passes **1 file / 20 tests**.
- **GREEN:** API OpenAPI contract passes **1 file / 4 tests**, including its real
  Multer overflow case.
- **SKIP:** the request service file contains **69 database-backed tests**,
  including the new transition and offer-action projections, but the whole file
  skipped because this worktree had no isolated `DATABASE_URL`. No shared
  database was used or modified.

## Changed areas

- `apps/saas-admin/src/pages/billing-requests` — typed API, exact filters,
  registry/detail, server actions, retries, and scoped invalidation.
- `apps/saas-admin/src/pages/billing-acts` — typed create/issue API and private
  PDF issue workflow.
- offer and invoice pages plus document draft conversion — request linking,
  server-owned revision entry, and exact invoice source preservation.
- SaaS-admin routes, rail navigation, API FormData handling, operational CSS,
  and RU/EN dictionaries.
- platform commercial contracts and request service — minimal server-owned
  transition and offer-action projections plus type filtering.
- focused SaaS-admin, contract, service, and OpenAPI tests.

## Verification

- PASS — focused SaaS-admin Vitest: **4 files / 21 tests**.
- PASS — SaaS-admin source and test TypeScript no-emit.
- PASS — full SaaS-admin ESLint.
- PASS — SaaS-admin production Vite build; the existing >500-kB chunk advisory
  remains.
- PASS — platform-contracts focused Vitest: **1 file / 20 tests**.
- PASS — platform-contracts TypeScript no-emit and build.
- PASS — API OpenAPI Vitest: **1 file / 4 tests**. Its local ephemeral listener
  required the approved localhost test permission after the sandbox returned
  `EPERM`.
- PASS — API TypeScript no-emit, Nest build, and scoped ESLint after temporarily
  aliasing current-worktree contract/domain/db builds.
- PASS — RU/EN key parity, scoped Prettier, and `git diff --check`.

An attempted unbounded SaaS-admin run was stopped because Vitest traversed the
temporary `node_modules.shared` dependency alias as test source; focused tests
and the package gates above are the valid evidence. All temporary dependency
aliases were restored before commit, and no registry or lockfile changed.

## Limits

No live browser, responsive screenshot, live API/database, or object-storage
workflow was run. Those remain the Task 13 browser and live-storage gate; DOM,
contract, type, lint, and build results do not claim visual or external-system
confirmation.

## Commit

The scoped commit SHA is reported in the task handoff because a commit cannot
contain its own final SHA.

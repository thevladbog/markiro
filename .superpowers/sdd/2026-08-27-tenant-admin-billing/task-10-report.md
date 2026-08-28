# Task 10 — Tenant billing requests

## Result

The tenant admin now has real request list, create, and detail routes. A user
with `BILLING_READ` can inspect the registry and complete server-owned request
history; creating requests, retrying failed attachment uploads, and replying to
clarifications additionally require the existing `BILLING_REQUEST` boundary.
Server authorization remains authoritative.

The request form implements all five Task 5 request types and accepts the exact
form model `{ type, description, desiredAt, contextType, contextId, files }`.
It trims and validates descriptions, validates optional civil dates before
serializing them as API datetimes, rejects invalid URL context rather than
leaking it into the payload, and honestly preserves Task 8 capacity context.
Client attachment checks accept PDF, JPEG, PNG, and TXT up to 5 MiB; server errors
remain authoritative.

Creation is deterministic and two-phase. One immutable JSON payload and UUID
key are retained across ambiguous network/5xx retries. After the server returns
the real request id, files upload sequentially and independently. Per-file
results remain visible on the actual request detail route, failed files retry
against that same request, and neither an upload failure nor its retry can
recreate the request.

The detail route presents number, type, status, responsible side, desired and
created dates, validated context, description, linked billing objects,
attachments, and a compact oldest-to-newest event list. Event side, timestamp,
action, and body are textual rather than color-only or chat-shaped. Ready
attachments download only through the signed URL returned by the API and open
with `noopener,noreferrer`; in-progress and failed local upload states are
textual and storage keys/hashes are not rendered. The client DTO remains exact:
Task 5 exposes only `ready` persisted attachments in request detail.

Clarification replies appear only for `clarification_required` requests and
actors with `BILLING_REQUEST`. They use the exact trimmed 1–2000 bound, a
retry-stable immutable body/key, a synchronous double-submit lock, authoritative
refetch after terminal validation/conflict failures, and exact request-family
plus overview invalidation after success.

Task 9 offer success navigation was not changed: the Task 5 offer-decision
response has no real request id, so the implemented `/billing/documents`
destination remains the truthful route.

## RED / GREEN

- **RED:** before the pages existed, the two new request suites failed during
  import resolution for the missing list/create/detail modules; zero tests
  could collect.
- **GREEN:** bounded focused Vitest passes **3 files / 19 tests**, covering list
  loading/error/empty/filter/clear behavior; exact query serialization; all five
  types; invalid context and date; attachment type/size checks; exact immutable
  create and reply payload/key retries; synchronous double clicks; network/5xx
  versus terminal errors; sequential partial upload and failed-file recovery;
  signed-download success/failure; event order and textual authority; capability
  boundaries; exact invalidations; and live RU/EN rendering.
- **Broader billing regression:** nine files and **60 tests passed**. The existing
  `billing-routing.test.tsx` could not collect because Vite rejects the inherited
  parent-checkout IBM Plex Mono WOFF path before test execution, the same
  worktree filesystem limitation documented by Tasks 8 and 9.

## Changed areas

- `apps/admin/src/app.tsx` — replaces request placeholders with guarded real
  routes.
- `apps/admin/src/pages/billing/api.ts` — Task 4/5 request DTOs, list/detail
  hooks, create/upload/download/reply calls, query keys, and narrow invalidation.
- `requestForm.ts`, `RequestsPage.tsx`, `CreateRequestPage.tsx`, and
  `RequestDetailPage.tsx` — validation and request lifecycle UI.
- `billing.css` and `format.ts` — compact token-backed responsive composition
  and locale date-time formatting.
- RU/EN dictionaries — all visible and accessibility strings, including every
  request type, status, responsible side, attachment state, and event kind.
- `billing-requests.test.tsx` and `billing-request-detail.test.tsx` — focused
  contract and component regressions.

## Verification

- PASS — focused request plus i18n Vitest: 3 files / 19 tests.
- PASS — current-worktree admin TypeScript no-emit check. The temporary alias
  config used to avoid stale inherited shared-package declarations was removed.
- PASS — full admin ESLint: 0 errors; 5 pre-existing hook-dependency warnings in
  unrelated boxes/conflicts pages.
- PASS — admin production Vite build using a temporary current-worktree domain
  alias; the temporary config was removed. The existing large-chunk advisory
  remains.
- PASS — scoped Prettier and `git diff --check`.
- PASS — audit of the new request sources found no hard-coded Cyrillic visible
  or ARIA strings.

The initially attempted `pnpm exec` formatting command was stopped after two
bounded 30-second windows: it was trying to fetch unavailable
`@pnpm/exe@11.22.0` from the configured registry. The same checks were then run
successfully with already-installed local binaries; no watcher or development
server was left running.

## Limits

No live browser, responsive screenshot, live API, or object-storage/signed-URL
authorization workflow was run. Those remain the Task 13 browser/storage gate;
the automated DOM tests do not claim visual or external-system confirmation.

## Commit

The scoped commit SHA is reported in the task handoff because a commit cannot
contain its own final SHA.

## Fix Round 1 / 5

### Reviewer findings resolved

- Client validation and the file input now match Task 5 exactly: PDF, PNG,
  JPEG, and UTF-8 plain-text candidates are accepted up to the exact 5 MiB
  boundary. Content inspection and final authority remain server-side.
- Every local upload row uses an explicit `uploading`, `failed_retryable`, or
  `failed_terminal` state. Network and 5xx failures retain a retry; all known
  4xx failures, including content rejection, are terminal. A synchronous
  per-file lock prevents a rapid double click from issuing a duplicate POST,
  and retry controls are absent while uploading or after a terminal failure.
- Attachment retry controls require the actor's current `BILLING_REQUEST`
  capability. A route-state failure remains readable after capability
  revocation but exposes no mutation control; the handler also checks the
  capability before calling the API. Server authorization remains authoritative.
- Both initial uploads and retries retain the complete Task 5 attachment DTO.
  Successful rows are de-duplicated by server id into the exact detail cache,
  transient rows are removed, and an active authoritative refetch reconciles
  without duplicate display. The returned row is immediately downloadable
  through its own signed-URL lookup. No server attachment state or storage key
  was invented.
- Request-list errors distinguish non-retryable 403 and 404 responses from
  retryable network/5xx failures. Request creation distinguishes revoked 403,
  validation 400, idempotency/conflict 409, other terminal 4xx, and ambiguous
  network/5xx results. Only the ambiguous branch retains the immutable
  payload/key and a live retry action.

### RED / GREEN

- **RED:** the expanded two-file request run executed 29 tests: **12 failed and
  17 existing tests passed**. The failures were the missing TXT contract,
  list/create status classification, local upload state/capability handling,
  per-file synchronous lock, complete attachment reconciliation, and immediate
  signed download.
- **GREEN:** focused Task 10 plus i18n now passes **3 files / 33 tests**.
- **Broader billing:** overview, subscription, invoice, document, offer, Task 9
  request-boundary, Task 10 request, detail, and i18n suites pass **9 files / 76
  tests**. The separate routing file still cannot collect because Vite denies
  the inherited parent-checkout IBM Plex Mono WOFF path before test execution.

### Fix-round verification

- PASS — current-worktree admin TypeScript no-emit.
- PASS — full admin ESLint with 0 errors; the same 5 unrelated hook-dependency
  warnings remain in boxes/conflicts.
- PASS — admin production build; the existing large-chunk advisory remains.
- PASS — scoped Prettier and `git diff --check` after final review.
- Temporary TypeScript and Vite alias configs were removed. Existing untracked
  workspace `node_modules` symlinks were preserved and remain unstaged.

No browser, responsive screenshot, live API, or object-storage verification was
performed; Task 13 remains the browser and live-storage gate.

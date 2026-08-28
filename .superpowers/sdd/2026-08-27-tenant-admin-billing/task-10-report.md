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
Client attachment checks accept PDF, JPEG, and PNG up to 5 MiB; server errors
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

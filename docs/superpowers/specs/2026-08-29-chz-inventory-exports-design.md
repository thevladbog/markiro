# Chestny ZNAK Inventory Exports — Design Spec

**Date:** 2026-08-29

**Status:** Proposed for implementation

**Scope:** Ordering the six Chestny ZNAK code exports for an inventory over True API's
dispenser service, instead of the operator downloading them from the ЧЗ cabinet and
uploading six files by hand. Consuming the True API token for anything else — periodic
`cises/info` status refresh, warehouse balances — is a separate design.

## Background

The signer agent (PR #338 cloud half, PR #340 Windows app) already keeps a fresh 10-hour
True API Bearer token in `chz_api_tokens`, encrypted per tenant. Nothing consumes it yet:
`ChzCryptoService.decrypt` is not called anywhere in production, and `apps/api` has no
outbound HTTP client at all. This spec spends that token on the single most painful manual
step in inventory.

Today an inventory is prepared like this: the operator opens the ЧЗ cabinet, runs six
exports — one per code status (`EMITTED`, `INTRODUCED`, `APPLIED`, `RETIRED`,
`WRITTEN_OFF`, `DISAGGREGATION`) — downloads six files, and uploads each one into
`POST /inventories/:id/imports/:status`. Only when all six have parsed successfully can
the snapshot be fixed and the inventory started.

True API exposes the same exports through `POST dispenser/tasks` with
`reportId: FILTERED_CIS_REPORT`, filtered by participant INN, product group, status and
GTIN. The result is a CSV inside a ZIP. Ordering is asynchronous: create a task, poll it,
list its results, download. Limits that shape the design: **15 create-requests per
minute**, roughly **1000 tasks per day per product group**, and `periodicity` accepts only
`SINGLE` — the cloud has no recurring jobs, so scheduling is ours.

## Outcome

On the inventory preparation screen the operator presses **«Заказать из Честного Знака»**.
Six dispenser tasks are ordered, polled and downloaded in the background; each finished
export lands in `inventory_imports` exactly as if it had been uploaded by hand, and the
existing snapshot fixation works unchanged. Manual upload stays available as a fallback
and as the path for tenants without a signer agent.

Progress is per status. A status that fails does not roll back the five that succeeded:
the operator sees the error and retries just that one, which also avoids burning the daily
task quota on re-ordering exports that already arrived.

## Approach: reuse the file pipeline

The downloaded CSV is fed into the **existing** `InventoriesService.importEvidence` as a
synthesised file — that method already takes `{ originalName, mimeType, bytes: Buffer }`
and nothing else about it is browser-specific.

This is the load-bearing decision, so the reasoning is worth recording. The path from an
uploaded file to a fixed snapshot enforces its invariants in four independent layers: the
strict parser (`Фильтр(...)` line, a character-exact 35-column header), the S3 object key
template, sha256 idempotency, and — at fixation time — a **re-read and re-parse of the
object from S3** that compares sha256, filter status, GTIN and every row count against
what was stored. On top of that sits a composite foreign key guaranteeing a snapshot is
assembled only from successfully parsed imports.

Parsing the API response into rows directly would bypass the first layer while still
having to satisfy the fourth, leaving two code paths to one invariant — the kind of
divergence that fails silently months later. Writing exports to a separate table instead
of `inventory_imports` would mean duplicating the snapshot logic and weakening that
foreign key. Feeding the same pipe costs one adapter and changes no invariant.

The accepted cost: the parser's 8 MiB compressed limit now applies to API-ordered exports
too. An export larger than that fails with the existing `CHZ_INPUT_TOO_LARGE`, the same as
a manual upload would.

**Known unknown.** The parser compares the header character by character, and we cannot
verify from here whether the dispenser's CSV is byte-identical to the cabinet export
(almost certainly the same generator, but "almost" is not a guarantee). A single
normalising adapter sits between the download and `importEvidence` so any difference is
handled in one place, and the manual runbook carries a step that settles it against the
sandbox — the same treatment the signature-format question got.

## Prerequisite: the product group dictionary

`productGroupCode` is a **numeric** Chestny ZNAK code carried on the task, not inside
`params`. Today `products.product_group` is free text (up to 200 characters, no
validation), so it cannot supply that code — an operator may have typed «Молоко», `milk`,
or anything else.

A separate slice therefore lands first: a seeded reference table of Chestny ZNAK product
groups, with the product card's free-text field replaced by a select over it. That slice
has its own spec; this one assumes the code is available for the inventory's product and
treats its absence as a pre-flight failure.

## Components

New module `apps/api/src/modules/chz-exports/`:

- **`true-api.client.ts`** — the first outbound HTTP client in `apps/api`, modelled on
  `apps/api/src/integrations/dadata/dadata.client.ts`: injectable for tests, explicit
  timeouts, no internal retries (the job owns retry policy). Four operations: create a
  dispenser task, read task status, list result identifiers, download a result.
- **`chz-token.service.ts`** — `getActiveToken(tenantId)` returns the decrypted token plus
  the tenant's True API base URL, or a typed refusal. Reads `chz_api_tokens`, checks
  `expiresAt > now`, decrypts with its own `ChzCryptoService` instance (the same
  duplication `jobs.module.ts` already uses to avoid a circular import), and resolves the
  base URL from the channel's `environment` setting.
- **`chz-export-runner.service.ts`** — the state machine for one status: order → poll →
  download → unzip → normalise → hand to `importEvidence`.
- **`chz-exports.service.ts`** — enqueues the six runs, reads progress, retries a failed
  status, and performs the pre-flight checks.
- **`chz-export.controller.ts`** — cabinet endpoints, guarded like the rest of the
  inventory surface.

Untouched: `chz-import-parser.ts`, `chz-tabular-reader.ts`, `inventory-snapshot.service.ts`,
the `inventory_imports` schema, and the six-status requirement.

## Data model

One table, `chz_export_runs`, with one row per (inventory, status) — six per order:

- `id`, `tenantId`, `inventoryId`, `status` (the existing `inventory_chz_status` enum);
- `unique (tenant_id, inventory_id, status)` — a retry reuses the row rather than
  accumulating history, so the table stays one row per thing the operator can see;
- `state`: `queued` → `ordered` → `ready` → `imported`, or `failed`;
- `dispenserTaskId`, `resultId` — the ЧЗ-side identifiers, persisted so a restart resumes
  an in-flight order instead of paying for a new one;
- `orderedByUserId` — the operator who pressed the button (see below);
- `importId` — the resulting `inventory_imports` row, via a composite tenant-scoped
  foreign key;
- `errorCode`, `errorMessage`, `attempts`, `claimedAt`, `orderedAt`, `completedAt`,
  `createdAt` — `claimedAt` is the durable claim described under idempotency below;
- a check constraint mirroring `inventory_document_runs`, covering **every** state rather
  than only the terminal ones: `ordered` requires `dispenserTaskId`; `ready` requires both
  `dispenserTaskId` and `resultId`; `imported` requires `importId`; `failed` requires
  `errorCode`; and none of those columns is set in `queued`. Writing the constraint this
  way means a row can never sit in `ordered` with no task to poll — the state that would
  otherwise strand a run silently.

**Retry is one atomic transition, and it is subtractive.** Retrying a failed status resets
the row to `queued` and clears `dispenserTaskId`, `resultId`, `errorCode`, `errorMessage`
and `completedAt` in the same statement that flips `state`, so a crash cannot leave a
half-cleared row that the check constraint would reject or that would resume against a
stale ЧЗ task. `attempts` is deliberately **not** cleared — it is the record of how much
quota this status has already cost.

What a retry must not touch is the import history: `importEvidence` records parser
failures as append-only `inventory_imports` rows and snapshot selection accepts only
successful ones, so the failed attempts stay exactly where they are. Clearing `importId`
on retry is therefore safe — it points at the run's own successful import, and a failed
run has none.

## Job flow

Queue `run-chz-export`, payload `{ tenantId, inventoryId }` — **one job per order, not per
status** — plus a boot-time reconcile pass that re-enqueues orders left with a
non-terminal run.

The payload deliberately carries no user: the actor lives in
`chz_export_runs.orderedByUserId`, written when the runs are created. The boot-time
reconcile pass enqueues jobs with no HTTP request behind them, so a payload-carried actor
would be unavailable exactly when the work resumes; reading it from the row means a
restart, a retry and the original order all attribute the import to the same operator.
That matters because `inventory_imports.createdByUserId` is `NOT NULL` and references a
real user, and the inventory's creator is not necessarily the operator who pressed the
button. Retry preserves `orderedByUserId` — it is not among the fields a retry clears —
unless a different operator presses retry, in which case it is overwritten with theirs,
since they are the one who spent the quota.

The granularity is dictated by True API's per-method rate limits, which differ sharply:
creating a task allows 15 requests per minute, but **reading a task's status allows only
5**, while the batch results endpoint allows 12. Six statuses each polling their own task
every 15 seconds would be 24 requests per minute against a limit of 5 — the design would
fail on its own traffic. So the job advances the whole order: it creates whichever tasks
are still missing, then polls **all six at once** through `GET dispenser/results` with
`task_ids`, then downloads whatever has become available. At a 30-second cadence that is
two requests per minute.

The worker performs one pass per invocation and re-enqueues itself with `startAfter` when
any run is still unfinished, rather than sleeping inside the handler: a dispenser task can
take minutes, and holding a pg-boss worker for that long would starve the queue and lose
progress on restart. `startAfter` has no precedent in this repository — every existing
deferral is cron-driven — so it is introduced here deliberately.

Two independent caps, because two different things can fail forever:

- a per-order cap on **polling passes**, which turns a task that never completes into a
  failed run with a timeout code instead of an immortal job;
- a per-run cap on **task-creation attempts**, counted in `attempts`. Transient create
  failures — network errors, 5xx, or the 15-per-minute limit — leave the run in `queued`
  and are retried with backoff, so without a second cap a permanently failing create (a
  filter ЧЗ will never accept, an INN that stays rejected) would re-enqueue the job
  forever. On reaching the cap the run becomes `failed` with a stable error code, and only
  an explicit operator retry starts it again.

Idempotency has three layers, because losing a response is not the same as crashing.

- **`dispenserTaskId` prevents re-ordering an export we know about.** This matters because
  the daily quota per product group is finite.
- **A durable claim covers the window where we do not yet know.** If `POST
dispenser/tasks` succeeds but its response is lost — or two workers reach the same run
  at once — retrying blindly would create a second task that consumes quota and is linked
  to nothing. So the run is claimed in the database _before_ the request goes out: a
  conditional update that stamps `claimedAt` and increments `attempts` **only if the row
  is still `queued` and unclaimed**, which is what serialises two concurrent workers. The
  state stays `queued` — it becomes `ordered` only once `dispenserTaskId` is known, which
  is what keeps the check constraint above true at every instant. A claim that is stale
  (older than one poll cycle) with no `dispenserTaskId` is the ambiguous case, and it is
  resolved by **listing the participant's recent dispenser tasks and matching on the
  filter** rather than by issuing another create. Only when that finds no matching task is
  a new one ordered. True API exposes no client-supplied idempotency key on this endpoint,
  which is why the reconciliation step exists instead of a key.
- **sha256 idempotency inside `importEvidence`** prevents a duplicate import row if the
  worker dies between download and commit.

Both ambiguous cases — a lost create response, and two workers racing the same run — need
their own tests; neither is reachable through the happy path.

## Pre-flight checks

Four conditions are checked once, before any task is ordered, and reported together so the
operator fixes everything in one pass rather than discovering problems one status at a
time:

- the organization's INN is present and well-formed (`org_profiles.inn`) — reusing the
  actionable-error pattern already established for GIS MT document generation;
- the inventory's product has a Chestny ZNAK product group selected, which supplies the
  dispenser's `productGroupCode`;
- a signer agent is paired for the tenant;
- a non-expired token exists.

Until all four hold, the button is disabled with the reason shown.

## Error handling

Three classes, each visible per status:

- **Pre-flight** — the four conditions above. Never ordered, nothing to retry until the
  underlying data is fixed.
- **Transient** — network failure, 5xx, or the 15-per-minute create limit. Retried with
  backoff; the run stays in `queued` (before a task exists) or `ordered` (after one does),
  and the operator sees "in progress", not a failure. Bounded by the task-creation cap
  above, so "transient" cannot mean "forever".
- **Terminal** — ЧЗ rejected the filter, the task finished in an error state, the
  downloaded CSV failed the parser, or a transient failure exhausted its cap. The run
  becomes `failed` with the parser's own error code where applicable, and only an explicit
  retry re-orders it.

Every ordering, completion and failure is written to the existing integrations journal
under `channelType: "chestny_znak"`, so export activity sits in the same feed as token
refreshes. Token values never appear there.

## UI

On the inventory preparation page, beside the six existing upload zones: one **«Заказать
из Честного Знака»** button and, under each status, its run state — queued, ordered,
ready, or failed with the error text and a retry button. A finished run populates the same
import slot the manual upload does, so the snapshot step is identical either way and the
operator does not have to know which route a file took.

## Testing

- `true-api.client.ts` and the runner against a mock HTTP server: the full cycle (order →
  poll → download → import), partial success across the six statuses, an expired token, a
  rejected filter, a task that finishes in error, and resumption after a simulated restart
  with a persisted `dispenserTaskId`.
- The two ambiguous ordering cases, neither reachable from the happy path: a create whose
  response is lost (the task exists at ЧЗ, the row has no `dispenserTaskId`) must be
  reconciled to the existing task rather than ordering a second one; and two workers
  reaching the same `queued` run concurrently must produce exactly one task.
- Retry as a transition: a failed run reset to `queued` clears the ЧЗ identifiers and the
  error, keeps `attempts`, keeps the failed `inventory_imports` rows, and — with the
  check constraint in place — cannot land in a state that violates it.
- The task-creation cap: a create that fails permanently ends as `failed` with a stable
  code instead of re-enqueueing forever.
- Actor attribution: the import is created by `orderedByUserId`, preserved across a
  restart and across a retry by the same operator, and overwritten when a different
  operator retries.
- `chz-token.service.ts`: decryption round-trip, refusal when the encryption key is
  unconfigured, refusal when the stored token has expired.
- Cabinet endpoints: e2e following the existing inventory test setup, covering pre-flight
  refusals and per-status retry.
- The sandbox question — whether the dispenser CSV matches the cabinet export byte for
  byte — is settled by a step added to `docs/runbooks/signer-agent-manual-e2e.md`, since
  it needs a real tenant with a real product group.

## Out of scope

- Periodic `cises/info` status refresh for codes already in the system, and the
  tenant-wide "current status" table it would need. `inventory_snapshot_codes` cannot
  serve that purpose: its check constraint ties classification to the source row, and it
  has no temporal columns.
- Warehouse balances (`/warehouse/balance`, `participant_remains-gismt-*`).
- Ordering exports outside an inventory (a standalone "export codes" screen).
- Automatic ordering on inventory creation. The button is deliberate: ordering costs
  quota, and the operator chooses when the data should be current.
- Raising the 8 MiB export ceiling.

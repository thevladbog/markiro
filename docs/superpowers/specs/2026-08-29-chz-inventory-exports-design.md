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
- `importId` — the resulting `inventory_imports` row, via a composite tenant-scoped
  foreign key;
- `errorCode`, `errorMessage`, `attempts`, `orderedAt`, `completedAt`, `createdAt`;
- a check constraint mirroring `inventory_document_runs`: `imported` requires `importId`,
  `failed` requires `errorCode`, and neither is set in the earlier states.

## Job flow

Queue `run-chz-export`, payload `{ runId }` — the same shape as
`build-inventory-document-run`, including a boot-time reconcile pass that re-enqueues rows
left in a non-terminal state by a restart.

The worker performs **one step per invocation** and, when the dispenser task is still
being prepared, re-enqueues itself with `startAfter` (15 s, growing to 60 s) rather than
sleeping inside the handler. A dispenser task can take minutes; holding a pg-boss worker
for that long would starve the queue and lose progress on restart.

Idempotency has two layers. `dispenserTaskId` prevents ordering the same export twice —
which matters because the daily quota is finite. sha256 idempotency inside
`importEvidence` prevents a duplicate import row if the worker dies between download and
commit.

The import is attributed to the operator who pressed the button:
`inventory_imports.createdByUserId` is `NOT NULL` and references a real user, and ordering
is always operator-initiated, so no synthetic system actor is needed.

## Pre-flight checks

Four conditions are checked once, before any task is ordered, and reported together so the
operator fixes everything in one pass rather than discovering problems one status at a
time:

- the organization's INN is present and well-formed (`org_profiles.inn`) — reusing the
  actionable-error pattern already established for GIS MT document generation;
- the inventory's product has a product group (`products.product_group`), required as the
  dispenser's `productGroupCode`;
- a signer agent is paired for the tenant;
- a non-expired token exists.

Until all four hold, the button is disabled with the reason shown.

## Error handling

Three classes, each visible per status:

- **Pre-flight** — the four conditions above. Never ordered, nothing to retry until the
  underlying data is fixed.
- **Transient** — network failure, 5xx, or the 15-per-minute create limit. Retried with
  backoff; the run stays in `ordered` and the operator sees "in progress", not a failure.
- **Terminal** — ЧЗ rejected the filter, the task finished in an error state, or the
  downloaded CSV failed the parser. The run becomes `failed` with the parser's own error
  code where applicable, and only an explicit retry re-orders it.

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

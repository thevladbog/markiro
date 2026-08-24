# Inventory v1 — Technical Architecture Spec

**Date:** 2026-08-24

**Status:** Proposed for implementation; product flow and screen set are approved

**Scope:** Tenant-admin preparation and reconciliation, multi-station offline execution,
repacking, and downloadable result packages for one product per inventory

## Outcome

Inventory is a separate tenant-scoped aggregate. It consumes an immutable snapshot built
from uploaded Chestny ZNAK exports, accepts physical verification from several stations,
optionally rebuilds package aggregation, and freezes a revision from which downloadable
documents are generated. It is not represented as a synthetic production shift and its
scans do not claim ownership in the production `code_registry`.

This boundary is load-bearing: an inventory deliberately scans codes that already exist in
Markiro or were previously handled elsewhere. Routing those scans through the normal shift
ingest would turn expected verification into production duplicates and could mutate the
wrong box hierarchy.

## Confirmed v1 rules

- One inventory has exactly one tenant, product, GTIN, assigned line, execution mode, and
  inclusive production-date range.
- Chestny ZNAK API integration is outside v1. All six status results are supplied as files.
- `INTRODUCED` is the only expected status.
- Any `MOVING_BY_UD` code is protected regardless of its status: it is excluded from expected
  stock, write-off candidates, and every destructive document.
- `EMITTED`, `APPLIED`, `RETIRED`, `WRITTEN_OFF`, and `DISAGGREGATION` are retained for
  classification and audit but never become expected stock.
- Warehouse movements are assumed stopped from snapshot fixation through close.
- Admin creates, starts, closes, reopens, and completes inventory. Leaving a station task is
  only a per-terminal pause.
- A normal close requires all participants to leave after draining their local queues, no open
  repack boxes, and no unresolved required discrepancy. Emergency close records its reason and
  quarantines later events.
- Reopening a closed inventory invalidates generated artifacts. Completed inventory is
  immutable.
- No document is sent externally in v1.

## Verified input contract

The supplied XLSX and six ZIP examples share the same logical format:

1. physical row 1 is a quoted human-readable `Фильтр(...)` expression;
2. physical row 2 is the 35-column header beginning with `Код`, `GTIN`,
   `Родительская упаковка`, `Статус кода`, `Состояние кода`, and ending with
   `Разрешительные документы`;
3. following rows are codes, or the two-row empty-result marker `errors` plus
   `5: Коды маркировки не найдены`.

Supported containers are CSV, a ZIP containing exactly one CSV member, and XLSX with exactly
one relevant worksheet. The importer validates the filter status, included GTIN, packaging
type `UNIT`, headers, row widths, and data instead of trusting the upload slot selected by the
browser.

The verified example for GTIN `04680089900383` contains:

| Result                                       |  Rows |
| -------------------------------------------- | ----: |
| `INTRODUCED`                                 | 4,323 |
| protected `MOVING_BY_UD` inside `INTRODUCED` |   207 |
| expected stock                               | 4,116 |
| `EMITTED`                                    |   166 |
| `RETIRED`                                    | 1,868 |
| `WRITTEN_OFF`                                | 1,460 |
| `APPLIED`                                    |     0 |
| `DISAGGREGATION`                             |     0 |
| known parent SSCCs                           |    48 |
| units inside those parents                   |   288 |

An empty-result marker is a successful zero-row import only when the filter declares the
expected status and the marker matches the known no-results form. Other `errors` rows fail
closed and are shown to the administrator.

## System boundaries

### Reused unchanged

- `@markiro/domain` GS1 KM/GTIN/SSCC canonicalization and hashing.
- Station device identity, offline operator identity, hardware scan sources, sounds, printer
  transport, label rendering, and SSCC serial allocation.
- The station's monotonic outbox, payload-digest, retry, conflict, and recovery patterns.
- Tenant-admin capabilities `OPERATIONS_READ` and `OPERATIONS_WRITE` in v1.
- Object storage, verified SHA-256 publication, presigned downloads, pg-boss leases, and audit
  patterns from shift exports.
- Existing shift `Исключения → Расформировать короб`. Inventory does not add another shift
  disaggregation screen.

### New and isolated

- Inventory lifecycle, imports, immutable snapshots, claims, scan events, repack boxes,
  corrections, late-event quarantine, reconciliation, and document revisions.
- Dedicated station inventory bundle and sync endpoints.
- Dedicated SQLite mirrors and outboxes. Existing `codes_mirror`, `outbox`, `boxes_mirror`, and
  shift-close queues keep their current semantics.

### Reusable operation code

Repacking is reusable at the domain and UI boundaries, not by introducing a polymorphic owner
table in v1. A pure `repacking` module owns state transitions, capacity rules, one-date-per-box,
membership validation, and label payload construction. Inventory supplies the persistence and
authorization adapter now; a future standalone warehouse operation can supply another adapter
without copying the workflow or changing production-shift rows.

The status rule is also split into a reusable disposition policy:
`INTRODUCED && state !== MOVING_BY_UD` is the only code state eligible for a future sale or
write-off action. Inventory consumes it now for protection and document eligibility; wiring it
into the self-service kiosk is explicitly outside v1, but the rule must not be reimplemented in
the kiosk later.

## Lifecycle and revisions

The server owns every transition under a tenant-scoped row lock:

```text
draft -> preparing -> ready -> running -> closed -> completed
                            ^              |
                            |--------------|
                                 reopen
```

- `draft`: parameters may change and import slots are empty.
- `preparing`: upload attempts are append-only; the latest valid attempt for each status may be
  selected for preparation.
- `ready`: one immutable snapshot and task barcode are fixed. Parameters and selected imports
  cannot change.
- `running`: station bundles and sync are admitted.
- `closed`: the current `resultRevision` is frozen; document runs may be created.
- `completed`: no scan, correction, reopen, or regeneration is accepted.

Every accepted correction or reopen increments `resultRevision`. Document runs record the
closed revision they consumed. Reopen sets `invalidatedAt` on all artifacts from the older
revision before returning to `running`.

## PostgreSQL model

All business tables have `tenant_id`, a composite tenant foreign key where applicable, and a
tenant-scoped unique key for their public identifier.

### Preparation

`inventories`

- identity and immutable human number;
- `product_id`, `gtin14_snapshot`, `line_id`, `mode` (`check` or `repack`);
- `production_date_from`, `production_date_to` as inclusive dates;
- explicit tenant-scoped `box_label_template_id` for repack mode; the admin UI preselects the
  organization default but the user may replace it before the inventory starts;
- lifecycle status, active snapshot id, result revision, actors and timestamps;
- emergency-close reason/actor and completion acknowledgment.

`inventory_imports`

- append-only upload attempt with declared status;
- file name, container kind, byte size, SHA-256, private object key;
- status parsed from the filter, included GTIN, parse outcome, row/error/duplicate counts;
- sanitized error code and timestamps; raw code values never enter logs or audit metadata.

`inventory_snapshots` and `inventory_snapshot_inputs`

- immutable revision and combined digest;
- exact six selected import ids;
- per-status counts, protected count, expected count, package and loose counts;
- fixation actor and time.

`inventory_snapshot_codes`

- canonical raw KM, SHA-256 code hash, GTIN14, serial;
- source status, optional source state, source production date, parent SSCC;
- `expected` and `protected` booleans derived once during fixation;
- unique `(tenant_id, snapshot_id, code_hash)` and indexes for
  `(snapshot_id, parent_sscc)` and `(snapshot_id, expected, source_production_date)`.

Snapshot fixation fails when a data row has the wrong GTIN, an invalid KM, a filter/header
mismatch, an impossible date, a duplicate within one selected import, or the same code appears
in more than one selected status. An unprotected `INTRODUCED` row without a production date
cannot be classified against the required range and therefore blocks fixation. An `INTRODUCED`
row in `MOVING_BY_UD` remains protected even when that date is absent; protection is evaluated
before date eligibility and the row can never become expected stock.

### Execution

`inventory_device_participants`

- inventory, station device, operator, configured line, join method, joined/left/heartbeat
  timestamps, and last reported pending-event/open-box counts;
- a different-line join records barcode use and explicit confirmation.

`inventory_scan_batches`

- device-generated batch id, canonical payload digest, device, sequence ceiling, outcome;
- replay with the same digest returns the original result; same id with another digest is
  quarantined and rejected.

`inventory_scan_events`

- immutable client event id, device sequence, device/operator, scanned time;
- kind (`item`, `known_box`, `old_box`), normalized identity, active production date;
- snapshot revision, local verdict, authoritative verdict, and optional first-winning event;
- raw scanner payload is bounded and stored only where audit recovery requires it.

`inventory_code_results`

- one current projection row per physically found code;
- snapshot identity when known, first accepted event, winning terminal/time;
- observed production date, current classification, and optional repack box membership;
- a unique current claim on `(tenant_id, inventory_id, code_hash)` makes duplicates
  idempotent across terminals.

`inventory_repack_boxes` and `inventory_repack_items`

- old SSCC context, new SSCC, owner device, capacity, one production date;
- open/closed/invalidated state plus durable print state and sanitized failure code;
- item membership references the winning inventory result, not production `box_items`;
- a new SSCC is never recycled after print failure or correction.

`inventory_corrections`

- append-only admin/operator correction, reason, actor, target event/code/box;
- action (`void_scan`, `restore_scan`, `change_date`, `remove_item`, `invalidate_box`,
  `reprint`), before/after projection digest, and result revision.

`inventory_late_events`

- canonical payload and digest for a batch received after close/completion;
- device, received time, closed revision, reason, and resolution;
- it never updates result projections automatically.

### Reconciliation and files

`inventory_document_runs`

- closed result revision, selected generator ids and versions, queue status, attempt count,
  source snapshot time, completion/error, creator, and idempotency key.

`inventory_document_artifacts`

- generator id/version, part number, filename, MIME type, counts, byte size, SHA-256,
  object key, downloaded timestamp, and invalidated timestamp.

The same lease, upload verification, ambiguous-commit recovery, retry, presigned-download, and
audit strategy as `shift_exports` is reused. Inventory artifacts are not stored in
`shift_export_artifacts` because their source revision and eligibility rules differ.

## Expected-set and reconciliation rules

For a snapshot row:

```text
protected = sourceState == MOVING_BY_UD
expected = sourceStatus == INTRODUCED
           && productionDateFrom <= sourceProductionDate <= productionDateTo
           && !protected
```

Current result categories are deterministic:

| Condition                          | Result                                                     |
| ---------------------------------- | ---------------------------------------------------------- |
| expected and claimed               | verified current stock                                     |
| expected and not claimed at close  | write-off candidate                                        |
| protected and scanned              | protected found; no stock/write-off/destructive output     |
| known but not expected and scanned | ineligible found discrepancy                               |
| absent from snapshot and scanned   | unknown found discrepancy                                  |
| claim later voided                 | unresolved until corrected or explicitly accepted by admin |

`sourceProductionDate` remains immutable evidence from Chestny ZNAK. The station's active date
becomes `observedProductionDate`, which drives repack labels and result grouping. Changing it
does not rewrite the source snapshot or silently pull a code into the expected set. A mismatch
between source and observed dates is visible in reconciliation.

## Station offline model

### Task discovery and bundle

- Assigned-line tasks appear beside the existing shift selection without being shifts.
- A task barcode resolves the same inventory for a different-line station and requires a
  confirmation before joining.
- Initial bundle download is manifest plus bounded code pages. Pages are written under the
  snapshot id; the active pointer is published only after row count and digest verification.
  A partial download can never replace a usable local snapshot.
- The bundle includes product facts, mode, date range, parent SSCC membership, the exact selected
  box-label descriptor and spec, and a device SSCC block when repacking. Starting the inventory
  freezes that template for all new boxes and later reprints even if the organization default or
  source template changes.
- The same required selector is reused by inventory repacking, standalone repacking, and future
  scenarios that create a new box. It is hidden when no new box is created.

### Local tables

- `inventory_task_mirror`
- `inventory_snapshot_codes_mirror`
- `inventory_terminal_state`
- `inventory_code_results_mirror`
- `inventory_scan_events_mirror`
- `inventory_outbox`
- `inventory_repack_boxes_mirror`
- `inventory_repack_items_mirror`
- `inventory_conflicts_mirror`

The authoritative on-device DDL remains `packages/db/src/sqlite/migrations.ts`; Drizzle's
SQLite schema is updated in parallel and its parity tests must round-trip the new rows.

### Scan behavior

- Simple item scan claims one code.
- Simple known-box scan records one source event and expands its immutable snapshot membership
  into local item results; server sync performs the same deterministic expansion.
- Repack old-box scan selects source context only. Every bottle must still be scanned.
- Capacity closes and prints a new box automatically. There is no `Следующий короб` action.
- Active production date is stored per terminal and applies from the next accepted scan.
- A non-empty repack box cannot mix dates. Date change first requires closing the incomplete
  box with explicit confirmation or clearing it; an empty box changes immediately.
- Leaving with an open box preserves it and its owner. Another device cannot continue it.

The local UI may optimistically accept work while offline. Server conflict ordering is
deterministic by `scannedAt`, then device id, then event id. A losing repack membership marks
its new box `invalidated`; inventory cannot close normally until the physical contents are
corrected and the label is reprinted or the box is removed with a reason.

### Sync and live progress

Inventory uses a dedicated endpoint and payload. It does not widen `/station/scans`.

- drain size is bounded and a batch range is pinned across retries;
- request carries batch id, payload digest, events, repack closures, and terminal state;
- response distinguishes applied, already applied, duplicate/conflict, rejected, and
  quarantined records;
- a cursor-based progress endpoint returns claims/corrections from other terminals;
- loss of connectivity degrades live duplicate feedback but never drops durable local work;
- leave succeeds only after the local queue is empty and the server records zero pending work.

## Close, emergency close, reopen, and completion

Normal close evaluates one server snapshot under lock and returns machine-readable blockers:

- active participant or stale participant without a confirmed leave;
- participant-reported pending outbox work;
- open or invalidated repack box;
- unresolved unknown/ineligible/date/conflict discrepancy required by policy.

Emergency close stores all blockers and the administrator's reason. Any later batch is copied
to quarantine and acknowledged as quarantined, not retried forever.

Reopen invalidates document artifacts transactionally, increments `resultRevision`, and admits
new station events. A quarantined batch may only be replayed by reopening the whole operation;
there is no direct mutation of a closed result.

Completion requires a closed revision, no running document job, and explicit confirmation that
the required artifacts were downloaded and checked. Completion freezes the aggregate and its
quarantine decisions.

## Document generator boundary

The backend exposes a versioned descriptor catalog. A generator consumes only a frozen
`InventoryResultSource`; it cannot query mutable live tables during rendering. The source is
ordered deterministically by code hash/SSCC so retries are byte-stable.

The initial catalog is intended to grow to:

- aggregation XML for new boxes;
- disaggregation XML for old boxes;
- TXT/CSV write-off candidates;
- CSV current-stock codes;
- CSV final boxes;
- XLSX/CSV balances grouped by observed production date;
- a ZIP containing the selected artifacts plus a manifest of names, sizes, and SHA-256 values.

The existing GISMT aggregation renderer is extracted from `shift-exports.ts` and reused with
inventory repack boxes. Exact disaggregation XML, tabular columns, file names, signatures, and
retention remain a contract gate already recorded in the product brief. No implementation may
invent those formats. Until an approved fixture/XSD exists, the descriptor is not advertised
and the UI cannot select it.

## API surface

Tenant cabinet, guarded by tenant membership and operations capabilities:

- `GET /inventories`
- `POST /inventories`
- `GET /inventories/:id`
- `PATCH /inventories/:id` while editable
- `POST /inventories/:id/imports/:status`
- `POST /inventories/:id/snapshots`
- `POST /inventories/:id/start`
- `GET /inventories/:id/progress`
- `GET /inventories/:id/discrepancies`
- `POST /inventories/:id/corrections`
- `POST /inventories/:id/close`
- `POST /inventories/:id/emergency-close`
- `POST /inventories/:id/reopen`
- `POST /inventories/:id/complete`
- `GET /inventory-document-formats`
- `POST /inventories/:id/document-runs`
- `GET /inventories/:id/document-runs`
- `GET /inventory-document-runs/:runId/artifacts/:artifactId/download`
- `GET /inventories/:id/task-form`

Station, guarded by tenant and station-device identity:

- `GET /station/inventory-tasks`
- `POST /station/inventory-tasks/resolve-barcode`
- `POST /station/inventories/:id/join`
- `GET /station/inventories/:id/bundle/manifest`
- `GET /station/inventories/:id/bundle/codes`
- `POST /station/inventories/:id/events`
- `GET /station/inventories/:id/progress`
- `POST /station/inventories/:id/leave`

Every detail, mutation, download, and station query scopes by tenant in SQL. Cross-tenant
denial tests are mandatory; UUID possession is never authorization.

## Delivery slices

1. **Core and preparation:** domain policy/parser, PostgreSQL schema, import/snapshot APIs,
   lifecycle through `ready`, and tenant isolation.
2. **Station execution:** bundle staging, task entry, offline journals/sync, simple check,
   repack/printing, multi-terminal conflicts, pause/leave, and live progress.
3. **Reconciliation and files:** admin screens, corrections, close/reopen/complete, printable
   task form, result source, generator registry, approved document contracts, downloads, and ZIP.

Each slice has its own implementation plan. A slice cannot weaken the existing shift offline
or box semantics to make inventory fit.

## Acceptance boundaries

Automated acceptance covers parsing fixtures, status/date/protection policy, tenant denial,
snapshot immutability, multi-device idempotency, restart recovery, box/date invariants,
close blockers, quarantine, revision invalidation, deterministic artifacts, and API/OpenAPI
contracts.

Browser/gallery evidence covers approved 1024×768 and desktop admin states. It does not prove
Windows packaging, scanner HID/serial behavior, real printer output, label stock, or customer
acceptance. Those remain explicit physical gates.

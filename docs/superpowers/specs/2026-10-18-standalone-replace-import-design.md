# Replace standalone test data with cloud data

User authorized implementation on 2026-10-18. Preserve licenses, printers and
paired devices; make a verified backup before replacing existing business data.
The independent license-request statistics change has its own specification.

## Behavior

Keep the normal empty-site import unchanged. Add an explicit administrator-only
replacement mode to cloud catalog import. The administrator selects a catalog
and history from the same tenant/GLN, checks both files, and acknowledges that
all local business data and all stations' old queues will be removed. Stop work
on every station first. A station disconnected during replacement cannot learn
about it until reconnecting; already printed labels cannot be recalled.

Keep host identity/TLS, device IDs and keys/revocations, all office accounts and
credentials, licensing files and licensing clock/trial/extension state, backup
settings, update infrastructure, audit, and workstation hardware settings.
Replace local business catalogs, operators/badges/employees, shifts/facts,
packs/ownership, reports, imported history and business defaults. Keep physical
number counters at their established floors.
Retain organization identity and enforce the existing GLN check; do not reset
the license or change the licensed INN. Device line assignments are remapped by
matching normalized imported line names, otherwise cleared for reassignment.
The mandatory copy covers the host database and its existing backup metadata,
not devices' unsent queues. Synchronize facts that need retention before starting
replacement; explicit replacement discards the old device queues.

## Host transaction and backup

Extend CloudImportRequest with optional replacement `{ expectedRevision,
history }`, where history is the existing strict CloudHistoryManifest. Extend
summary with optional replacement `{ expectedRevision, datasetEpoch, backupFile }`.
The request revision is optional for dry-run; its result returns the checked
revision and null epoch/backup. Real replacement requires that exact revision.
Legacy requests and responses remain valid. Repeated importId returns its stored result even if
the dataset changed. Successful earlier imports are scoped to the current dataset
epoch; retained audit must not prevent another authorized replacement.

Dry-run validates catalog, manifest, source/GLN and quota, simulates replacement
in a rolled-back transaction and makes no backup or epoch change. A real request
requires the dry-run revision to remain current. Acquire BEGIN IMMEDIATE, recheck
administrator/current dataset, validate before destructive work, then make a
VACUUM INTO copy from another connection while the writer lock prevents business
changes. Use existing integrity/hash/manifest/identity backup machinery. Store
mandatory copies in a dedicated `backups/pre-import` directory, outside scheduled
clean/rotation; return its relative name and record its digest in audit. A failed
copy leaves the live data and epoch unchanged. Preserve every earlier copy.

Within the same transaction remove business rows with deferred FK checks, import
catalog, create the pending history batch, assign a new site.dataset_epoch UUID,
and write audit. Commit once. A failed import rolls back all business changes;
the verified backup stays. Keep counters at least above every previously issued
SSCC/shift number so physical test labels cannot be reissued. Replacing rows does
not authorize resetting physical number uniqueness.

A successful replacement supersedes the test dataset's old restoreEpoch and
facts-held marker; the new pending-history hold remains. Otherwise a completed
new history could stay blocked by an unrelated earlier test restore. Both old
markers are retained in the pre-import copy for recovery.

History parts use existing resumable staging/checksums and atomic completion.
Staging begins in the catalog replacement transaction, so production stays
blocked from replacement until complete. Cancel cannot silently enable production;
another explicit replacement or the existing stopped-service restore is needed.
The hold accepts only the history batch precreated with that replacement. Once
it is canceled, an ordinary upload of a different history manifest cannot release
the hold; it is refused with `replacement_history_canceled`.
After a client restart select the same history file to resume. Report success as
ready only after completion; expose the pre-import backup name before restart.

## Dataset fence

Add optional datasetEpoch to Hello (absent on databases never replaced), distinct
from restoreEpoch. Native client sends `X-Markiro-Dataset-Epoch` from its locally
persisted, process-loaded generation on authenticated calls. After replacement,
every business mutation requires the matching header; older clients remain
readable for recovery/update but cannot submit stale production. Recheck the
generation inside write transactions, including requests authenticated before
replacement. Close existing change streams on epoch change so idle connected
stations immediately reconnect and observe it.

Native reconciliation runs before publishing Online. On changed epoch freeze
local SQL mutations, network mutations and hardware starts; in one SQLite writer
transaction purge reference/business/journal/SSCC/outbox tables and persist the
epoch per host. Keep workstation_settings and pairing files. A separate retained
installation table stores epochs. Restart the application; old JS continuations
must never use the new generation. The process-loaded generation stays immutable
until restart. On local failure remain blocked and retry on next connection;
never acknowledge the new epoch before the purge commits. Do not invoke restore
reconciliation or replay its last-30-day queue.

## Verification

Tests cover dirty-site replacement, unchanged license/clock/accounts/devices,
line remapping, hardware retention, exact audit/backup readability, backup failure,
rollback, source mismatch, stale revision, idempotent retry and second replacement,
pending/canceled history holds, counters, missing/old epoch and in-flight writer,
SSE disconnect, native purge/restart/failure and prevention of late SQL writes.
Shared Rust/Zod fixtures must agree on additive contracts. Run affected Rust and
webview gates and relevant browser harness. Windows restart, real service ACLs,
printers and offline physical activity remain separate manual checks.

## Android host consumer

The handheld's host mode participates in the same dataset fence. Its pinned client
sends only the epoch loaded at process startup. A hello comparison runs before
restore/block reconciliation and before post-pairing bootstrap. A changed epoch
records a durable DATASET_RESET_PENDING recovery phase while retaining its paired
credential. The running process stays blocked; it never adopts the new header or
purges Room while callbacks can still write old task data.

The blocking screen closes the actual Android process after the pending marker
commits; the operator opens the app again. At fresh process initialization, before
ACTIVE, printer recovery or sync, one Room transaction clears business/reference
rows and queues, resets active tasks/feed cursors and operator hints, records the
epoch, and advances the recovery generation. Device identity, the encrypted key,
printer profiles/assignments, preferences and Room internals stay. Saved print
destinations belong to the discarded attempts and are cleared. A pre-import
backup's absent epoch takes the same reset path. An interrupted startup purge
rolls back and remains blocked. Cloud mode does not take this path.

Android uses heartbeat HTTP rather than the PC's SSE stream. A reset after a
successful hello leaves requests carrying the old process epoch; the host rejects
them inside their write transaction until the next heartbeat detects the change.
A UI recreation alone is insufficient to finish the pending reset.

# Station Sync & Shift Exit (06a) — Design Spec

**Date:** 2026-07-28
**Status:** Design approved (brainstorming); implementation plan pending
**Slice of:** roadmap plan 06 (aggregation & sync) — **06a is this slice**; SSCC, box/pallet flow, exceptions, cross-terminal duplicate adjudication and multi-terminal presence are later slices
**Related:** `docs/superpowers/specs/2026-07-26-station-scan-loop-design.md`, `docs/device-key-surface.md`, `docs/architecture.md`

## Problem

The station validates scans and writes them to a local SQLite journal, and **nothing ever leaves the device**. Every call `apps/station` makes is downward — the operator roster, the shift bundle, product lookups — plus shift create/open. There is no code path that sends a scan back (verified against `apps/station/src/lib/api-client.ts` call sites).

For a marking-compliance product that is the core loop still open: nothing can be exported to ГИС МТ, the code history and dashboard in plan 07 have no data to show, and a lost or reimaged device takes an entire shift's work with it.

This slice closes it: scans reach the server reliably and idempotently, the operator can see whether they have, and the operator can leave a shift — which today is impossible, `WorkScreen` has no exit at all.

## Scope decisions

1. **Sync and shift exit only.** Cross-terminal duplicate adjudication and the conflict screen are 06b: they need the sync as a foundation _and_ a server-side authority rule that does not exist yet. This slice's contract is narrow — the station delivers, the server stores what was delivered.
2. **Background and continuous during the shift**, not a single flush at the end. A device lost mid-shift then costs minutes of work rather than a whole shift, and a broken link surfaces while the operator is still standing there.
3. **Offline is a normal operating mode, not an alarm.** Sync never blocks scanning, never modally interrupts, and never gates a scan on the network. The station was built offline-first in 05a–05b and this slice must not walk that back.

## Device side: a separate outbox

Every scan enqueues one row in a new `outbox` table (`INTEGER PRIMARY KEY AUTOINCREMENT`) carrying everything the server needs: shift id, captured scanner payload, verdict, timestamp, and — when the scan was accepted — its lowercase SHA-256 code hash, GTIN and serial. The server derives the canonical GS1 payload from the captured value after verification. The drain reads in id order and acknowledges with a single `DELETE FROM outbox WHERE id <= ?`.

The representations are deliberately distinct. `raw` is acquisition evidence
after the scanner adapter's framing/decoding. `canonical_raw` removes only a
known leading AIM `]d2` identifier and transport-edge whitespace while
preserving literal GS separators and trailing AIs. `code_hash` is SHA-256 of
`01<gtin14>21<serial>`, so AIs 91/92/93 do not create a second physical-item
identity. The API reparses `canonical_raw`, recomputes all derived fields and
rejects disagreement; a device is never authoritative for those values.

**Why a separate table rather than marking the existing mirrors.** `codes_mirror` exists for offline duplicate detection and will be purged on a retention schedule in plan 09. If transport state lived in that table, retention could silently discard scans that were never delivered. Separating them means the mirror is governed by retention and the outbox only by server acknowledgement.

**Why not a high-water mark in `station_meta`.** It is the smaller change and its commit point is a single statement — but SQLite reuses rowids in ordinary tables after deletes, so once plan 09 purges the mirror a newly inserted row can receive an id _below_ the mark and never be sent. Silent, and invisible until an audit. `AUTOINCREMENT` on the outbox is monotonic for the life of the database and has no such failure.

**Single-statement acknowledgement is a hard requirement, not a preference.** `tauri-plugin-sql` opens SQLite through a connection pool and hands a possibly different connection to each call, so a multi-call `BEGIN`/`COMMIT` is not a transaction (documented at length in `apps/station/src/lib/journal.ts`). One statement is the only atomic unit available on the device. The outbox delete and the roster's slot flip are the same pattern.

**Ordering trade-off, stated rather than papered over.** The outbox insert is a third independent statement on the scan path, after the code row and the event row. If it fails, the scan is recorded locally but never queued. It is enqueued last and deliberately _throws_ on failure, so the scan queue's existing error path tells the operator rather than losing the scan quietly; enqueueing earlier would be worse, because the verdict is not final until the code insert has either succeeded or hit the duplicate constraint. A reconciliation pass belongs to plan 09 if this ever bites in practice.

## Drain loop

One drain at a time, serialized — the same discipline the scan queue and the roster refresh already use, for the same reason: two concurrent drains would send overlapping batches and race their acknowledgements.

- **Batch size 100 scans.** A device offline for a full shift holds thousands; 100 keeps a request below the API JSON-body ceiling even when every accepted KM is near the explicit raw-size bound, while successful batches still drain back-to-back.
- **Triggers:** a new scan enqueued, the browser `online` event, and a 15-second heartbeat as the safety net. Consecutive successful batches drain back-to-back with no delay — an offline device that reconnects catches up as fast as the link allows.
- **Backoff on failure:** exponential from 2s, doubling to a 60s cap, reset on the first success. Never a tight retry loop.
- **Leaving a shift does not stop the drain.** The queue belongs to the device, not to the shift.

## Server side: one batch, one transaction, one idempotency key

`POST /station/scans` accepts `{ batchId, items[] }`, where each item carries its own shift id — the device never has to group its queue, and a queue spanning two shifts syncs without special handling.

The server applies the whole batch **and** records the batch id in a new unpartitioned `sync_batches` table, inside a single Postgres transaction. A retried batch is a no-op in its entirety, and the response says so — the device treats "already applied" exactly like a fresh success and acknowledges its queue. Postgres gives real transactions here, so unlike the device this needs no per-row trickery.

**Why a batch key rather than per-row keys.** Neither target table can express row idempotency on its own. `scan_events` has no key at all. `codes` has `PRIMARY KEY (tenant_id, code_hash, scanned_at)` — `scanned_at` is in the key only because Postgres requires the partition key there, so it does not constrain a code to one row. A batch key sidesteps both and is one small unpartitioned table.

Every insert is tenant-scoped in the statement itself, mutations included, per the project-wide rule. Every shift id in a batch is validated against the caller's tenant.

**The route requires a station api-key.** `TenantGuard` still resolves the
tenant, but a browser session is rejected: the authenticated station id is
the authoritative terminal for scans, closures and exceptions, regardless of
any stale or forged terminal value in a queued payload. This is the station's
core job, so `docs/device-key-surface.md` keeps it in the device-key table and
the boundary is pinned by both positive device-key and negative session tests.

## Late data for a closed shift

A device offline all shift, reconnecting after the manager closed the shift in the cabinet, is not an edge case — it will happen.

**The server accepts it.** Those codes are already printed on physical product; refusing them does not undo that, it only loses the record. A new `shifts.late_data_at` timestamp records when late data _first_ arrived and is never overwritten afterwards, so the badge marks the shift rather than tracking the most recent straggler. The cabinet shows it, so a manager who has already reported on that shift finds out that its totals moved. The decision is theirs; the system's job is to not hide it.

## What the operator sees

The status bar has carried a hardcoded `Синхр.: 0` since 05a, waiting for exactly this.

- **Normal:** the pending count, quiet, ignorable. A number going up during an offline stretch is information, not a problem.
- **Warning:** when the queue is non-empty and nothing has synced successfully for 15 minutes. The signal is "the pipe is broken", not "we are busy" — 500 codes queued in two minutes is healthy, five codes stuck for an hour is not. On a device that has never synced at all there is no last-success time to measure from, so the clock starts at the oldest queued scan; otherwise a station that was offline from its very first scan would never warn.
- **Never** a modal, a full-screen alarm, or anything that competes with a scan verdict.

## Shift exit

`WorkScreen` gains an exit control returning to shift selection — closing the gap left open in 05b-3, where a scanner that died mid-shift produced an honest "no signal" alarm with no in-app remedy, because there was no way out of the shift at all.

Exit does not close the shift: closing stays a cabinet action (`POST /shifts/:id/close` is deliberately `SessionOnlyGuard`, decided in 05b-2 and documented in `docs/device-key-surface.md`). If the outbox is non-empty the operator is told what is still queued and may leave anyway — the drain continues regardless.

## Testing

- **Outbox:** enqueue on accepted, duplicate and rejected scans alike; drain in id order; acknowledgement removes exactly the acknowledged range; a failed batch leaves the queue intact.
- **Serialization:** two concurrent drain triggers produce one drain, proven by an interleaving test rather than by inspection — the roster's serialization test in `apps/station/test/mirror.test.ts` is the model.
- **Backoff:** doubling to the cap, reset on success.
- **Batch idempotency (e2e, real Postgres):** the same `batchId` applied twice yields one set of rows; a partially-failed batch leaves nothing behind.
- **Closed shift (e2e):** ingest into a closed shift succeeds and stamps the shift.
- **Device-key surface (e2e):** a station api-key can reach the ingest route; a positive regression test, mirroring the ones 05b-3 added for the routes the station depends on.
- **Alarm threshold:** the warning appears only on the stuck condition, not on a large healthy queue.
- Live hardware verification stays deferred to `docs/hardware-acceptance-checklist.md`.

## Out of scope

Cross-terminal duplicate adjudication and the conflict screen (06b); SSCC allocation, box and pallet flow (06c); exceptions — disassemble, replace, reprint, undo; multi-terminal presence; export to ГИС МТ and the dashboard (plan 07); retention and archiving of the device journal (plan 09).

**Recorded for 06b so it is not discovered late:** enforcing true one-row-per-code on the server is not possible with the current partitioning — a unique index on a partitioned table must include the partition key, and `scanned_at` is the partition key. Cross-terminal dedup will need a mechanism beyond a constraint, and that choice belongs to 06b's design rather than being improvised during implementation.

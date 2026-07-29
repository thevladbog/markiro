# Cross-Terminal Duplicates & Conflict Screen (06b) — Design Spec

**Date:** 2026-07-28
**Status:** Delivered — see `docs/superpowers/plans/2026-07-28-06b-cross-terminal.md` for the implementation plan and PR #26 for the shipped change.
**Slice of:** roadmap plan 06 (aggregation & sync). 06a delivered the sync; **06b is this slice**; aggregation (boxes, pallets, SSCC) and exceptions follow it
**Related:** `docs/superpowers/specs/2026-07-28-station-sync-design.md`, `docs/design-briefs/04-line-station.md`

## Problem

Duplicate detection on the station is device-local. `codes_mirror.code_hash` is a primary key on **that device**, and the shift bundle carries no index of codes, so a station has no way to learn what another terminal has accepted — and while offline it could not act on it anyway.

Two terminals on one line can therefore both accept the same physical item. The server stores both: `codes` has `PRIMARY KEY (tenant_id, code_hash, scanned_at)`, where `scanned_at` is in the key only because Postgres requires the partition key there, so it does not constrain a code to one row. Nothing detects the collision, nothing resolves it, and nobody is told.

Today that inflates a shift's totals. It becomes materially worse the moment aggregation lands: the same item would be recorded in two different boxes, so the physical world and the record would disagree in a shipping document. **That is why this slice comes before aggregation** — the boxes must be built on data that has an owner.

## Scope decisions

1. **Detect and resolve, do not prevent.** An offline station cannot know what its neighbour scanned, and shipping a shared code index to devices would grow with every scan of the shift while still failing exactly when the network is down. Prevention is a promise the architecture cannot keep.
2. **Warn online stations through the sync response.** The response to `POST /station/scans` already exists and the drain runs continuously, so a station with a network learns within seconds rather than at end of shift — while the operator can still physically find the item. No new endpoint, no polling.
3. **The earlier scan wins**, by `scanned_at` — the physical moment — not by arrival order. A station that was offline must not lose an item simply because its neighbour had a better link, and replaying the same data must produce the same answer.

## The registry is the authority

A new **unpartitioned** table `code_registry`, keyed `(tenant_id, code_hash)`, holds the scan that currently owns each code: its shift, terminal and `scanned_at`.

Ingest claims through it. A single statement both claims and resolves:

```sql
INSERT INTO code_registry (...) VALUES (...)
ON CONFLICT (tenant_id, code_hash) DO UPDATE SET ...
WHERE EXCLUDED.scanned_at < code_registry.scanned_at
RETURNING code_hash
```

A returned row means this scan owns the code; a row that does not come back lost to an earlier one. Because the update fires only for a strictly earlier `scanned_at`, the rule is enforced by the statement rather than by application ordering, and re-applying the same data cannot change the outcome.

**Why a registry rather than a constraint or a scan.** A unique index on a partitioned table must include the partition key, so `codes` cannot enforce one row per code — this was recorded during 06a. Searching `codes` per incoming item would put a partitioned-table lookup on the ingest hot path. The registry is one small row per code, probed by primary key.

The registry's identity is **tenant-wide, not shift-scoped**, matching the device mirror: a KM identifies one physical item, so the same code appearing in two shifts is also an error worth catching.

Learning _who_ the winner is takes a second statement — a bulk read of the registry for the batch's code hashes — so the cost is two statements per batch, not per code.

## Recording a conflict

`code_conflicts` records every losing scan: the code, the losing terminal and its `scanned_at`, the winning terminal and its `scanned_at`, both shifts, and whether a manager has reviewed it.

A row is written in both directions: when an incoming scan loses to the registry's holder, and when an incoming scan _displaces_ the holder — the displaced scan becomes the loser.

The whole ingest already runs inside one transaction guarded by `sync_batches`, so a retried batch is a no-op in its entirety and cannot duplicate conflict rows.

## What each side is told

**The station that is online** gets the conflicts for the codes in the batch it just sent, in the sync response.

**The station whose scan was displaced** does not: its batch was acknowledged long before, and re-opening an acknowledged batch would undo the delivery guarantee 06a rests on. The cabinet is the backstop for that case, and the spec says so rather than implying every operator is told.

**On the station this is not an alarm.** The operator was shown a green verdict for that scan minutes ago, and design brief 04's floor rule is that nothing competes with a scan verdict. So: a quiet count of codes claimed by another terminal, and a list — reachable, not thrown at them — showing the item's GTIN and serial, joined from `codes_mirror` (`conflicts_mirror` itself carries no raw field at all). That, not the raw code, is what actually lets a person find the physical item: a raw KM carries non-printable GS separators and cannot be matched by eye, while the GTIN and serial are what is printed in human-readable form under the DataMatrix.

**In the cabinet**, a per-shift conflict view: both terminals, both times, which won, and the ability to mark a conflict reviewed. This is what a manager needs before reporting a shift.

## Testing

- **The rule:** an earlier scan arriving second takes ownership; a later scan arriving second does not. Both directions produce a conflict row.
- **Idempotency:** replaying a batch changes neither ownership nor the number of conflict rows.
- **Order independence:** the same two scans applied in either arrival order end with the same owner.
- **Ingest cost:** the claim path adds no per-code query against the partitioned tables.
- **Station:** conflicts returned by sync raise a count and never interrupt a scan verdict.
- **Cabinet:** the view lists unresolved conflicts for a shift and marking one reviewed persists.
- Device-key surface: the ingest route stays reachable by a station api-key, with the positive regression test 06a established.

## Out of scope

Aggregation — boxes, pallets, SSCC — which this slice unblocks; exceptions (disassemble, replace, reprint, undo); multi-terminal presence in the status bar; export to ГИС МТ and the dashboard (plan 07).

**Recorded for plan 09:** `code_registry` grows one row per code ever accepted, unpartitioned, so it becomes as large as `codes` without sharing its retention story. Scoping it per shift would bound it but would stop catching the same item across shifts, which is a real error. Retention for it belongs with the rest of the retention work rather than being improvised here.

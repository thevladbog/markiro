# Station Exceptions: Undo, Clear, Reprint & Disassemble — Design Spec

**Date:** 2026-07-30
**Status:** Delivered 2026-07-31 (PR #35).
**Slice of:** roadmap plan 06 (aggregation & remaining shift flow). 06a delivered sync, 06b cross-terminal conflicts, 06c boxes & SSCC; **this slice is the "exceptions" quarter of what plan 06 called out as remaining** (disassemble/replace/reprint/undo) — pallets (06d) and cross-terminal presence are deliberately deferred, not part of this slice.
**Related:** `docs/superpowers/specs/2026-07-28-cross-terminal-duplicates-design.md` (the ownership registry this slice releases from), `docs/superpowers/specs/2026-07-29-aggregation-boxes-design.md` (the box/SSCC model this slice corrects into).

## Problem

Once a code is scanned, it permanently occupies its code hash on the device (`codes_mirror.code_hash` is a primary key) and, once synced, permanently owns that code tenant-wide in `code_registry` (06b) — there is no way to release it. Once a box closes, its row is immutable server-side except for the print-verification outcome fields — there is no way to reopen it, and no way to reprint its label on request.

This means an operator has **no in-app recovery** from the mistakes that come with real packing work: a mis-scan, a box packed for the wrong destination, a box closed before it should have been, a label that got torn or jammed in the printer. Today, any of these requires manual reconciliation outside the app. For a first client running real product on a real line, this is the first thing they will hit — before pallets, before deeper integrations.

## Scope decisions

1. **Four actions, not the whole "exceptions" bucket.** Plan 06 named disassemble/replace/reprint/undo. This slice ships **undo, clear, reprint, disassemble** — replacing one code with another inside an already-boxed item, without touching the rest of the box, is deferred (no client need identified yet, and it is a strictly harder variant of the same mechanics below).
2. **All four live on the station, operator-initiated, offline-capable.** The operator who made the mistake is standing in front of the terminal that made it; routing correction through the cabinet would make the common case (a mis-scan noticed within seconds) require a manager and a network connection neither may be available.
3. **Scoped to the current shift and the terminal's own boxes.** A box closed by another terminal, or in a shift that has since closed, is out of reach of these actions — that is cabinet/manager territory, a different problem this slice does not solve. Restricting scope this way also keeps every action clear of 06b's cross-terminal ownership machinery: nothing here ever needs to reason about a box it does not exclusively own.
4. **SSCC is retired, never reused, on disassembly.** GS1 SSCCs identify one physical logistics unit forever; reusing a number for different contents after disassembly would violate that and corrupt anything downstream that already saw the original code. A box disassembled and re-packed gets a brand-new SSCC through the existing one-statement `allocate()` path (06c) — no special-casing needed there.
5. **Reason required for reprint/disassemble; not for undo/clear.** Undo corrects a single mis-scan within seconds of it happening — friction there defeats the point. Clear also stays reasonless because the open box has no printed label or assigned SSCC yet. Reprinting and disassembling a closed box require a reason for the manager's audit trail.

## The four actions

- **Undo last scan** — removes the single most recently scanned item from the box currently being filled. Available only while it is still the last scan and the box is still open; a new scan or a box close both retire it. One tap, no reason, no confirmation.
- **Clear box** — empties every item from the box currently being filled, without closing it. The box stays open, empty, ready to be filled again. One confirmation, no reason (nothing has been printed or assigned a number yet, so the compliance stakes are lower than disassembly).
- **Reprint** — reprints a closed box's label unchanged: same SSCC, same data, in case the physical label was damaged or never printed. Reason required. No box or item state changes.
- **Disassemble** — retires a closed box entirely: every item it still owns is released, the box's SSCC is voided forever, and the box drops out of the "active" list. Reason and an explicit confirmation required (this is the one irreversible action here).

Undo and clear both need to make freed codes scannable again — see "Releasing a code" below. Reprint touches nothing.

## Data model

**Server (`packages/db/src/schema/platform.ts`):**

- `box_items.removed_at` (timestamp, nullable) — a new column, distinct from 06b's `displaced_at`. `displaced_at` means "lost the ownership race to another terminal"; `removed_at` means "the operator undid or cleared this on purpose." Keeping them separate matters for `contentsChangedAfterClose` (06c) and for any future reporting that needs to tell the two apart.
- `boxes.disassembled_at` (timestamp, nullable) — once set, the box is retired: excluded from "active" listings, its `sscc` never reissued. A box re-packed after disassembly is a new box row with a new `deviceBoxId` and a fresh SSCC, exactly like any other box.
- New table `box_exceptions` — the audit trail: `id`, `tenant_id`, `kind` (`undo` | `clear` | `disassemble` | `reprint`), `box_id`, `code_hash` (nullable — only `undo` targets a single code), `shift_id`, `terminal_id`, `operator_id`, `reason` (nullable — null for `undo` and `clear`), `occurred_at` (client-supplied), `recorded_at` (server `now()`). Every action writes a row here, including a no-op (see "Idempotency" below) — the ledger records that the attempt happened, not only that it changed something.

**Station (SQLite mirror):**

- `boxes_mirror.disassembled_at` — local mirror of the flag.
- New table `box_exceptions_mirror` (`id` AUTOINCREMENT, `kind`, `box_id`, `code_hash`, `shift_id`, `terminal_id`, `operator_id`, `reason`, `at`, `acked_at`) — read/sent/acked the same way `boxes_mirror`'s closed-but-unacked rows already are (06c). No new retry or offline machinery: this reuses the drain loop's existing read-unacked → send → mark-acked cycle.
- `codes_mirror`: undo and clear both `DELETE` the affected row(s) immediately, which is what makes the freed code hash scannable again on this device without waiting for a round trip.
- `scan_events_mirror`: undo appends a row with verdict `undone`, the same substitution pattern `recordScan` already uses for `duplicate`.

## Releasing a code

A code accepted once can never be rescanned — device-wide, forever — by design (06b's whole point). Undo and clear are a deliberate, explicit exception to that: an operator action that says "this was a mistake, this code is free again."

Locally this is immediate: the row leaves `codes_mirror` the moment the operator taps undo/clear, so a rescan is never mistaken for a duplicate. On the server it takes an explicit `DELETE FROM code_registry` scoped to `(tenant_id, code_hash, shift_id, terminal_id)` — i.e. it only ever releases a claim this exact scan still holds. If the code was displaced to another terminal in the meantime (06b), the `WHERE` matches nothing and the release is a harmless no-op — the code was never really "this device's" to release once displaced, and undo/clear must not reach into another terminal's claim.

## Sync protocol

`SyncBatchDto` gains one new field, alongside the existing `items` and `boxes`:

```
exceptions: Array<{
  kind: "undo" | "clear" | "disassemble" | "reprint";
  boxId: string;
  codeHash: string | null;   // only set for "undo"
  shiftId: string;
  terminalId: string | null;
  operatorId: string | null;
  reason: string | null;     // required for disassemble/reprint, null for undo/clear
  occurredAt: string;        // ISO
}>
```

Processed inside the same `applyBatch` transaction, **after** `items` and `boxes` — so an exception targeting an item or closure carried in the very same batch always applies to a row that already exists. A device can never enqueue an exception fact ahead of the scan it corrects: the fact is only ever created after the operator has already made the scan, so its mirror row is always inserted later and drained no earlier.

Application logic lives in a new narrow module next to `box-membership.ts` and `conflict-resolution.ts` (not inline in the already-large `station-scans.service.ts`):

- **`undo`**: release the code (see above), then `UPDATE box_items SET removed_at = now() WHERE box/codeHash match AND displaced_at IS NULL AND removed_at IS NULL`.
- **`clear`**: for every `box_items` row under `boxId` still active (`displaced_at IS NULL AND removed_at IS NULL`), release its code and set `removed_at`. Guarded by `boxes.closed_at IS NULL` — this only ever touches a box still open.
- **`disassemble`**: guarded by `boxes.closed_at IS NOT NULL AND disassembled_at IS NULL`; sets `boxes.disassembled_at = now()`, then does the same per-item release/removal as `clear`.
- **`reprint`**: writes only to `box_exceptions` — no other table changes.

Every kind, matched or not, writes its `box_exceptions` row — a no-op (box already disassembled, code already released elsewhere) is still a recorded attempt, never silently dropped, matching the "no-op is fine, never throw" pattern 06c's box-closure handling already established for exactly this class of redelivery/race.

## Station UI

- **Undo**: an inline action on the single most recent item shown for the currently open box. Disappears the instant a new scan happens or the box closes — strictly one level, no history stack.
- **Clear box**: a button on the currently-open-box view. One confirmation dialog, no reason field, then immediate local empty + a queued `clear` fact.
- **Reprint / Disassemble**: a new small panel — not appended to the already-large `WorkScreen.tsx` — listing this terminal's closed, not-yet-disassembled boxes for the current shift, most recent first. Each row offers both actions, each behind a mandatory reason; Disassemble adds a second confirmation ("this cannot be undone, the box's number is retired"). Reprint reuses the existing serialized print-job queue and, if print verification is enabled for the workstation, the existing `PrintVerification` flow — not a second, parallel path to the printer.

## Error handling and edge cases

- **Redelivery of any exception fact**: every server-side effect is scoped by current state (`displaced_at IS NULL`, `closed_at IS NULL`/`IS NOT NULL`, `disassembled_at IS NULL`) — a resend after a lost ack finds nothing left to do and no-ops cleanly.
- **A code displaced before its undo/clear syncs**: the release's `WHERE` clause matches nothing; the code stays with its new owner, as it should.
- **Reprint after the label template changed**: reprint renders the box's **current** template, not a snapshot of what was originally printed (none is kept) — the label may look different at the same SSCC. Accepted, not solved here.
- **Clear vs. close race on the same box**: impossible by construction — both actions run through the same terminal's single UI thread, so they cannot interleave with each other.
- **Undo vs. the next scan**: undo is processed through the same sequential scan-handling path as an ordinary scan, not a parallel fire-and-forget action, so it cannot interleave with scan N+1's own write.

## Testing

- Unit tests for the new exception-application module: a release only ever affects the calling scan's own claim; a redelivered exception of any kind is a no-op; `clear` never touches a closed box and `disassemble` never touches an open one.
- API e2e: one scenario per kind, plus a disassembled box's SSCC never reappearing in a later allocation.
- Station unit tests: local code release on undo/clear (alongside the existing `journal.ts` tests), the new mirror table's read/send/ack cycle (alongside the existing box-closure tests in `sync.ts`).
- Given this again touches the code-ownership registry (06b) and the box/SSCC model (06c), a final whole-branch review on the most capable available model, as both of those slices already required.

## Out of scope

Replacing one code for another inside a box without clearing it; pallets (06d); multi-terminal presence; export/dashboard (plan 07). Cross-shift or cross-terminal correction stays a cabinet/manager problem, not addressed here.

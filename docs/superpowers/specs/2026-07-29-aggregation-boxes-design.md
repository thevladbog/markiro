# Aggregation: Boxes & SSCC (06c) — Design Spec

**Date:** 2026-07-29
**Status:** Design approved (brainstorming); implementation plan pending
**Slice of:** roadmap plan 06 (aggregation & remaining shift flow). 06a delivered sync, 06b delivered cross-terminal ownership; **06c is this slice**; pallets (06d), exceptions and multi-terminal presence follow it
**Related:** `docs/superpowers/specs/2026-07-28-cross-terminal-duplicates-design.md`, `docs/superpowers/specs/2026-07-28-station-sync-design.md`, `docs/design-briefs/04-line-station.md`, `docs/hardware-acceptance-checklist.md`

## Problem

A station validates scans and delivers them to the server, and every code now has exactly one owner. But nothing groups those items into a physical unit. A plant ships transport packaging, and both «Честный знак» and the shipping paperwork are about boxes, not loose items.

The groundwork is already in place and unused: `shifts.mode` is `validation | aggregation`, `shifts.box_capacity` and `products.box_capacity` exist, `buildSscc` and `ssccSerialCapacity` have been in `packages/domain` since plan 01, and the label editor's field vocabulary already has `sscc` and `qty`.

What is missing is everything between: issuing a number an offline station may use, assembling a box, printing and verifying its label, and recording the hierarchy on the server.

## Scope decisions

1. **Boxes only.** Pallets aggregate boxes and are a second level on top of a finished first one; they are slice 06d. Boxes alone already produce shippable value.
2. **Scanning an SSCC is in scope only for print verification** (below), not for aggregation. Building a pallet by scanning box labels belongs to 06d, and so does the deferred AIM `]C1` handling for general SSCC recognition.
3. **Reprinting the box just closed is in scope.** A printer that jams is ordinary hardware behaviour, not an exception. The general exception set — disassemble, replace, undo, reprint an arbitrary box — remains out of scope.

## The number space

An SSCC is 18 digits: extension digit (1) + issuer prefix (9) + serial (7) + check digit (1). For a GS1 RUS member the issuer's registration number is **the first 9 digits of its GLN**, so the prefix is derived, never chosen: a separate "which prefix" setting could only ever be set wrong. `ssccSerialCapacity` then yields `10^7` — ten million serials per extension digit — so pool sizing does not have to scale with prefix length.

**The issuer may be the tenant or a counterparty.** A plant packing for an external client marks transport packaging with that client's numbers. `counterparties.gln` is already `NOT NULL`, so no new directory is needed.

**The shift picks the issuer explicitly**, defaulting to the tenant's own organisation. It is _not_ inferred from `shifts.counterparty_id`: that field answers "who is this for", while the issuer answers "whose numbers". Packing for a client under one's own SSCCs is both legal and common, and inferring one from the other would silently produce the wrong number — discovered at goods-in.

**The extension digit separates the two levels.** GS1 assigns it no meaning; it exists to multiply capacity, and the company chooses it. The common practice — 0 for boxes, 1 for pallets — is adopted here as a convention, so box and pallet serials never interleave and 06d can add a pallet counter without touching serials already issued for boxes.

**The counter is therefore keyed `(tenant, issuer prefix, extension digit)` — by the derived 9-digit prefix, not by the issuer's GLN.** The prefix is what defines the number space, and one GS1 member holds several GLNs that differ only in their location digits: `4601234000017` and `4601234000024` are the same member and share the prefix `460123400`. Keying by GLN would give them independent counters, each free to hand out serial 100, and `buildSscc` would turn both into the same SSCC — the collision this slice's one-statement allocation exists to prevent.

The starting serial belongs to the counter, not to a shift: it is edited on the organisation profile for the tenant's own numbers and on the counterparty card for a client's. Putting it on the shift would force re-entering it for every shift of the same client, with a fresh chance to get it wrong. Two issuers sharing a prefix therefore share one starting serial, which is correct — they share one number space.

The starting serial is what makes migration possible. A plant moving off another system that issued SSCCs **under the same prefix** must continue from where that system stopped, or it will re-issue numbers that already exist. Under a _different_ prefix the space is fresh and zero is fine. The two settings are therefore shown together, because the starting serial is meaningless without knowing which prefix it counts within.

If `gs1Prefixes` is populated and does not contain the 9 digits derived from the GLN, the data contradicts itself; the cabinet says so rather than silently proceeding.

## Allocation and the device pool

Blocks are allocated in **one statement** — `UPDATE ... SET next_serial = next_serial + N ... RETURNING` — never a read followed by a write. Two devices reading a counter before writing it will eventually receive overlapping ranges, and an overlapping SSCC range is indistinguishable from a duplicate box. Which device received which block is recorded: when a ten-million space starts to run low, the only way to find out where it went is to have written it down.

**A device holds pools, not a single range.** Each row is a half-open range with a cursor, keyed by issuer and extension digit; top-ups over time naturally produce several non-adjacent ranges. Burning a serial is one statement, because on the device `tauri-plugin-sql` opens SQLite through a pool and one statement is the only atomic unit.

**Top-ups arrive by two paths.** The shift bundle (`GET /shifts/:id/bundle`) carries a pool for that shift's issuer, which guarantees the device can close boxes for a client whose numbers it has never held. During the shift, the sync response carries further top-ups when the device reports its remaining count has fallen below a threshold — the same channel 06b uses for conflicts, so there is no new endpoint and no polling. The pool itself is independent of shifts: it persists across them and is never surrendered at shift close.

A block is sized so that a device losing its connection at the worst moment still finishes the shift: comfortably more than one shift's boxes, which with ten million serials per extension digit costs nothing. The threshold is set so a top-up arrives while a shift's worth of numbers still remains, rather than shortly before the last one is burned.

**The serial is assigned when the box closes, not when it opens.** Nothing needs the number before the label prints, and assigning at open would burn a serial on every box abandoned mid-shift.

**Exhaustion stops labelling, not the line.** Scanning continues and the open box accumulates past its capacity; only closing is blocked, and the status bar says plainly that a connection is needed. Offline is a normal operating mode; a station that stops accepting product because it ran out of numbers is a worse failure than a box that waits.

## Assembling a box

**Box membership is a column on the code row, not a join table.** `codes_mirror` gains a nullable `box_id`. The reason is not economy: accepting a scan already writes to three places with compensation if any of them fails, and a fourth write would widen that compensation surface. As a column, membership is part of the same insert and there is nothing extra to compensate.

`boxes_mirror` holds the box itself — local id, `sscc` (empty until close), shift, terminal, status, and the timestamps below. A row is created when a box opens, which happens once per `box_capacity` scans rather than once per scan.

**A box closes automatically at capacity, and manually at any time.** Automatic closing keeps the operator from counting; the manual button covers the end of a shift or a change of batch. Closing is one statement — set the serial and the closing time — followed by printing.

## Printing and verifying

**The application identifier `(00)` exists only in the emitter.** Storage and transmission are exactly 18 digits, which is what «Честный знак» and EDI expect and what `buildSscc`/`isValidSscc` already produce. Neither `boxes.sscc`, nor the API, nor the device mirror knows about the AI. The rule is worth stating because both mistakes are silent: storing `(00)…` gets the export rejected, and printing bare digits produces a barcode that scans as Code 128 but is not recognised as an SSCC by anything GS1-aware.

**A GS1-128 path is new work.** The emitters handle FNC1 carefully for DataMatrix — there is a detailed treatment of Zebra's `_1` escape and the literal-`_1D` trap in `zpl.ts` — but `code128` is emitted as a plain `^BC` with no subset switch and no FNC1. Both emitters need a GS1-128 path that encodes `00` + 18 digits with a leading FNC1, and it joins `docs/hardware-acceptance-checklist.md`: like `^BX` before it, this must be read off a real printer.

**Print verification is optional, per workstation.** A setting in `hardware_config` (alongside the printer target and language) turns on a prompt after printing: scan the label just produced. It catches a spent ribbon, a smudged head and the wrong template — the failures otherwise discovered at the recipient's goods-in.

This is the one place where the floor rule that nothing competes with a scan verdict is broken deliberately. The justification is that the box has just closed, the operator is physically at the printer, and the flow is already interrupted for taping. The prompt must therefore have exits: reprint when the scan does not match or does not read, and skip — recorded as skipped, so a manager can see it — when the scanner is disconnected or the label is physically ruined. A prompt with no exit stops the line.

Verification needs only enough SSCC parsing to compare: strip a leading AIM identifier and the `00` prefix, then compare the remaining 18 digits with the expected value. This narrow strip-and-compare is all that is in scope — recognising an arbitrary scan as an SSCC, and routing it through `classifyScan` on the AIM `]C1` prefix, is what 06d needs and what stays deferred.

**The box label needs its own template binding.** `shifts.label_template_id` and `products.default_label_template_id` are singular and carry the item label; a second binding selects the box template.

## What the server records

Box closure travels on the transport built in 06a: the outbox gains a second event kind carrying the local box id, the serial and the closing time. Membership does not travel separately — every scan already carries its box's local id, so the server assembles the contents itself. Ordering needs no special handling: scans enter the queue before the closure and the drain is strictly sequential.

`boxes` and `box_items` are the server-side record. `(tenant, sscc)` is unique **by index rather than by a check in code**, because two devices holding overlapping pools is precisely the situation nothing else would reveal.

A box row is created the moment its first item arrives, not when the closure event does. Items necessarily reach the server first — they were queued first — and a box that exists as soon as something claims membership needs no buffering and no out-of-order handling. The closure event then fills in the serial and the closing time. A box still carrying no serial is simply one whose closure has not arrived yet, which is also exactly what an open box on the device looks like.

## The phantom position

Each terminal assembles its own boxes, so two terminals on one line can both box what is physically one item — either the same item scanned twice, or two items carrying a duplicated KM, which happens.

06b already decided who owns the code: the earlier `scanned_at`, always. Aggregation follows ownership. **A box item whose code is owned by another scan is marked displaced — not deleted.** It stays for investigation; it does not count towards the box's contents. Deleting it would tidy away the only evidence of what happened, and this project has consistently preferred an honest record to a neat one.

The alternatives were considered and rejected. Letting both boxes claim the code defers a legal problem to the ГИС МТ export, where it is most expensive, and «Честный знак» aggregation requires one KM in exactly one box, so both can never be reported. Refusing to close a contested box cannot work offline: the conflict is only known after sync, long after the box was closed and labelled.

**A still-open box corrects itself.** 06b already returns the sender's own losses in the sync response, so the station removes the item, the counter on screen falls, and the operator scans one more. **A closed box cannot be corrected** — it is taped and labelled — so it ends one position short, and the cabinet shows that its contents changed after closing.

The marking happens where ownership is decided: at ingest, once ownership is claimed, and retroactively when a later batch displaces an owner already recorded. That is the same shape as 06b's `displacedIncumbents`.

## Groundwork for labour statistics

Data that is not captured cannot be recovered; reports built on captured data can be added at any time. This slice therefore records, and builds no report, view or aggregate.

One primitive is genuinely missing: **the operator never reaches the server.** `scan_events` carries `terminal_id`, `raw`, `verdict` and `scanned_at`, and the sync DTO carries the same, so no scan can be attributed to a person — even though PIN and badge sign-in landed in 05b-1 and the station knows exactly who is working.

- `scan_events.operator_id`, and a matching field in the sync DTO, **per scan rather than per batch**: a drained batch can span a handover, and a per-batch attribution would credit one person with another's work.
- The box carries `opened_at`, `closed_at` and `closed_by`.
- The print-verification marks double as a print-quality metric.

Nothing else is added, and that is deliberate. Box assembly time is `closed_at − opened_at`. Pace and idle time are differences between successive `scanned_at`. Error and rework rates come from `verdict`, which is already recorded for every scan including rejected ones. Columns or tables for these would be built before the shape of any report is known, and thrown away when it is.

Per-minute records of an identified employee's work are personal data. Their retention is decided with the rest of the retention story in plan 09, not improvised here.

## In the cabinet

A per-shift box list: serial, terminal, operator, item count, closing time, and a flag when contents changed after closing. Settings for the issuer, the extension digit and the starting serial, on the organisation profile and on the counterparty card.

Both routes are cabinet-only. `TenantGuard` accepts a station api-key, so every route here also carries `SessionOnlyGuard`, with the negative regression test 05b-3 established.

## Testing

- **Allocation:** concurrent allocations never overlap; a block is issued by one statement; the recorded holder matches what was issued.
- **The pool:** burning is one statement; a device with several non-adjacent ranges burns them in order; a top-up in the shift bundle makes a previously unheld issuer usable; exhaustion blocks closing and leaves scanning working.
- **The serial:** assigned at close, not at open; an abandoned box burns nothing.
- **Idempotency:** replaying a batch changes neither box contents nor the number of boxes.
- **The phantom:** an earlier scan arriving second marks the later box's item displaced; an open box drops it and a closed one is flagged; contents exclude displaced items.
- **The label:** the emitted GS1-128 carries FNC1 and `00`; stored and transmitted values are 18 digits with no AI.
- **Verification:** a matching scan clears the prompt; a mismatch offers reprint; skipping is recorded.
- **Device-key surface:** the cabinet's box routes reject a station api-key; the station's own routes still work.

## Out of scope

Pallets, SSCC scanning for aggregation and the AIM `]C1` treatment (06d). Exceptions — disassemble, replace, undo, reprint an arbitrary box. Multi-terminal presence. Export to ГИС МТ and the dashboard (plan 07). Reports over the statistics groundwork laid here.

**Recorded for plan 09:** per-operator scan timing is personal data and needs a retention decision alongside `code_registry` and the code tables.

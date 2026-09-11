# Handheld (TSD) duplicate DataMatrix printing — design spec

**Date:** 2026-09-11

**Status:** Approved in brainstorming on 2026-09-11. Ships in two parts. The
DataMatrix encoder came first
([plan](../plans/2026-09-11-handheld-datamatrix-encoder.md)) and is done; the
duplicate flow this document describes is next. See "Prerequisite" below for
why it was split.

**Scope:** Sixth implementation slice of design brief 10
(`docs/design-briefs/10-tsd-handheld.md`), after the foundation
(`2026-09-10-handheld-foundation-design.md`, #473), shift validation
(`2026-09-10-handheld-shift-validation-design.md`, #479), the inventory check
(`2026-09-10-handheld-inventory-check-design.md`, #485), printing
(`2026-09-10-handheld-printing-design.md`, #491) and box aggregation
(`2026-09-10-handheld-aggregation-boxes-design.md`, #502): the handheld prints
a duplicate DataMatrix for each accepted unit under the
`validation-dm-duplicate-v1` policy, which it refuses outright today.

## Why this slice

Every other refusal the handheld carries is a degradation — something works
worse. This one is absolute: a shift whose validation policy prints a
duplicate cannot be entered at all, so the device is useless for that tenant's
line. The device advertises
`HANDHELD_CAPABILITIES = "handheld-v1,subscription-state-v1,station-recovery-v1"`,
from which `validation-dm-duplicate-v1` is deliberately absent; the server
answers `409 STATION_UPDATE_REQUIRED`, and `ShiftRepository` turns that into
`EnterResult.UpdateRequired` and the screen «На ТСД печать дубликатов пока
недоступна. Используйте станцию или измените политику смены в кабинете.» That
is where it ends today. The refusal lifts when, and only when,
`validation-dm-duplicate-v1` joins that capability string — everything below is
what has to be true before it does.

## Outcome

An operator enters a shift whose validation policy prints a duplicate. Each
accepted unit becomes a job: the duplicate is rendered from the policy's
template snapshot, printed, and — when the policy says `required` — the
operator scans the printed sticker back, which proves the copy is readable.
The cabinet sees the same event stream a station produces, because it is the
same protocol.

## Decisions

| Decision           | Choice                                                                                                           | Why                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server changes     | None. `productLabelEvents` is already a field of `POST /station/scans` and `productLabelReceipt` of its response | The handheld is a peer terminal; a second protocol would double the server surface                                                                                            |
| Verification       | Both policies, `none` and `required`                                                                             | Supporting only one leaves the refusal half-lifted, and the verification path is where the value is: a printed code nobody scanned back may be unreadable                     |
| Printer kind       | Any. No Bluetooth-only restriction                                                                               | Owner's call on 2026-09-11: some lines stand the handheld beside a network printer and work it like a station                                                                 |
| Shift mode         | Validation only                                                                                                  | The station's own recovery gate refuses a non-validation shift (`PRODUCT_LABEL_CONTEXT_MISSING`), so this slice does not meet box aggregation at all                          |
| Label bytes        | Prepared once and **replayed**, never re-rendered                                                                | The printed DataMatrix must match the digest that verification compares. This is the opposite of the box label, and the root `AGENTS.md` states both rules side by side       |
| Credential scoping | None. No `credential_ownership` column anywhere                                                                  | Revoking a handheld wipes its database (`DeviceWipe.wipeAll`), so jobs cannot outlive the credential that made them. The station keeps its jobs across a re-pair; this cannot |
| Device storage     | Two tables plus the existing outbox pattern, not the station's five                                              | Room gives a real transaction, so `product_label_accept_commands` and its trigger go; only one attempt is ever live, so `product_label_attempts` folds into the job row       |
| One job at a time  | A scan arriving while a job is unresolved is refused by name                                                     | The operator has a sticker in hand. Accepting the next unit first would leave two labels and no way to tell which belongs to which                                            |
| Full-screen states | Only `failed_before_send`, `delivery_unknown` and a rejected verification                                        | A duplicate prints on **every** unit, not every twentieth. A full-screen state per scan would be unusable                                                                     |
| Unknown delivery   | Resolved by scanning the printed sticker, under either policy; a reprint is the fallback                         | The domain accepts `verified` from `delivery_unknown` even when verification is `none`, and that answers the operator's real question: did a label come out?                  |

## Prerequisite: the Data Matrix encoder — done

Found while planning, after this design was approved, and large enough that it
shipped on its own. **This part is complete**; what follows records why it was
needed and what it settled, because both shape the flow below.

Until then, both handheld emitters refused every barcode format except
`code128` — a box label needs no Data Matrix, so none had been ported — while a
duplicate is nothing but a Data Matrix. `core/barcode` now renders one for the
`km.code` field, and both emitters carry the branch that sends it.

It is a **raster** rather than a native printer command, and that was not
incidental: TSPL's own `DMATRIX` has no way to carry the FNC1 flag, so a
natively printed symbol would be a plain Data Matrix rather than a GS1 one — a
wrong code on a product. ZPL's `^BXN` does carry FNC1, but a duplicate
template's `sizeMm` is the whole symbol square, and converting that to a module
size requires knowing the symbol's dimensions, which requires encoding it
anyway. Both roads led to the same place, which is why the station rasterizes
too.

The raster path was already there — `convertToMonochrome`, `bitmapToZplHex`,
`buildGfaCommand`, `buildBitmapCommand` — so only "marking code → module grid"
had to be built. ZXing supplies the parts that are identical for every Data
Matrix and easy to get subtly wrong (the symbol-size table, Reed–Solomon,
module placement); the GS1 codeword framing — FNC1 first, FNC1 for every AI
separator — is ours, because no library provides it.

Two consequences the flow below inherits. For this element, and only this one, a
template's `sizeMm` is the whole symbol square rather than a module width. And
the encoder is **not byte-pinned to `packages/domain`**, which encodes through
bwip-js: nothing ever compares one device's label bytes with another's, since
the server stores a digest of each device's own bytes and verification compares
the scanned payload. The contract is that the printed symbol decodes to the
right GS1 payload, which its tests prove by decoding it.

## Why no server work

`apps/api/src/modules/station-scans/dto.ts` already carries
`productLabelEvents` on the request (capped at `MAX_PRODUCT_LABEL_EVENTS`) and
`productLabelReceipt` on the response, and
`apps/api/src/modules/station-scans/product-label-events.ts` already applies
them with per-event `accepted` / `quarantined` outcomes. The policy, its
template snapshot and the snapshot's digest already reach the device in the
shift bundle. Nothing on the server is missing; the handheld simply refuses.

## What is ported verbatim

These are not negotiable, because the server validates the same values.

**The event vocabulary and its projection.** `prepared`, `sending`, `sent`,
`failed_before_send`, `delivery_unknown`, `verified` (carrying
`scannedPayloadDigest`) and `verification_rejected`. From a job's event
sequence the domain derives `attemptState`, `status`
(`prepared → sending → awaiting_verification → completed | attention`) and
`verificationOutcome` (`not_required | pending | verified`). The Kotlin port of
`applyProductLabelEvent` is pinned by fixtures — the fifth such set, after the
code parser, the inventory classifier, the label emitters and the box label's
fields.

`canApplyProductLabelEvent` is strict, and every one of its rules is a device
requirement rather than a server detail:

- **`sequence` must be exactly `latestSequence + 1`** per job. Events are
  written and queued in order; a gap is rejected, so the outbox may not reorder
  them.
- **A `verified` job is frozen.** No further event applies — `completed` is
  terminal, and a reprint after it is impossible by construction.
- **A reprint replays the same bytes, and the domain enforces it**: a second
  `prepared` must carry the same `bytesDigest`, `language` and `dpi` as the
  first, a new `attemptId`, `attemptNo + 1` and a non-null reason. A job whose
  printer no longer matches can therefore never be reprinted — which is exactly
  why the language/dpi check happens **before** sending, as
  `failed_before_send / printer_changed`.
- **A reprint is only possible from a settled attempt** — `sent`,
  `failed_before_send` or `delivery_unknown`. Not while one is `prepared` or
  `sending`.
- **`verified` is only accepted when `scannedPayloadDigest` equals the job's
  `payloadDigest`.** A mismatch is not representable as a verification; it must
  be emitted as `verification_rejected`. `compareDuplicateKm` decides which of
  the two the device sends, and the domain refuses to let it lie.

**The template snapshot digest.** The policy carries `{ id, name, spec,
digest }` and `productLabelValueDigest` must reproduce the digest. It pins the
exact template revision a printed label was made from, so a template edited
mid-shift cannot silently change what a later reprint puts on paper.

**The comparison used for verification.** `compareDuplicateKm` compares the
**full raw code including every separator and the whole crypto tail**, not the
identity hash the scan loop uses to detect duplicates. These are two different
functions over the same scan, and confusing them would accept a different unit
of the same product as a valid verification.

## What is reshaped for this device

**No credential scoping.** Revoking a device wipes its database, so a job cannot
outlive the credential that created it. The station's `credential_ownership`
column, its `ownershipConflict` flag and every query predicate over them
collapse to nothing here.

That argument is only as good as the wipe, and the wipe is **not** automatic:
`DeviceWipe.wipeAll()` names one `clear()` per DAO, so a table nobody adds to
that list survives revocation and re-pairing silently. Both new tables must join
it, and a test must assert that a wipe leaves no job and no event behind —
otherwise the honest design is the station's ownership predicates, not this one.
The list already runs inside `db.withTransaction`, so adding to it stays
all-or-nothing; a wipe interrupted partway leaves the previous state, and the
next one starts over.

**Two tables, not five.** The station keeps `product_label_accept_commands`,
`product_label_jobs`, `product_label_attempts`, `product_label_events` and
`product_label_outbox`. The handheld keeps `product_label_jobs` — one row per
accepted unit, carrying the prepared bytes, their digest and the whole
projection — and `product_label_events`, with queueing reusing the pattern the
inventory slice already established (`InventoryEventEntity` +
`InventoryOutboxEntity`).

Two of the station's five drop out for reasons specific to this device.
`product_label_accept_commands` and its SQLite trigger exist to make acceptance
atomic where a transaction cannot span calls; Room gives a real transaction, the
same reason the SSCC pool's single-statement burn did not carry over.
`product_label_attempts` drops out because **only one attempt is ever live** —
the domain refuses a new `prepared` while one is `prepared` or `sending` — and
`ProductLabelProjection` already carries `attemptId`, `attemptNo`, `bytesDigest`,
`language` and `dpi` for it. Past attempts are not lost: every one of their
events is in `product_label_events`, which is also what the server sees.
`attemptId` and `attemptNo` remain required wire fields and are stored on the job
row, not invented at send time.

**Simple retention, in two steps.** The bytes and the rows have different
lifetimes, because they answer different questions.

- **The bytes go at shift close**, for every job in that shift regardless of
  status. They exist only so a reprint can replay them, and a reprint into a
  closed shift is not a thing. This is what bounds the disk.
- **The rows go when the server has them** — a job whose events are all
  acknowledged, in a closed shift, is deleted along with its events.

An unresolved job therefore survives shift close as a record and is still
reported, but stops costing disk. The station's seven `NOT EXISTS` guards are
mostly about ownership conflicts and its separate receipts table, and do not
carry over.

## The scan loop

A scan in such a shift is accepted first — code row, journal entry, outbox row,
exactly as today — and the job is created in the same transaction.

1. **Prepare.** Render the duplicate from the policy's snapshot at the selected
   printer's language and dpi; store the bytes and their digest. The handheld's
   printer record already carries both (`language`, `dpi` ∈ {203, 300}), so
   `printer_unconfigured` means no printer is selected at all — and that is
   caught **before the first unit is accepted**, not halfway through a shift.
2. **Send.** `sending` → `sent` or `delivery_unknown`. The same transport and
   the same rule as the box label: an unknown outcome never resends by itself.
3. **Verify**, when the policy is `required`. The next scan is read as the
   verification. Equal to `payloadDigest` → `verified`; `mismatch` or `invalid`
   → `verification_rejected`, and the operator is told which — a different code,
   or one that would not read.

**A rejected verification does not settle anything.** It leaves `attemptState`
and `verificationOutcome` untouched, so the job stays outstanding: the operator
either scans again or reprints with a reason.

**An unknown delivery can be resolved by scanning the sticker**, under **either**
policy. The domain accepts `verified` from `delivery_unknown` even when
verification is `none`, and the job completes. This is the useful answer to "the
label may or may not have come out": look at the printer, and if a sticker is
there, scan it. That is the primary recovery, and a reprint is the fallback when
nothing came out. A `none`-policy job in `delivery_unknown` therefore offers a
verification scan it would never otherwise ask for.

**One job at a time.** A unit scanned while a job is unresolved is refused with
its own verdict and told what is outstanding. It is not silently dropped: the
operator is holding a sticker that has to be dealt with.

### What the next trigger pull means

The whole slice turns on this, so it is a table rather than prose. The device
routes every scan by the open job's status before anything else looks at it.

| Open job                          | The scan is              | Why                                                                     |
| --------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| none, or the last one `completed` | a new unit               | the ordinary path                                                       |
| `prepared` or `sending`           | refused — «идёт печать»  | an attempt is in flight; nothing the operator scans now can be acted on |
| `awaiting_verification`           | the verification         | policy `required`, the sticker is in hand                               |
| `delivery_unknown`                | the verification         | under either policy — a scan is how "did it print?" gets answered       |
| `failed_before_send`              | refused — reprint or fix | nothing was printed, so there is nothing to verify                      |

## Recovery, reprint, retention

**A job caught in `sending`** when the app died becomes `delivery_unknown` with
`interrupted` at startup, and the device **never** picks the send back up. The
same rule and the same reason as a box label caught mid-print: resuming would
be an automatic resend, and a second sticker for a unit the server has already
accepted is exactly what nobody can untangle afterwards.

The device is obliged to emit that event rather than merely leaving the row
alone. The domain accepts only `sent` or `delivery_unknown` out of `sending`, so
a job left in `sending` across a restart would be frozen: no reprint (a settled
attempt is required), no verification, nothing.

From `delivery_unknown` there is exactly one recovery, and it is the same one
the routing table and the screens describe: the operator looks at the printer
and scans the sticker if it came out, which the domain accepts as `verified`
under either policy. A reprint is the fallback for when nothing came out.

**A reprint carries a reason** — `not_printed`, `damaged` or `lost` — and the
contract requires it: only `attemptNo == 1` may have a null reason. The cabinet
distinguishes a label that never came out from one that was ruined, so the
reason is a product fact rather than decoration. It replays the same bytes on
the same language and dpi, because nothing else is accepted.

**Retention exists because of the bytes.** Keeping every unit's label for a
whole shift grows without bound on a device with a fixed disk.

**Closing a shift with an outstanding job warns and closes**, the same rule the
aggregation slice took for the deferred-label queue: the operator is told what
is unresolved, the shift closes, and the job's events still sync. Blocking a
shift close on a printer would stop a line over a sticker.

**A quarantined receipt is not a delivery.** The server answers per event and
may quarantine one with a code. That has to stay visible rather than being
lost between "sent" and "done".

## Screens

Brief 10 does not draw this, so the shape is decided here.

**The normal path is quiet.** A duplicate prints on every unit. The last-scan
zone already carries the verdict, and the duplicate's progress lives in the
same zone — «печатаем», then the ordinary «ПРИНЯТО». Nothing takes over the
screen.

**Full-screen only where a person must decide**: `failed_before_send` with the
printer's own reason, `delivery_unknown`, and a rejected verification. The first
two are `status == "attention"`; the third leaves the job outstanding. Those are
the three where the line has stopped anyway.

The `delivery_unknown` screen leads with the scan, not the reprint: «посмотрите
на принтер — если этикетка вышла, отсканируйте её», with reprint underneath.
Under a `none` policy that is the only place a verification scan is ever
offered, so the screen has to say what the trigger pull will do.

**Under `required`, the main zone must say that the next trigger pull is a
verification**, not a new unit. Without that the operator scans the next
product, is told it is the wrong code, and has no idea why. The drawn last-scan
zone — 40 % of the height — is where that state belongs.

**Reprint** is a list of the three reasons. **No new signals**: a rejected
verification means to the operator what an error means — that scan did not
count, do it again — and should sound the same.

Both languages on every screen; a missing translation is a lint error.

## Testing

A fifth set of fixtures exported from `packages/domain`: the event projection
(sequence → `attemptState`, `status`, `verificationOutcome`), vectors for
`compareDuplicateKm` covering `match`, `mismatch` and `invalid`, and the
template snapshot digest. As with SSCC, disagreement is not tolerable — the
server validates the same events.

- **One job at a time.** A second unit scanned while a job is unresolved is
  refused, not accepted.
- **`printer_changed`.** The printer's language or dpi changed between prepare
  and send; nothing is sent.
- **An interrupted send** reads as `delivery_unknown` at startup rather than
  resuming.
- **An unknown delivery completes on a verification scan** — including under a
  `none` policy, where that is the only verification the device ever performs.
- **Verification compares the full raw code**, not the identity hash — a direct
  test that the two are different functions.
- **A rejected verification settles nothing**: the job is still outstanding and
  both a retry scan and a reprint remain available.
- **Sequence is contiguous.** An event queued out of order is rejected rather
  than sent, so the outbox drains a job's events in order.
- **A completed job is frozen** — no reprint, no further event.
- **A reprint replays the same bytes** and is refused while an attempt is
  `prepared` or `sending`.
- **A quarantined receipt** does not read as a delivery.
- **Shift close drops the bytes but keeps an unacknowledged job**, and the job's
  events still reach the server afterwards.
- **A revoked device keeps no job and no event.** This is what the whole "no
  credential scoping" decision rests on, so it is asserted directly against
  `DeviceWipe.wipeAll()` rather than assumed, including a wipe with an
  unresolved job and unsent events, followed by a re-pair.
- **Migration v5 → v6** driven directly over a seeded database, not through
  Room, which would build the schema from the entities and never run it.
- Robolectric over the screens in both languages.

**A manual emulator walk-through is required.** The printing slice found four
defects that way and the aggregation slice six, and in both the worst were in
the seam between screens and states. This slice has more states per unit than
the box ever had.

## Out of scope

- Pallets (server-side work, plan 06d), exceptions (slice C), ad-hoc shift
  creation.
- Aggregation shifts: duplicate printing is a validation-mode policy.
- Any server change.

## Risks and open points

- **Whether the printed DataMatrix actually reads.** That is precisely what
  verification checks, and an emulator cannot answer it: a stand-in scan
  exercises the state machine, not the print quality. Only a real printer and a
  real scanner settle it, and the pull request must say so plainly.
- **Throughput.** A duplicate per unit means a print per unit, and under
  `required` a second trigger pull per unit as well. Whether that pace suits a
  real line is not something this slice can establish.
- **Bluetooth on hardware.** Still unverifiable on an emulator.
- **The retention horizon.** Purging on shift close is the rule; whether a
  long shift on a small device fills up before that is a question for the first
  real deployment.

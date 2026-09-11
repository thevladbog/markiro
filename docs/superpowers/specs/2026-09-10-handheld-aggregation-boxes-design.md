# Handheld (TSD) aggregation — boxes — design spec

**Date:** 2026-09-10

**Status:** Implemented in https://github.com/thevladbog/markiro/pull/502 (2026-09-11).
Automated gates green. The emulator walk-through was run and found six defects,
listed under «Risks and open points»; the last of them is why a full box could
sit refusing to close.

**Scope:** Fifth implementation slice of design brief 10
(`docs/design-briefs/10-tsd-handheld.md`), after the foundation
(`2026-09-10-handheld-foundation-design.md`, #473), shift validation
(`2026-09-10-handheld-shift-validation-design.md`, #479), the inventory check
(`2026-09-10-handheld-inventory-check-design.md`, #485) and printing
(`2026-09-10-handheld-printing-design.md`, #491): the handheld packs boxes.
It enters an aggregation shift, fills a box, closes it with an SSCC from its
own pool, prints the box label, recovers from every way that print can fail,
and reports the closures in the batch the station already uses.

## Decomposition

What was originally raised as one slice — «агрегация: закрытие короба,
перепечатка, этикетки единиц и паллет, очередь отложенных этикеток» — is four
independent pieces. Only the first is in this spec.

| Slice                    | What it delivers                                                                                   | Depends on |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ---------- |
| **A. Boxes (this spec)** | Aggregation shifts, box fill and close, SSCC pool, box label, print recovery, deferred-label queue | #491       |
| B. Pallets               | Pallet strip, pallet close, pallet label                                                           | A          |
| C. Exceptions            | Disassemble a box, replace a unit, reprint, undo the last action                                   | A          |
| D. Duplicate DataMatrix  | Unit-label printing in validation mode, lifting the `validation-dm-duplicate-v1` refusal           | #491       |

Ad-hoc shift creation («Новая смена», deferred out of the validation slice
because it configures box capacity and pallets) lands after A and B, when
there is something to configure.

## Outcome

An operator on a handheld enters a shift the cabinet created in aggregation
mode — which the app refused outright before this slice — and scans units into
a box. The
fill grid shows how full it is. On the last unit the box closes itself: the
device burns one serial from its own pool, builds the SSCC, renders the box
label and prints it. About a second later the next box starts.

When the printer is not configured or does not answer, the box still closes
and still gets its SSCC; the label goes to a queue. The line does not stop.
The queue is visible on the hub and in the shift header, survives leaving and
closing the shift, and belongs to the device rather than to the shift.

The cabinet sees these boxes exactly as it sees a station's.

## Decisions

| Decision             | Choice                                                                                                                                            | Why                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server changes       | None. `POST /station/scans` already accepts `items[].boxId` and `boxes[]`; the shift bundle already carries `boxLabelTemplate` and the SSCC block | The handheld is a peer terminal of a shift; a second protocol would double the server surface and the cabinet's cases                                                   |
| No printer           | Warn, but let the operator in. Boxes close, SSCCs are assigned, labels queue                                                                      | A dead printer must not stop a line. The boxes are already reported and identified; the physical label is a debt the operator can see and settle                        |
| Dry SSCC pool        | The box stays open and is not closed. Refetching the bundle tops the pool up when there is network                                                | An SSCC is the box's identity, not an attachment: unlike a label it cannot be deferred. `allocateForBundle` hands out a new block once the old one is fully consumed    |
| Serial burn point    | At close, never at open                                                                                                                           | An empty box closed by mistake, and a box abandoned at shift end, then cost nothing                                                                                     |
| Deferred-label queue | Owned by the device, not the shift. Survives leave and close                                                                                      | Blocking a shift close on a broken printer strands the operator at end of day, and the boxes are already on the server                                                  |
| Queue storage        | The queue is a query over boxes whose print is unresolved, not its own table                                                                      | A second source of truth for print state is exactly where it diverges from the first                                                                                    |
| Label bytes          | Re-rendered at print time from the stored template and the box row, never stored bytes                                                            | «Другой принтер» may have a different language or dpi; stored bytes would print garbage. This follows the box-label model the root `AGENTS.md` already names            |
| Print verification   | Not in this slice. `printVerifiedAt` and `printSkippedAt` are sent null                                                                           | Brief 10 does not draw the station's scan-the-label-back reconciliation for the handheld, and the schema defaults both to null                                          |
| Box acknowledgement  | Unconditional, by pinned ceiling — deliberately unlike the station's conditional ack                                                              | Nothing in a handheld box payload can change after close, because print state never leaves the device. Adding print verification later re-introduces the station's rule |

## Why no server work

Two facts, both already in the code.

`POST /station/scans` (`apps/api/src/modules/station-scans/dto.ts`) takes
`items[].boxId` per scan and a `boxes[]` array of closures. A closure is
identified by all four of `(tenant, shiftId, terminalId, deviceBoxId)`,
because a device-local box id is not globally unique. The array is capped at
`MAX_BOX_CLOSURES_PER_SYNC_BATCH` and is independent of `items`: a batch may
carry closures and no scans at all.

The shift bundle already carries `boxLabelTemplate` (id, name and spec) and
the device's SSCC block with `issuerPrefix`. The handheld fetches this bundle
today and ignores both fields.

## Data on the device (Room v5)

Three additive changes, plus one field on an existing row.

### `boxes`

| Column                      | Meaning                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `boxId`                     | Device-generated. What the server's four-part closure identity uses.    |
| `shiftId`                   | The shift this box belongs to.                                          |
| `sscc`                      | Null while the box is open; assigned at close.                          |
| `openedAt`, `closedAt`      | `closedAt` is the label's date source — see below.                      |
| `itemCount`                 | Units scanned in.                                                       |
| `operatorId`                | Who closed it.                                                          |
| `printState`, `printReason` | `pending` / `printing` / `printed` / `failed` / `unknown` / `deferred`. |
| `ackedAt`                   | Null until the server has accepted the closure.                         |

**A `printing` row found at startup is read as `unknown`, not resumed.** The
app died between handing bytes to the printer and hearing back, which is
precisely the state whose honest name is "we do not know whether paper
moved". Resuming it as a fresh attempt would be an automatic resend, which is
the one thing an unknown outcome must never do.

### `boxId` on `scan_events` and `outbox`

Box membership for an accepted unit, null for an unboxed scan. The same
column the station carries as `outbox.box_id`, feeding the `items[].boxId`
the server already expects.

### `sscc_pool`

A port of `apps/station/src/lib/sscc-pool.ts`. Keyed by
`(issuerPrefix, extensionDigit, fromSerial)` with a `nextSerial` cursor.
Boxes use extension digit 0; pallets will use 1, and the two must never mix
in one range.

Two properties carry over verbatim, because both were defects that review
found on the station and both are unrecoverable if repeated here.

**Burning is one statement.**

```
UPDATE sscc_pool SET next_serial = next_serial + 1
WHERE rowid = (SELECT rowid FROM sscc_pool
               WHERE issuer_prefix = ? AND extension_digit = ?
                 AND next_serial <= to_serial
               ORDER BY from_serial LIMIT 1)
RETURNING next_serial - 1
```

A SELECT followed by an UPDATE can hand the same serial to two callers, and
two boxes sharing one SSCC is the one failure the server cannot repair.

**Accepting a block is `DO UPDATE SET next_serial = MAX(...)`, not
`DO NOTHING`.** The server always reports a block's _original_ bounds plus
`consumedThroughSerial`. `DO NOTHING` inserted a second, overlapping row
whenever those bounds differed from what the device held, and `burnSerial`'s
`ORDER BY from_serial` then drained the first row and restarted the second
from its own `fromSerial` — reissuing every serial in between, onto labels
already stuck to boxes. `MAX` is also what repairs a cursor that is behind
what the server knows was consumed, after a lost or restored device database.

`ssccRevokedFrom` deletes ranges rather than exhausting them, for the same
`ORDER BY from_serial` reason: a revoked block left in place keeps winning
over the replacement.

**Ranges are disjoint by contract, and the device does not re-check it.** Every
range comes from `SsccService.allocateOrderedForBundle`, which cuts blocks from
a single per-tenant counter; the device never invents one. Re-validating the
intervals here would duplicate a server invariant on a device that could not
repair a violation anyway — it holds no authority to reject a block the server
granted, and refusing one would only stop a line. What the device does own is
the consequence: `burnSerial` takes the lowest range with room and advances that
row's cursor, so it never issues one serial twice from the ranges it holds.

### The box label template on the shift row

The bundle's `boxLabelTemplate` spec is stored on the shift row as JSON.
Without it a label deferred before a shift closed could never be printed
afterwards.

## Closing a box

Triggered by the box reaching capacity, or by «Закрыть короб досрочно» in the
overflow menu with a confirmation naming the unit count inside.

The order of these steps is the design, not an implementation detail:

1. **Refuse an empty box before burning anything.** A box closed by mistake
   costs no serial.
2. **Burn a serial.** A dry pool returns `no-serials`: the box stays open, a
   banner says so, and the bundle is refetched when there is network.
3. **Build the SSCC.** A `SSCC_RANGE` failure returns `invalid-serial`: the
   serial is already burned and cannot be given back, so the box is left open
   for another attempt rather than half-closed. Defence in depth against a
   local pool holding a range beyond its issuer prefix's capacity.
4. **Write the closure** — `sscc`, `closedAt`, operator — in one transaction.
5. **Render and print.**

`closedAt` is the label's date source. The station stamps «Дата
производства» and «Годен до» from the box's own closure moment and reads the
same value back on a later reprint, so two labels for one SSCC never disagree
about dates. The same rule here, which is why `closedAt` is persisted rather
than recomputed at render time.

### Print outcomes

Failures are distinguished by reason rather than collapsed into "did not
work": `template_missing`, `printer_unconfigured`, `render_failed`,
`transport_failed`, plus the `unknown` outcome the transport from #491
already produces.

| State            | Screen                                | Actions                                                   |
| ---------------- | ------------------------------------- | --------------------------------------------------------- |
| `printed`        | Dismisses itself after ~1 s           | —                                                         |
| `failed(reason)` | Stays, naming the printer's own words | «Повторить», «Другой принтер», «Отложить этикетку»        |
| `unknown`        | «Результат печати неизвестен»         | «Этикетка напечаталась», «Напечатать ещё раз», «Отложить» |

**An unknown outcome never resends by itself**, and **«Напечатать все» in the
queue skips every box whose last attempt is `unknown`** until a person
resolves it. This is the whole reason `failed` and `unknown` are different
states: an automatic retry on an unknown would put a second label on a box
the server has already accepted.

## Synchronisation

The batch exists. Two additions and one trap.

**`items[].boxId`** comes from the outbox row. **`boxes[]`** carries closed,
unacknowledged box rows, capped at `MAX_BOX_CLOSURES_PER_SYNC_BATCH`.

**The trap: `batchId` must account for the box set.** It is
`"${deviceId}:${installId}:${maxOutboxId}"` today — keyed off the item ceiling
alone. If a box closes while that batch awaits acknowledgement, a retry sends
the identical `batchId` with a different body, the server answers
`alreadyApplied`, and the closure is lost silently. This is the defect review
found on PR #33 for the station. The fix pins **how many** closures the batch
chose, in `SYNC_PENDING_BOX_COUNT` beside `SYNC_PENDING_CEILING`, and folds a
compact box-set signature into `batchId`. A count is enough because `unacked`
orders by `(closedAt, boxId)` and nothing can close earlier than a box that
already closed, so a retry re-reads the same first N rows. A pinned batch with
no count recorded — one written by a build that predates it — carries **no**
boxes at all rather than everything unacknowledged: growing a batch whose id is
already fixed is the very thing this prevents. Those boxes ride the next batch,
which is also what happens to any box that closes mid-flight.

**Acknowledgement is unconditional here, unlike the station's.** The station
acknowledges only rows whose print-verification outcome still matches the
payload it built, because that outcome can change while a batch is in flight.
A handheld box payload — `boxId`, `shiftId`, `terminalId`, `sscc`,
`closedAt`, `operatorId` — is frozen at close, and print state never leaves
the device. **When print verification is added, the conditional
acknowledgement has to come back with it.**

One more place: `drainOnce` returns `EMPTY` as soon as the outbox is empty.
An empty outbox with unacknowledged boxes is not empty.

## Screens

Frame-level detail comes from `docs/design-briefs/markiro-tsd.pen` at plan
time; the frames are those listed in brief 10's row 3100.

- **`04-work/aggregation`** — the fill grid takes the main zone, the last
  scan collapses into a one-line strip above it, «Короб 27 · 14 / 20» above
  the grid. No pallet strip in this slice.
- **`04-work/box-close-{printing,printed,failed,unknown}`** — the four
  full-screen states with `hh/PrintStatus` and the actions above.
- **`04-work/label-queue`** — one row per unprinted box with its SSCC and
  reason, per-item retry, and «Напечатать все» under the skip rule.

Added to screens that already exist: «N этикеток не напечатано» on the hub's
context card and in the shift header; «Закрыть короб досрочно» in the
overflow menu; and the removal of the `AggregationUnsupported` refusal in the
shift list.

**Grid degradation, not drawn in the brief.** The grid is drawn for a
capacity of 20 (4×5). **Above 60 units the grid is replaced by a large
counter «14 / 120» in the same place**, rather than pretending a hundred dots
can be read at a glance on a 360 dp screen. Sixty is six rows of ten, which
is the most that still reads as countable at the cell size the mockup uses;
it is a judgement made without a device in hand and is listed as an open
point below.

**The fourth signal.** The validation slice built three (accepted, error,
duplicate). «Короб готов» joins them with its own pitch and a short-short
vibration. Like the others it can be muted, and the visual signal alone must
remain sufficient.

Both languages on every screen; a missing translation is a lint error.

## Testing

A fourth set of fixtures exported from `packages/domain`, after the code
parser, the inventory classifier and the label emitters: **SSCC
construction**. The check digit and the range bounds must agree with
`buildSscc` exactly — a disagreement here is a label carrying a number that
will not reconcile at the receiver.

- **Pool under concurrency.** Burning from several coroutines never issues
  one serial twice. This is what the single-statement burn exists for.
- **Close ordering.** An empty box costs no serial; a dry pool leaves the box
  open; `invalid-serial` leaves the box open.
- **Batch identity.** A box closes while a batch is in flight and the closure
  is not lost — a direct regression test for the PR #33 finding.
- **Migration v4 → v5** against a database actually built by the earlier
  migrations, not a freshly created one.
- **The unknown rule.** «Напечатать все» skips it.
- Robolectric over the screens in both languages.

**A manual emulator walk-through with a stand-in printer is required.** In
the printing slice it found four defects no unit test caught, all of them in
the seam between screens and states — which is exactly what this slice has
more of.

## Out of scope

- Pallets, exceptions, duplicate-DataMatrix unit labels, ad-hoc shift
  creation, reverse aggregation with a pre-printed SSCC pool.
- Print verification (scanning the box label back).
- Corrections to a closed box; those are cabinet work.
- Any server change.

## Risks and open points

- **What the walk-through found.** Six defects, none of which a unit test could
  have failed on, and four of which made the slice unreachable or unreadable
  rather than wrong: aggregation shifts could not be entered at all (three
  separate gates, one of them a bare early return with no name to grep for);
  the cards still read «агрегация: в следующем срезе»; the box only appeared
  after the first scan; a deferred label claimed the print had failed; the fill
  grid sat as a small patch in a large empty zone; and a shift-list refresh
  silently stripped the SSCC issuer and the box template off a shift already
  entered, after which a full box refused to close for a reason nothing on
  screen connected to a list refresh minutes earlier.
- **What the walk-through confirmed**, against a stand-in printer that holds
  the line open the way a real one does: the SSCC block and box template arrive
  in the bundle; a serial is burned at close and the cursor advances; the label
  carries the Cyrillic name as an image field, the barcode as a native command
  with the GS1 prefix, and an expiry exactly one day short of production plus
  shelf life; out of paper refuses before anything is sent; a box closes with no
  printer and the label becomes a visible debt on both the hub and the shift
  header; and a device whose data was wiped is handed a block seeded past what
  the server already recorded as consumed, so it cannot reissue a printed serial.
- **Not walked:** «Напечатать все» skipping an unknown attempt, and closing a
  shift with a non-empty queue. Both are covered by tests, neither by hand.
- **Bluetooth printing on hardware.** Still unverifiable on an emulator. The
  pull request must say so plainly rather than implying coverage.
- **How the label looks on paper.** Only a printed label answers that, and
  the handheld's rasterizer is a third implementation by construction.
- **Box capacity in the hundreds.** The 60-unit grid threshold is a
  judgement made without a real device in hand; it should be checked against
  one, and against what capacities customers actually use.
- **A dry pool with no network.** The box cannot close, and the operator can
  do nothing about it on the device. This is honest rather than good: the
  server-side mid-shift refill channel is a bundle refetch, which needs
  connectivity. Worth revisiting if it happens in practice.

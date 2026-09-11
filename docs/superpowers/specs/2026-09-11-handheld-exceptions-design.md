# Handheld (TSD) exceptions — design spec

**Date:** 2026-09-11

**Status:** Approved in brainstorming on 2026-09-11.

**Slice of:** the handheld contour, slice C. The four actions and their server
contract were designed and delivered for the station in
[station exceptions](2026-07-30-station-exceptions-design.md); this document
covers the handheld client only, and changes no server code.

**Related:** [handheld aggregation & boxes](2026-09-10-handheld-aggregation-boxes-design.md)
(the box model these actions correct), [handheld printing](2026-09-10-handheld-printing-design.md)
(the print pipeline reprint reuses), [handheld duplicate DataMatrix](2026-09-11-handheld-duplicate-dm-design.md)
(the fourth sync channel this one is modelled on), design brief
[10-tsd-handheld](../../design-briefs/10-tsd-handheld.md) §7 and §8.

## Problem

An operator packing real product on a handheld has no in-app recovery from the
mistakes that packing produces: a unit scanned into the wrong box, a box filled
for the wrong destination, a box closed too early, a label torn off the carton.
Every one of those today requires reconciliation outside the app.

The station has had all four corrections since PR #35. The handheld has none of
them: it can scan, aggregate, close and print, and then it can only keep going.
Once a code is accepted it holds its hash in `codes_mirror` forever, and once a
box closes nothing on the device can reopen it.

## The server is already done

`POST /station/scans` accepts an `exceptions[]` array alongside `items` and
`boxes` (`apps/api/src/modules/station-scans/dto.ts`), applied inside the same
transaction and **after** items and boxes, so an exception can correct a fact
carried by its own batch. `apps/api/src/modules/station-scans/box-exceptions.ts`
holds the DTO and the deterministic processing order. The handheld posts to the
same endpoint with the same device credential.

This slice therefore adds no route, no migration and no service change on the
server. It is a client slice against a contract that already exists.

## Scope decisions

1. **Four actions, matching the server.** `undo`, `clear`, `disassemble`,
   `reprint`. Design brief §7 draws a different fourth action — «Заменить
   единицу» — which has no server representation at all: the station spec
   deferred replace by an explicit decision, and adding it would mean a new
   `kind`, a migration and its own e2e before any handheld work could start.
   The brief's list also omits `clear`, which the server does support and which
   is what an operator needs when a whole box was packed wrong. The drawn list
   keeps its four rows; slot two becomes «Очистить короб».

2. **Undo is aggregation-only.** The server's `undo` requires a non-empty
   `boxId` and updates `box_items`; a validation-mode scan has no box. The
   station scopes undo the same way — it lives inside the box-fill instrument
   (`apps/station/src/ui/work/BoxFillInstrument.tsx`), not on the validation
   screen. Correcting a validation mis-scan stays cabinet work, as it is today.

3. **Entry is the work screen's more-sheet.** Already drawn: `04-work/more-sheet`
   offers «Исключения» above «Выйти из смены» and «Закрыть смену». Exceptions are
   not a hub tile and not a work-screen button — they are rare, and the sheet is
   where the shift's other rare decisions already live.

4. **Scan confirms only what can be scanned.** The brief's rule «каждое действие
   подтверждается сканом» holds for `disassemble` and for choosing a box to
   reprint, because a closed box has a printed SSCC label in the operator's
   hand. It cannot hold for the other two: an open box has no label and no SSCC
   yet, and `undo` targets a code that may already be buried in the carton or
   damaged — which is often precisely why it is being undone. Those two confirm
   on a full-screen step that names the target explicitly.

5. **Four preset reasons per kind, no free text.** `disassemble` and `reprint`
   require a reason the server stores for the manager's audit trail. The station
   offers four presets plus «Другая причина» with a text field; the handheld
   reuses the four presets verbatim so one ledger reads the same across both
   surfaces, and drops the free-text option — an industrial handheld has no
   comfortable keyboard, and a reason typed on a numeric keypad is worse
   evidence than a chosen one.

6. **Print recovery is audited.** Brief §8 already says that «Напечатать ещё
   раз» from an unknown print outcome is "an explicit same-SSCC reprint, audited
   as such". The channel to record it only exists as of this slice, so this is
   where that promise is kept — with a fixed reason, not a prompt, because the
   operator is standing at the printer deciding whether paper moved, not filling
   in a ledger.

## The four actions

- **Отменить последний скан** — removes the most recently accepted unit from the
  open box. Available only while it is still the last scan and the box is still
  open; a further scan or a box close retires it. Reason-free.
- **Очистить короб** — empties the open box without closing it. The box stays
  open and ready to refill. Reason-free: nothing has been printed and no SSCC
  has been assigned yet.
- **Расформировать короб** — retires a closed box: every unit it still owns is
  released, its SSCC is voided forever and it leaves the active list. Reason and
  an explicit confirmation required. The one irreversible action here.
- **Перепечатать этикетку** — reprints a closed box's label unchanged, same
  SSCC. Reason required. Changes no box or item state.

`undo` and `clear` both have to make the freed codes scannable again. Locally
that is immediate: the row leaves `codes_mirror` the moment the operator
confirms, so a rescan is never mistaken for a duplicate. Server-side the release
is scoped to the claim this device still holds, so a code displaced to another
terminal in the meantime is untouched — that is the server's existing behaviour,
unchanged here.

`reprint` re-renders the box label from the shift's current template rather than
replaying stored bytes. This is the opposite of the duplicate label, and
deliberately so: the duplicate's whole point is that a reprint must reproduce
the same symbol the server holds a digest of, while a box label follows its own
current model — the same rule the station's reprint follows, and what
`AGENTS.md` means by "box-label regeneration follows its own current model".

## Wire format: the closed shape

The server validates each exception with a `superRefine` that rejects the
**whole batch** when one fact has the wrong shape:

| kind          | `codeHash` | `targetScannedAt` | `reason`   |
| ------------- | ---------- | ----------------- | ---------- |
| `undo`        | required   | required          | must be null |
| `clear`       | must be null | must be null    | must be null |
| `disassemble` | must be null | must be null    | required   |
| `reprint`     | must be null | must be null    | required   |

`codeHash`, `reason`, `terminalId` and `operatorId` are declared `.nullable()`
**without** `.default()`, so Zod requires the key to be present even when its
value is null. `targetScannedAt` carries `.default(null)` and may be omitted.

This is a loaded gun on this device. The handheld's Retrofit converter is built
over the lenient `Json` with `explicitNulls = false`
(`core/network/NetworkModule.kt`), which drops every null-valued field from the
wire. A `clear` serialized from a data class would arrive without `codeHash`,
fail validation, and return 400 for the entire batch — wedging scans, box
closures and shift closure on that device permanently, because the drain retries
a rejected batch indefinitely rather than dropping data. The duplicate slice hit
exactly this defect on the emulator, which is why `productLabelEvents` is typed
`List<JsonElement>`.

Exceptions take the same route: the wire object is built by hand at the moment
the action is confirmed, stored as its own JSON text, and sent as
`exceptions: List<JsonElement>`. A retry resends byte-identical JSON, and the
shape is fixed by the one function that writes it, covered by a test per kind.

## Ordering: an exception must never outrun what it corrects

The server applies `items` → `boxes` → `exceptions` within one batch, which
makes an exception safe when its target rides the same request. It says nothing
about an exception that rides an **earlier** request than its target.

That gap is reachable. A device packing offline accumulates scans; the outbox is
drained in id order under a per-batch limit. If 500 scans are queued and the
operator undoes the last one before reconnecting, the undo goes out with the
first batch while its scan waits for the third. The server applies the undo
against a `box_items` row that does not exist yet, records the audit row, and
changes nothing; the scan then arrives and stays in the box forever. Locally the
code is released, server-side it is not — a silent divergence with no error
anywhere. The station's `sync_pending_exception_ceiling` does not cover this: it
pins an in-flight batch's exact set across retries and restarts, which is a
different problem.

The handheld closes it with a watermark. Every exception row records
`afterOutboxId` — the outbox's highest id at the moment the operator confirmed
the action. The drain may send an exception only when no outbox row with
`id <= afterOutboxId` remains, which is cheap to evaluate because acks delete
`outbox` rows in id order. A scan queued *after* the exception does not hold it
back, because the exception does not target it.

`disassemble` and `reprint` additionally wait for their box's closure to be
acknowledged (`boxes.ackedAt`). The closure and the exception can legitimately
share a batch, but the box channel has its own limit, and waiting for the ack is
uniformly correct and trivial to test.

This ordering gap exists on the station too, by the same reasoning. It is not
fixed here: this slice does not touch station code, and a correction there needs
its own verification against the station's own drain. It is written down so the
next person does not have to rediscover it.

## Data model

Room schema version 6 → 7 (`MIGRATION_6_7`, joining the list in
`core/storage/Migrations.kt`).

**New table `box_exceptions`:**

| column          | purpose                                                               |
| --------------- | --------------------------------------------------------------------- |
| `id`            | autoincrement; send order and ack ceiling                             |
| `kind`          | `undo` / `clear` / `disassemble` / `reprint`                          |
| `boxId`         | the device-local box id, same value `BoxClosureDto.boxId` carries      |
| `codeHash`      | only for `undo`                                                        |
| `targetScannedAt` | only for `undo`                                                      |
| `shiftId`       | server shift UUID                                                      |
| `operatorId`    | the operator who acted                                                 |
| `reason`        | only for `disassemble` and `reprint`                                   |
| `occurredAt`    | when the operator confirmed, ISO                                       |
| `payloadJson`   | the exact wire object; what is resent on retry                        |
| `afterOutboxId` | the ordering watermark above                                           |
| `ackedAt`       | null while owed                                                        |

**`boxes` gains `disassembledAt`** — a local mirror of the retirement flag. A
retired box leaves the reprint and disassemble lists and never reappears.

`targetScannedAt` is a join key, not a timestamp: the server matches it against
the original scan claim. It is copied from `CodeEntity.scannedAt`, never read
from the clock at undo time. The duplicate slice lost a whole batch to
quarantine by reading the clock afresh for exactly this kind of field.

Retention follows the box channel: acknowledged rows are deleted; unacknowledged
rows survive restart, shift close and app update, and a device wipe clears the
table with everything else.

## Screens

All four already exist as frames in `docs/design-briefs/markiro-tsd.pen`
(`04-exceptions/list`, `04-exceptions/disassemble-1`, `04-exceptions/reprint`,
and `04-work/more-sheet` for the entry), and the stepper pattern is set by
`04-exceptions/replace-2`: step header, a large instruction, an explanation, a
context card naming what is already identified, the scan target, and a text
«Отмена».

- **Список исключений** — four 64 dp rows with icon, label and chevron:
  расформировать, очистить, перепечатать, отменить. The footer names the undo
  target («Последнее действие: принят …7XQ4K2 в 10:42:17») or explains why an
  action is unavailable. Unavailable rows are never greyed out without a reason.
- **Расформировать короб** — three steps: scan the box label, choose a reason,
  confirm. The confirmation states that the number is retired and cannot be
  reissued.
- **Перепечатать этикетку** — «Последняя · короб N» or «Сканировать SSCC
  короба», then a reason, then the existing print pipeline with its own
  printing / printed / failed / unknown states and its deferred-label queue.
  The printer status card stays as drawn.
- **Отменить последний скан** and **Очистить короб** — a full-screen
  confirmation naming the target (the code and its time; the box and its unit
  count), confirmed by a button.

Every screen follows the existing handheld components and strings; nothing here
introduces a new token system or a second print path.

## Error handling and edge cases

- **The action is no longer available.** The last scan was superseded, the box
  was closed, the box was already disassembled: the list says so in words rather
  than disabling a row silently. State is re-read when the screen opens, not
  cached from when the sheet was drawn.
- **Offline.** Every action applies locally and immediately and queues its fact.
  Nothing here requires a round trip; that is the whole point of putting the
  correction on the device.
- **Redelivery.** Every server-side effect is scoped by current state, so a
  resend after a lost ack finds nothing to do and no-ops. The device may resend
  freely.
- **A code displaced to another terminal before the undo syncs.** The release
  matches nothing and the code stays with its new owner. Correct, and already
  the server's behaviour.
- **Reprint after the template changed.** The label may differ from the one
  originally printed at the same SSCC. Accepted, same as the station.
- **A shift that closes with exceptions still owed.** The rows outlive the shift
  and drain afterwards, like box closures.
- **Print failure during a reprint.** Falls into the existing failed/unknown
  recovery. The `reprint` fact records the operator's request, not the printer's
  outcome — those are separate facts and the server's ledger only claims the
  first.

## Testing

- **Kotlin unit tests per action:** what is released locally, what is queued,
  what the action refuses to do (clear never touches a closed box, disassemble
  never touches an open one, undo only the current last scan).
- **A wire-shape test per kind** asserting the exact key set and null placement
  against the server's rules. This is the test that stands between a typo and a
  permanently wedged device.
- **Ordering tests:** an exception created behind a backlog is not sent until
  its watermark clears; one created with an empty outbox goes immediately; a
  scan queued after the exception does not delay it.
- **Room tests:** migration 6 → 7 over a populated database, the send/ack cycle,
  and survival across restart.
- **Compose tests** for the list, the stepper, the reason step and both
  confirmations, including the unavailable-action copy.
- **A mandatory emulator walk-through against a real API** before the PR. The
  duplicate slice's walk-through found four defects no unit test caught,
  including the wedged queue this spec spends a section on.

## Out of scope

Replacing one unit with another inside a box (no server support; deferred by the
station spec). Undo in validation mode (needs a server change to accept a null
`boxId`). Exceptions reached from the code-check card, and corrections during
inventory — brief 10 places both outside v1. Pallets. Fixing the station's
equivalent ordering gap.

# Station aggregation floor and print recovery — Design Spec

**Date:** 2026-08-13

**Status:** Design approved in chat; written specification review pending

**Scope:** Station aggregation work screen, box-label recovery, and the default
SSCC allocation policy

**Related:**

- `docs/design-briefs/04-line-station.md`
- `docs/design-briefs/design_handoff_markiro/prototypes/line-station.dc.html`
- `docs/design-briefs/design_handoff_markiro/design-system/components/feedback/BoxFill.jsx`
- `docs/superpowers/specs/2026-07-29-aggregation-boxes-design.md`
- `docs/hardware-acceptance-checklist.md`

## Decision record

This specification amends three earlier decisions after testing the packaged
Windows station:

1. A successful product scan no longer uses a full-screen green overlay. The
   work surface updates in place with a green check, status text, and the
   accepted code identity. Error and duplicate signals remain full-screen.
2. A fresh box SSCC number space starts at serial `1`, not `0`. Existing SSCCs,
   counters, and already allocated blocks are never rewritten or moved
   backwards.
3. A box-label failure becomes a persistent, recoverable aggregation state. The
   operator may retry, open printer setup where appropriate, or explicitly
   continue without a label. Continuing without a label is recorded.

These decisions supersede the success-flash rule in `04-line-station.md` and
the statement that zero is an acceptable fresh starting serial in
`2026-07-29-aggregation-boxes-design.md`. The remaining aggregation, offline,
issuer, extension-digit, and audit decisions continue to apply.

## Problem

The current packaged station hides most of the scanned DataMatrix identity,
represents a box with only a count and a thin progress bar, and paints the whole
screen green for an accepted scan. This makes the large work area less useful
than the approved prototype and makes codes hard to compare with the package in
front of the operator.

Box closing also collapses distinct failures — missing box template, missing
printer configuration, label rendering failure, and printer transport failure
— into the short-lived message `Печать не выполнена — проверять нечего.` The
box has already received an SSCC at that point, so the operator needs a durable
recovery path rather than a transient verdict.

Finally, the server currently allocates a fresh SSCC block starting at serial
zero. That is internally valid GS1 data, but it does not match the plant's
numbering rule: the first box must use serial `1`, followed by the calculated
check digit.

## Floor layout

The implementation returns to the approved `line-station.dc.html` composition
rather than adding another visual language.

### Primary work area

The left, dominant column contains:

1. product and counterparty identity;
2. the latest scan identity and verdict;
3. the open-box fill instrument;
4. box actions in the same card surface, without a differently coloured strip
   behind the buttons.

The right column retains shift counters and recent operations. It uses the
available width for readable code identity instead of a four-character suffix.
The fixed viewport, no-scroll rule and 64 px minimum action target remain in
force at 1280×800, 1024×768, and 1280×1024.

### Accepted code identity

An accepted KM is rendered semantically, never as an unescaped raw scanner
payload:

- `GTIN` — the normalized 14-digit value from AI `01`;
- `Серийный номер` — the value from AI `21`;
- `Криптохвост` — available AI `91`, `92`, and `93` segments, labelled by AI;
- a compact normalized line that joins the visible AI/value segments without
  rendering the GS control character.

The center instrument may use multiple lines and larger mono typography. Recent
operations use the same model at a smaller size: verdict, GTIN, serial, and
time; the crypto tail may be visually truncated there but remains available in
the dominant latest-scan instrument. The data is derived from the journal's
existing captured KM rather than stored as a second, divergent representation.

For invalid input that cannot be parsed, the UI shows a safe bounded suffix
only. It does not echo an arbitrary raw payload onto the floor screen or into
logs.

### Scan signals

An accepted scan updates the latest-scan instrument in place:

- green check icon plus `Принято`;
- a slim green edge or short local highlight;
- existing success sound;
- no fixed full-screen overlay.

Invalid code, wrong GTIN, duplicate, and internal recording failure retain an
unmissable full-screen signal with icon, text, colour, and their distinct
sounds. This preserves peripheral error detection without interrupting the
operator's view after every successful unit.

### Box-fill instrument

The open box is shown as the product's signature cell grid:

- stable local ordinal, for example `Короб № 1`;
- large exact count, for example `2 / 20`;
- one square per physical position for capacities up to 100;
- filled cells use the success token; empty cells retain a strong outline;
- the next position is distinguishable without relying on colour alone;
- the last accepted position animates locally for about 150 ms;
- closing resets the visual only after the label outcome is resolved.

The normal 20-place box uses ten columns, matching the approved prototype. The
grid adapts within the fixed viewport for other capacities. For capacities over
100, the instrument uses explicitly labelled grouped cells and the exact count;
it never silently pretends that one displayed cell equals one item.

The box ordinal is local to this terminal within the shift and is derived from
persisted local boxes, so restart does not reset the visible number. It is a
floor aid, not part of the SSCC identity.

## Closing, printing, and recovery

This flow applies only to aggregation shifts. Validation shifts do not acquire
printer requirements or recovery UI.

### Durable sequence

1. Capacity or an explicit action requests box closure.
2. The station atomically assigns the next serial, calculates the 18-digit
   SSCC, closes the local box, and records its label state as `pending`.
3. Ordinary product scans pause while the label outcome is unresolved.
4. The station resolves the box template, renders the label, and sends it to
   the configured printer.
5. Successful output proceeds to optional scan-back verification when that
   workstation setting is enabled. Otherwise the label state becomes
   `printed` and the next box becomes active.
6. Any failure opens the persistent recovery screen described below.

Assigning the SSCC before printing preserves the existing one-number-per-closed-
box audit boundary. A failed print never returns its number to the pool.

The pending label state must survive application restart. Reopening the station
returns to the unresolved label before admitting product scans into the next
box. The local representation may extend `boxes_mirror` or use an equivalent
single-purpose print-job record, but the transition that closes a box and marks
its label pending must remain atomic under the station SQLite execution model.

### Recovery screen

The recovery screen names the closed box and shows its complete 18-digit SSCC.
It presents a sanitized, actionable category:

- `Для смены не выбран шаблон этикетки короба`;
- `Принтер не настроен`;
- `Не удалось подготовить этикетку`;
- `Принтер не принял задание`.

Raw device errors, label contents, credentials, and scanner payloads are not
shown or logged.

Available actions depend on the category:

- `Повторить печать` retries the same closed box and the same SSCC;
- `Настроить принтер` opens the established workstation setup path and returns
  to the same recovery state;
- `Продолжить без этикетки` requires confirmation explaining that the box is
  already closed and must be labelled later.

The skip action marks the outcome durably and sends the established print-skip
audit event. Only after a successful print or explicit skip does the station
admit ordinary scans for the next box. There is no automatic skip and no timer
that dismisses the failure.

Reprint from exceptions continues to use the closed box's original SSCC and
does not allocate another serial.

## SSCC start policy

`buildSscc` continues to accept serial zero because historical SSCCs carrying
zero are valid and must remain readable. The new rule belongs at allocation,
not at generic GS1 validation.

For box extension digit `0`:

- an absent server counter is reported and created with next serial `1`;
- a first allocation begins at `1` and advances the counter by the granted
  block size;
- admin counter settings reject values below `1`;
- a migration changes only untouched zero counters that have no allocated
  block to `1`;
- counters above zero, consumed history, and allocated block bounds are not
  rewritten;
- when a station receives a legacy block beginning at zero, its local cursor
  starts at `1` or later, intentionally leaving zero unused if it was not
  already consumed.

Pallet extension digit policy remains outside this change. The 18-digit box
SSCC remains:

`extension digit + 9-digit issuer prefix + 7-digit serial + check digit`.

For serial `1`, the human-visible tail therefore contains the padded serial
ending in `0000001` followed by the independently calculated check digit.

## Failure and offline behaviour

- Accepted scans and the box grid continue to work offline while local serials
  remain.
- Serial exhaustion blocks box closure but not the already documented recovery
  controls.
- A pending label is local durable work and does not disappear when the API is
  unavailable.
- Printer setup and retry do not mutate box contents or allocate another SSCC.
- A skipped label remains visible to audit and later reprint workflows.
- Application restart, operator switch, and window-mode changes cannot dismiss
  an unresolved label outcome.

## Testing and acceptance

Implementation follows focused RED/GREEN tests before production changes.

Automated coverage must include:

- semantic AI `01`/`21`/`91`/`92`/`93` display and safe malformed input;
- accepted scans without `SignalOverlay`, while every rejection path retains
  its full-screen signal;
- box grids at 20, 100, and grouped-capacity boundaries;
- stable box ordinal and pending print recovery across remount/restart;
- missing template, missing printer, render failure, transport failure, retry,
  successful print, verification, and explicit skip;
- retry and reprint retaining the original SSCC without another pool burn;
- first server allocation starting at `1`, exact range boundaries, concurrent
  allocation, exhaustion, and migration of untouched zero counters;
- a legacy zero-based device block skipping unused serial zero without
  reissuing any consumed serial;
- complete SSCC construction with the expected final check digit.

The final automated gates cover affected domain, DB, API, and Station packages,
including Station typecheck, lint, build, Cargo tests where Tauri integration is
touched, formatting, and diff checks.

Browser acceptance records 1280×800, 1024×768, and 1280×1024 layouts with no
scroll, clipping, overlapping controls, or sub-64 px actions. It includes a
20-place open box, a long DataMatrix identity, a full recent list, and every
print-recovery category.

Windows and hardware remain separate gates:

- EAN-13 and production-like DataMatrix through the actual scanner;
- auto-close and manual partial close;
- real ZPL and TSPL printing;
- printer disconnected, out of paper, and restored;
- restart with an unresolved print job;
- scan-back verification of GS1-128 `(00)` plus the 18-digit SSCC;
- confirmation that the first fresh box uses serial `1` and a valid check
  digit.

No automated browser or host-side test is reported as physical printer,
scanner, Windows, or packaged-Tauri acceptance.

## Out of scope

- pallet aggregation and pallet numbering;
- changing historical SSCCs or reclaiming burned serials;
- creating products from the station;
- redesigning the label editor or admin shift form;
- automatic continuation after a print failure;
- adding cloud telemetry or runtime visual assets.

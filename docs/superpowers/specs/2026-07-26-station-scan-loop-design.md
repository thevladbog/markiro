# Station Scan Loop, Signals & Hardware (05b-2) — Design Spec

**Date:** 2026-07-26
**Status:** Design approved (brainstorming); implementation plan pending
**Slice of:** roadmap plan 05b (05b-1 operators — delivered; **05b-2 this slice**)
**Related:** `docs/design-briefs/04-line-station.md` (signal system, work screen, §7 workstation setup),
`docs/superpowers/specs/2026-07-24-operators-roster-design.md`,
`docs/superpowers/plans/2026-07-23-05a-station-foundation.md`

## Problem

The station can be commissioned, sync its operator roster and sign an operator
in (05a + 05b-1), but it cannot yet do the job it exists for: **read codes off
the line, judge them, and tell the operator instantly**. The domain has judged
scans since plan 01 (`validateShiftScan`), the local journal tables exist since
05a (`codes_mirror`, `scan_events_mirror`) and `SignalOverlay` is a skeleton —
nothing connects them, and no code talks to a scanner or a printer.

This slice delivers **validation-mode shifts end to end**, plus the hardware
layer both this and later slices need.

## Scope decisions

1. **One plan, not two.** Hardware code ships without on-device verification
   because hardware testing happens once, after the MVP is assembled. The
   deferred hardware items from plans 04, 05a and this one are consolidated
   into a single **hardware acceptance checklist** executed in that pass.
2. **Aggregation is plan 06.** Boxes, SSCC and box-complete printing are out.
   `shifts.mode` therefore changes nothing on screen in this slice — an
   aggregation-mode shift scans and journals exactly like a validation one, and
   06 adds the box UI on top. No "coming later" placeholder UI is built: this
   build is not shown to end users before 06 lands.
3. **No shift close from the station.** Closing is inseparable from
   synchronization (plan 06): closing a shift server-side while its scans sit
   unsent locally would mark a shift complete with no data behind it. The
   manager closes shifts in the cabinet; the operator leaves the work screen by
   switching operator or picking another shift.
4. **Sync stays in plan 06.** Scans accumulate in the local journal only.

## Architecture

### Scan pipeline — a serial queue

```text
ScanSource (keyboard-wedge | serial)
      │ raw string
      ▼
ScanQueue ── one scan at a time, to completion ──▶ next scan
      │
      ├─▶ validateShiftScan(raw, { expectedGtin14, isDuplicate })   [domain]
      ├─▶ journal write (no transaction — code row first, PK is the dup check)
      └─▶ signal (flash + tone)
```

**Why serial.** Operators scan several codes per second. Concurrent processing
would let two scans both pass the duplicate check before either is written.
Processing one scan to completion before starting the next removes that
scan-vs-scan race by construction and makes the loop deterministic in tests.
Serializing scans does **not**, by itself, remove `tauri-plugin-sql`'s
pooled-connection hazard deferred from 05b-1: the pool can hand a different
connection to every call regardless of how many scans are in flight, so a
multi-call transaction would still be unsound even one scan at a time. That
hazard is why the journal write below does not use a transaction at all (see
"Journal"). Fast input is **buffered, never dropped**.

**Duplicate index.** `ShiftScanContext.isDuplicate(key): boolean` is
**synchronous** while SQLite is async, so the shift's existing code keys are
loaded into an in-memory `Set` when the shift opens and updated on every
insert. This satisfies the domain contract and keeps the check instant.

### Journal

Per scan, as two independent statements — deliberately **not** one transaction:

- **accepted** scans → `codes_mirror` FIRST (`code_hash` = the domain's
  `kmKey`, `gtin14`, `serial`, `shift_id`, `scanned_at`);
- **every** scan → `scan_events_mirror` SECOND (`raw`, `verdict`,
  `scanned_at`, `terminal_id`).

`tauri-plugin-sql` opens SQLite through sqlx's `Pool::connect` (up to 10
connections, a FIFO idle queue) and can hand a _different_ pooled connection
to every call, so `BEGIN`/inserts/`COMMIT` sent as separate calls would not
actually be one transaction — under real overlapping DB work (the settings
read racing migrations, the shift-context poll overlapping the bundle
mirror, roster sync re-running on `online`), `COMMIT` can fail with "no
transaction is active." The journal write therefore uses no transaction at
all and instead relies on `codes_mirror.code_hash` being the PRIMARY KEY: the
code insert runs first, and a UNIQUE/PRIMARY KEY constraint violation on it
**is** the duplicate verdict rather than a write failure. The event row is
still written afterwards either way, so the audit trail survives regardless
of what the code insert did.

### Hardware layer

A TypeScript **`HardwareContract`** shaped like the idento agent: list ports /
open scanner / scan stream / close; list printers / send bytes / test print.
The default implementation is **Tauri commands** (Rust: serial port for the
scanner, raw bytes to the printer). An external agent process can later
implement the same contract without touching the UI.

Bytes cross the IPC boundary **base64-encoded** (Tauri IPC is JSON), which is
also how TSPL's binary `BITMAP` payload survives the trip — the latin1
discipline pinned in plan 04 stops at the JS edge.

Hardware-unavailable states (no scanner, printer offline) surface in the status
bar and the setup screen, per design brief 04's degradation states.

## Screens

### Work screen (validation mode)

Shift context (product, plan, mode, and «для: Завод X» when the shift is
tolling), a large accepted counter, the last verdict, and the 05a status bar
lit up with scanner / printer / online state.

### Signal system

`SignalOverlay` is promoted from skeleton to three full-screen states, per
design brief 04:

| Verdict                | Flash            | Copy                                                   |
| ---------------------- | ---------------- | ------------------------------------------------------ |
| `ok`                   | green, short     | —                                                      |
| `invalid`/`wrong_gtin` | red, held longer | «НЕВЕРНЫЙ КОД» / «ЧУЖОЙ ГТИН»                          |
| `duplicate`            | amber            | «ДУБЛЬ» + when it was first scanned (from the journal) |

Terminal attribution ("first scanned on Terminal 2") is **deferred to plan
06**: `codes_mirror` stores no `terminal_id` (only `scan_events_mirror`
does), so `findFirstSeen` can only report the timestamp in this slice. It is
added once cross-terminal sync gives a duplicate's original terminal any
meaning beyond "this device."

Tones are **synthesised with WebAudio** (a distinct frequency and envelope per
verdict) — no audio assets, no CDN, tunable by ear. Volume and mute are
per-workstation settings. Brief 04's rule holds: visuals alone suffice on a
noisy floor, sound alone suffices when the operator is watching the line.

### Workstation setup (brief 04 §7)

Choose scanner port and baud with a **test scan** that shows the decoded
string; choose a printer with a **test print** of a real label built from the
shift's template; sound volume and mute. Designed to be done once by a non-IT
person.

## Station `RasterizeTextFn`

The canvas rasterizer is ported from `apps/admin/src/labels/rasterizer.ts`,
**including its generic-family → bundled IBM Plex mapping** — without that the
admin's «предпросмотр = печать» promise breaks the moment the station prints
the same template.

## Testing

- **Domain** already covers classification and verdicts (plan 01).
- **Queue:** deterministic unit tests — a burst of scans including duplicates
  and a wrong GTIN; assert verdict order, journal contents, and that nothing is
  dropped while a scan is in flight.
- **Journal:** `node:sqlite` executor tests (the 05a pattern).
- **Signals:** component tests per verdict state, including the duplicate's
  first-seen detail.
- **Hardware:** the contract is mocked in TS tests; Rust unit tests cover
  parsing and byte handling. Live device verification is explicitly deferred to
  the consolidated hardware acceptance checklist.

## Hardware acceptance checklist (consolidated, executed post-MVP)

Carried from plans 04, 05a and this slice, so the deferred items stop being
scattered across ledgers:

- ZPL `^BX` FNC1 on real printers; TSPL `DMATRIX` GS1 behaviour (unverified);
  TSPL `DMATRIX` cell-size form; TSPL transport latin1/base64 discipline.
- `tauri-plugin-sql` `?` placeholder behaviour on device; confirming that
  `upsertBundle`/`replaceOperatorsMirror`/`syncOperatorRoster` — which no
  longer use BEGIN/COMMIT, since the pool makes that unsound — don't leave a
  visible partial-update window under real sync timing.
- Updater endpoint and the `{{target}}` placeholder allowlist; kiosk lockdown
  actually invoked.
- Scanner: real serial device, baud negotiation, keyboard-wedge fallback.
- Printer: real ZPL and TSPL hardware, Cyrillic raster output, test print.

## Out of scope

Aggregation, boxes, SSCC and box-complete printing (06); server sync and
cross-terminal duplicates (06); shift close from the station (06); multi-
terminal presence (06); the device-key route allowlist and `GET /employees`
badge exposure (tracked from 05b-1, belongs with the API surface work).

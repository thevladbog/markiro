# U.S. Design Brief 06 — Line Station: Lot Link and English Floor Mode

> Revised 2026-09-04: read the [shared MVP contract](../../us/mvp-contract.md) first. It resolves cross-slice scope and safety rules and supersedes conflicting draft recommendations below. Design only; implementation is not claimed.

> U.S. series, floor mode of the design system (brief 02). Touch-first station app on a 10–12″
> tablet (landscape, 1280×800 base) or a desktop by the line; gloves, noise, 0.5–2 m viewing
> distance. User: the **Production Operator**; the QA / Traceability Manager sees the results in the
> cabinet. **Dark theme is the default**; light supported. EN primary on U.S. devices, ES variants
> for string-length checks. This is a **delta to RU brief 04 (line station)**: the same sign-in,
> shift selection, work screen, exceptions, setup and degradation screens gain a thin lot layer.
> Do not redesign the signal system, the box-fill visual, the PIN pad, recovery screens or the
> status bar; extend them. Grounded in slice specs US-10 (station lot link) and US-04 (the
> lot-to-box bridge on the server).
>
> **Priority: P1.** The office workflow (U.S. briefs 01–05) is the MVP and does not
> depend on this brief. The P0 cabinet records case quantities without individual case links. Nothing here may delay or reshape the office screens.

## Purpose

A U.S. processor forms 100 cases of `NRF-260915-APL01` on the line. The station already closes
boxes offline, allocates SSCCs, prints a label, records whether the print was verified, and syncs
all of it exactly once. What it does not know is _which traceability lot_ those cases belong to.
This brief adds that knowledge: the operator sees the lot they are packing, each closed case is
linked to it locally, the case label carries a human-readable TLC, and the print log tells the
truth about what was actually printed. Everything rides on the existing close-box sequence; nothing
in it is allowed to stop the line.

## Design principle: a thin layer on the box pipeline

The lot link is **one more fact recorded after a box closes**, not a new mode. The box still
closes, the SSCC is still assigned, the label still prints and the sync still replays exactly
once. The link is inserted after closure and before printing; if the insert fails, the box is still
closed and printed and the operator gets a chip, not a wall. Losing a link is recoverable in the
cabinet; a blocked line is not (OQ-US10-9).

Two consequences for the designer:

1. **RU devices see nothing new.** A Russian shift bundle carries no lot; every element drawn here
   is absent, not disabled, on a RU station. Draw the RU card and the U.S. card side by side so the
   difference is visible and the RU one is proven unchanged (STN-001).
2. **The signal system is not extended, it is reused.** Warn and block screens use the existing
   amber and red full-screen signals with their tones; the only new thing on them is the reason
   text and, for warn, a reason field. No new colors, no new sound.

## Screens

### 1. Shift selection card with the output lot

The shift card (brief 04 §2) gains a lot line delivered through the shift bundle: **TLC**
`NRF-260915-APL01`, product `Fresh-Cut Apple Snack Cups`, production date `09/15/2026`, lot
status `Active`. The TLC is set in mono, the largest text on the line after the product name — the
operator must be able to compare it with a paper ticket from a metre away.

States to draw: lot assigned; **no output lot yet** ("No output lot assigned — cases will be linked
in the cabinet", neutral tone, the card is still tappable and the shift still starts); lot with a
**use-by date passed** (attention marker on the card before the operator even enters); the
**generic profile** variant where the card title is "Lot", not "Traceability lot" (no FTR wording,
docs/us/demo-scenario.md §4); and the **RU card unchanged** next to it.

### 2. Work screen status bar and lot card

Aggregation-mode work screen (brief 04 §5) with two additions:

- A **TLC chip** in the persistent status bar next to the teammates indicator: `NRF-260915-APL01`
  in mono with a lot icon. It is always visible, including during the flash states.
- A **Traceability lot card** in the header: TLC, product description, production date in locale
  format, lot status, and two counters — `24 cases linked`, `1 not linked` (the second appears only
  when non-zero and is tappable: it opens the closed-box list filtered to unlinked).

States to draw: normal; no snapshot (card shows the "will be linked in the cabinet" line, no
counters); offline with pending links (`3 links queued`, blue sync tone, alongside the existing
"Working offline — N scans queued" banner, not replacing it); English and U.S. Spanish variants.

### 3. Box-closed moment

The existing box-complete celebration (closed-box animation, label printing, progress reset) gains
one line: **Linked to lot NRF-260915-APL01** with a check icon. It is part of the same moment,
not a second toast.

When the link did not happen (policy said no, the insert failed, or there was no snapshot), the
closed-box row in the recent-boxes list carries a persistent **Not linked** chip (attention tone,
icon + text) with a 64 px **Link to lot** action. The next box starts regardless; the chip never
blocks the line.

States to draw: closed and linked; closed and not linked (chip on the row); the closed-box list
with a mix of linked, not linked and "link queued" rows; the chip after a successful retry.

### 4. Policy states: warn with audited override, and hard block

The tenant chooses in the cabinet, per policy, whether a **TLC mismatch** or an **expired lot**
blocks the case or warns and requires a reason (US-10 station settings; tenant-wide, OQ-US10-4).
A mismatch fires only when the operator scanned or typed a TLC that differs from the bundle TLC —
draw the optional **Scan lot ticket** check on the work screen that makes this possible. Expiry
fires when the lot's use-by date is before today in the tenant timezone.

- **Warn.** Full-screen amber signal (brief 04 signal system) with the reason list in huge text
  (`TLC MISMATCH — scanned OSS-260914-A2, shift lot NRF-260915-APL01`, `LOT EXPIRED 09/12/2026`),
  a required reason field (keyboard, 64 px targets), and two actions: **Link anyway — recorded**
  and **Leave unlinked**. The confirm inserts the link with `override`; both the override and its
  reason are audited in the cabinet.
- **Block.** The same screen in red with no confirm action; the only action is **Continue without
  linking**. The box stays closed and unlinked (chip from screen 3).
- **No snapshot on a U.S. shift** is always a block ("cannot link to nothing"); on a RU shift the
  check never runs.

States to draw: warn with one reason; warn with both reasons; block; the keyboard-only path through
warn; the audit trail as it appears in the cabinet lot card ("Station links" panel: box SSCC,
device, operator, linked at, verdict, override reason, outcome).

### 5. Print log in the station history

Every closed box in the station history (brief 04 §6 exceptions and the recent-boxes list) shows
its print state as **text + glyph**, never a dot:

| Row state | Meaning                                                                                                                                                                                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requested | bytes were sent to the printer; nobody has confirmed a physical label                                                                                                                                                                                                                                                 |
| Confirmed | scan-back verification succeeded, or the operator confirmed visually                                                                                                                                                                                                                                                  |
| Skipped   | operator chose to skip the label (existing recovery path)                                                                                                                                                                                                                                                             |
| Failed    | print error with its code — the existing `print_error_code` set `template_missing`, `printer_unconfigured`, `render_failed`, `transport_failed` (`apps/station/src/lib/boxes.ts` `BoxPrintErrorCode`), reused as `trace_print_log.error_code`; no finer codes such as `printer_offline` or `out_of_paper` exist today |

Each row also carries the **printer identity** (`USB · Zebra ZD421`, `COM3`,
`192.168.1.20:9100`), printer language (ZPL / TSPL) and the template name. "Requested" is not
"printed": the distinction is the whole point of STN-007 and must be visible at a glance.

For a template **without a barcode** the verification screen reads "This template has no barcode —
confirm the printed text" with a 64 px **Confirm** that logs a visual confirmation.

States to draw: history list with all four states; the no-barcode confirmation screen; a row whose
log rows are still queued for sync.

### 6. English and Spanish floor mode

The same screens in English (`en-US`, default) and U.S. Spanish (`es-US`): `MM/DD/YYYY` dates, `24 ea`, `100 cases`, `lb` — decimal
plus explicit unit, no conversion. The signal words follow the existing pattern: `INVALID CODE`,
`WRONG GTIN`, `DUPLICATE`, `TLC MISMATCH`, `LOT EXPIRED`. Check **Spanish expansion**
on every new element (e.g. `EL TLC NO COINCIDE`, `LOTE VENCIDO`) to prove the layout holds.
The locale arrives with the first U.S. shift bundle and can be
overridden per device (screen 7).

States to draw: work screen EN; warn screen EN and ES; status bar with a long teammate name.

### 7. Label template preview and workstation setup

**Label preview (office-mode delta, drawn once).** Two English stock templates, `Case 4×6 in
(203 dpi) — TLC` and `… — TLC + SSCC`. The human-readable block is primary: **TLC** (largest),
product, production date, quantity (`24 ea`), TLC source (`North River Fresh Foods, Portland, OR`).
The barcode block (SSCC as GS1-128 or a QR) is drawn with an **"optional carrier"** caption in the
editor and is absent from the TLC-only template — a barcode is an operational aid, never a legal
requirement (STN-006, docs/us/limitations.md). In the admin label editor the new fields live in a
"Traceability (U.S.)" group shown only for U.S. profiles; sample data is the demo lot.

**Workstation setup (brief 04 §7)** gains a **Language** control (English / Español) beside sound
volume, with the note "Set from the shift by default". The separate RU edition keeps its existing
language behavior; Russian is not a locale option in the U.S. edition.

States to draw: TLC-only template preview; TLC + SSCC preview; editor field picker with the U.S.
group; setup screen with the language row in both locales.

### 8. Sync conflicts for lot links

The existing conflict list (brief 04 §8) gains a **Lot links** heading. Rows are informational for
the operator; resolution happens in the cabinet. Plain-language text per conflict code: "Case
already linked to another lot", "Case was disassembled", "Lot is not available", "Lot not found",
"Shift does not match". Each row shows box SSCC, TLC and the time.

States to draw: list with two lot-link conflicts under the heading; empty heading hidden.

## Cross-cutting notes

- **Offline-first invariants unchanged.** Links and print-log rows are durable local rows synced
  after the scan batch; a restart replays them exactly once. The UI must never imply a link needs
  the server: "linked" is shown immediately, "queued" describes sync, "conflict" arrives later.
- **Recovery precedence.** The existing print-recovery screen (out of paper, agent down) always
  wins over the lot chip. Never stack a lot warning on top of a hardware recovery screen.
- **Dark default, 64 px targets, no small modals** — brief 04 rules apply to every new element,
  including the reason field on the warn screen.
- **Status never by color alone.** Linked / not linked / queued / conflict each have a glyph and a
  word; the TLC chip is mono text, not a colored pill.
- **Wording.** No "FDA", "compliant" or "required by FDA" on any station string; the generic
  profile uses "Lot" without FTR words. Station `en.json` is scanned by the prohibited-wording test.
- **Cabinet deltas that belong to this brief** (office mode, small): the Station settings page
  (three radio groups: lot mismatch, expired lot, case scan at shipping — "Block the case" / "Warn
  and require a reason", "Optional" / "Required", with the note that case scanning is an
  operational aid), and the read-only "Station links" panel on the lot card.

## How this grows

- **Receiving and shipping station modes (STN-010, P2)** arrive as two more entries in the
  top-level task switcher (brief 02 navigation), not as new apps: "Receive lot" and "Ship cases"
  next to the production task. Reserve the switcher slots; do not design the screens now.
- **Case-only closure mode** (OQ-US04-1): a U.S. product with no marking codes closes cases by
  count instead of by scanned units. The box-fill visual then counts taps or a scanned case label;
  the lot card, chip and print log are identical.
- **Per-product or per-shift policy** (OQ-US10-4) changes only where the setting is edited; the
  warn/block screens do not change.
- **Pallet-level links** are out of scope; the bridge is box-level. If added, the pallet strip
  gains the same chip.

## Questions for the designer

1. On a **block** verdict, should the label still print (the box is closed either way)? The spec
   closes the box and leaves it unlinked but does not say whether printing proceeds; draw both.
2. Where does the optional **Scan lot ticket** check live — on the work screen as a secondary
   action, or only inside the exceptions section?
3. Should the **Not linked** chip aggregate ("3 not linked") in the status bar as well as on rows,
   or is the lot-card counter enough?
4. Language override (OQ-US10-8): a row in Workstation setup only, or also a quick toggle on the
   sign-in screen for mixed crews?

## Implementation prerequisite

The current marking-code-driven closure is not a U.S. case-only mode. Design and verify case-only closure, restart/replay and print-recovery first; until then these screens are P1 references, not production-ready flows. Lot linkage after an offline restart is retry-safe, not a claim that delivery happens exactly once. A blocked link does not justify silently printing a false lot identity.

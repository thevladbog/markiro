# U.S. Design Brief 05 — Traceability Plan and Trace Request (24-hour readiness drill)

> U.S. series, office mode of the design system (brief 02). Web admin, desktop-first 1440px,
> adaptive down to 1024. Users: the **QA / Traceability Manager** (owns the plan, runs the drill),
> the **Owner / Tenant Admin** (approves, downloads) and the **Auditor** (read-only). EN primary,
> RU secondary; light + dark. This is a **delta to RU brief 03 (admin panel)**: it adds two items,
> **Plan** and **Trace requests**, to the Traceability sidebar group introduced by the earlier U.S.
> briefs, plus one tile on the Traceability overview. Do not redesign the shell, tables, dialogs,
> chips or the PDF viewer chrome; reuse them. Grounded in slice specs US-08 (plan), US-09 (trace
> request) and US-07 (what the package contains).

## Purpose

An FDA trace request gives a processor 24 hours to hand over its records. This brief makes that
answerable in one place: _do we have a current Traceability Plan, and if a request landed right now,
could we prepare a complete package before the clock ran out — and prove how long it took?_

Two records answer it: the **Traceability Plan** (a versioned, approved PDF derived from tenant
configuration) and the **trace request** (a due-at clock, a dry-run validation, a frozen
hash-verified package). The demo (docs/us/demo-scenario.md §5.4 steps 7–8) ends on these screens.

## The core idea: frozen records on a visible clock

Every artifact here is **frozen the moment it matters** and never silently rewritten. A plan version
is approved once and keeps its PDF, configuration snapshot and SHA-256 forever; a superseding version
sits next to it, it does not replace it. A package run pins the exact event revisions it was built
from; regenerating creates revision 2 and revision 1 stays downloadable byte-for-byte. The UI never
shows a "current" document that could quietly change under an auditor's eyes — it shows versions and
revisions, each with a date, an actor and a hash.

The second half: **the clock is never blocked by tooling.** Validation can flag missing data and
refuse the _case-ready_ badge, but the 24-hour countdown keeps running and the operator can always
prepare _some_ package. Time is shown plainly — received, due, started, completed, elapsed — because
the elapsed time _is_ the evidence (C-013, C-014).

Wording rule binding every string: the product **prepares** a package; it never "submits", "sends"
or "uploads" anything to FDA (RQ-007). Buttons must not contain "FDA", "submit" or "upload". The
plan is "designed to support applicable FSMA 204 recordkeeping requirements"; never "compliant".

## Screens

### 1. Plan versions list

Route `/traceability/plans`. Table, newest first: **Version** (`v2`), **Status** chip with text
(Draft / Effective / Superseded), **Effective date** (`09/10/2026`), **Approver** (name, title),
**Change summary** (one line, tooltip for the rest), actions (View; Download PDF; Edit for the
draft). Primary action **New draft**, disabled with a hint when a draft exists ("v3 is open").

Below the table a quiet **retention note**: "Prior versions are retained for at least 1,825 days
(tenant setting; minimum 730)". The number is data from the profile, not copy.

Two banners may appear above the table (warning tone, icon + text):

- **Configuration changed** — "Configuration changed since v2 became effective: TLC source
  locations, point of contact." with a link to open a new draft. The section list is data.
- **Annual review due** (P1) — "Annual review due on 09/10/2027" when within 30 days or past.

States to draw: empty (no plan yet — explains what the plan is in allowed wording, offers New
draft); draft only (no effective version — the request screens reference this state); effective +
one superseded row; effective + configuration-changed banner; loading; error; stale/offline.

### 2. Plan editor

Route `/traceability/plans/:id` for the draft. `DataTabs`, one tab per section in the fixed order
of the domain model:

| Tab                | Derived from configuration (read-only block)                                                 | User-editable             |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------- |
| Record maintenance | system of record, export formats, storage class, backup statement, retention days, timezone  | narrative paragraphs      |
| FTL identification | classification workflow: coverage statuses in use, review cadence, count of covered products | narrative paragraphs      |
| TLC assignment     | rule "Transformation assigns; shipping never assigns", TLC source locations (name, city/ST)  | narrative paragraphs      |
| Point of contact   | —                                                                                            | name, title, phone, email |
| Farm map           | fixed "Not applicable to the processor profile"                                              | explanation paragraph     |
| Review and update  | review cadence default (365 days)                                                            | narrative paragraphs      |

Every derived block is labelled "Derived from configuration" and links to the screen that owns the
fact (profile, locations, products) — the plan is edited _there_, not here. Narrative is plain-text
paragraphs (OQ-US08-10). A **Change summary** field sits above the tabs and is mandatory from v2
on. Phone example: `+1 (503) 555-0120`.

**Prohibited wording check, inline.** As the manager types, a phrase from the "Not allowed" column
of docs/us/limitations.md ("FDA approved", "guarantees compliance", …) is underlined in the
textarea and listed in a small issues panel quoting the phrase and naming the tab. Approve stays
disabled while any issue exists. This is a validation state, not a spell-checker: unmissable, not
shaming.

Toolbar: **Save draft**, **Preview PDF** (opens a new tab, announced), **Approve**, **Discard
draft** (confirmation; drafts are not regulated records, OQ-US08-4).

States to draw: new draft prefilled from the effective version; draft with validation issues
(missing contact phone, a prohibited phrase, no TLC source location configured — the last links to
Locations); clean draft ready to approve; saving / save error; the configuration-changed banner
inside the editor pointing at the affected tabs; read-only view of an effective or superseded
version (same tabs, no inputs, header "v1 — superseded on 09/10/2026 by v2"); RU tab bar.

### 3. Plan preview and PDF

The PDF is rendered by the API and shown in the existing viewer chrome. Draw the **document itself**
(first and last page) because it is what the auditor will hold:

- Header: tenant name, profile code, regulatory baseline ID and verified date (`US-REG-2026-09-03`),
  **Version 2**, **Effective 09/10/2026 2:15 PM PDT (21:15 UTC)**, approver name and title.
- The six sections in order; Farm map prints "Not applicable to the processor profile" plus the
  explanation.
- **Change history** table on the last page: every prior version — number, effective date,
  approver, change summary (OQ-US08-13).
- Footer on every page: renderer version, "Page 2 of 5", the allowed-wording disclaimer.
- There is **no "generated at"** line: the document is deterministic and prints only the effective
  date (OQ-US08-12). Do not add one.

States to draw: draft preview with a diagonal "DRAFT — not effective" watermark; effective
document; superseded document — the PDF is immutable, so "Superseded by v3 on 11/02/2026" lives in
the **viewer header**, never on the page; download row with filename `traceability-plan-v2.pdf` and
the SHA-256 (mono, copy button); viewer loading; "link expired, reopen" (download URLs live 300 s).

### 4. Approve flow

`ConfirmDialog` from the design system, one screen, no wizard:

- What happens: "Version 2 becomes effective now (09/10/2026 2:15 PM PDT) and supersedes v1."
- Validation result: the issue list (each with its tab), or "All checks passed".
- Approver line: "Approved by <you>, QA Manager" — self-approval is allowed in P0 and recorded
  (OQ-US08-8).
- Idempotent: pressing twice yields one effective version; show a neutral "Already approved"
  outcome, not an error.

States to draw: blocked (issues listed, Approve disabled); ready; in progress (sub-second, inline
progress, no modal spinner); success (back on the list: v2 effective, v1 superseded, toast with
Download PDF); failure ("Approval rejected" with issue codes).

### 5. Trace request list

Route `/traceability/requests`. Columns: **Request** (`REQ-2026-APPLE-001`), **Requester** (name,
organization), **Received** (`09/17/2026 9:02 AM PDT`), **Due** — date plus the **countdown chip**,
**Status** (Open / Validated / Package ready / Case ready / Closed), **Latest revision** (`r1`),
**Case ready** (yes/no with icon), actions. Filters: status, "due before". Primary action **New
trace request**.

The countdown chip is the signature element of the section and must read without color:

| Situation                 | Chip text              | Tone      | Icon         |
| ------------------------- | ---------------------- | --------- | ------------ |
| more than 4 h left        | `Due in 21 h 10 m`     | neutral   | clock        |
| under 4 h left            | `Due in 1 h 48 m`      | attention | clock        |
| past due                  | `Overdue by 40 m`      | error     | alert        |
| alternate deadline agreed | `Due in 46 h · agreed` | neutral   | clock + note |
| closed                    | `Closed 09/17 3:12 PM` | muted     | check        |

An alternate deadline shows its recorded reason on hover and in the detail header.

States to draw: empty (explains the drill in allowed wording: "Log a trace request, validate data
readiness, prepare the package — all local; nothing is sent anywhere"); populated with one row in
each countdown situation; loading; error; stale/offline ("Countdowns may be behind; last update
12 s ago").

### 6. Request wizard

Four `DataTabs` steps; the request row is created after step 1 so a reload never loses the drill
("Draft request saved"). Steps are keyboard-reachable and completed steps are revisitable.

**Step 1 — Requester and timing.** Request number (user-entered, unique per tenant; the demo uses
`REQ-2026-APPLE-001`), requester name, organization, contact (as given, not normalized),
**Received at** (defaults to now in tenant timezone), **Due at** pre-filled +24 h and shown as a
live countdown beside the field. Editing Due at reveals the mandatory **Agreed alternate deadline
reason** (free text in P0, OQ-US09-12). Due must be after received.

**Step 2 — Scope.** Product (combobox), date range, TLC list (chips, paste several), locations.
Opened from the search page ("Create trace request from results", owned by U.S. brief 04) the
fields arrive prefilled and a banner says "Scope copied from search: 1 lot, 3 events". A live
preview line shows matched counts ("2 lots · 3 events · 3 locations"). At least one selector.

**Step 3 — Validation.** Screen 7. **Step 4 — Prepare package.** Screen 8.

States to draw: step 1 default and with the alternate-deadline reason revealed; step 2 empty,
prefilled-from-search, and "no records match this scope" (warning, not error — a drill may
legitimately find nothing); saving between steps; RU step bar.

### 7. Dry-run validation results

One **Run validation** button; results grouped by severity (Error / Warning / Info, each with a
count and icon), then by CTE (Receiving, Transformation, Shipping). A row: code, KDE group and
field (data-dictionary grouping: Lot, Quantity, Product, Previous source, Receiving location, Date,
References), message, and a provenance link to the event or lot (`Receiving · rev 2 ·
OSS-260914-A2`).

Errors block the _case-ready_ badge. **Acknowledge and continue** appears only when errors exist,
requires a reason and records who/when. The acknowledgement is tied to a data digest: if any record
changes afterwards a **stale banner** appears ("Data changed since this validation — run it again")
and the acknowledgement no longer counts.

**Two variants to draw (OQ-US09-2, not decided):**

- **Variant A — allowed.** Prepare package is enabled even with unacknowledged errors; a warning
  says "The package will be prepared but not marked case-ready". The run then carries a `Case
ready: no` chip with the reason.
- **Variant B — blocked.** Prepare package is disabled until every error is resolved or
  acknowledged; the disabled button carries the reason inline.

The spec recommends A ("the 24 h clock must not be blocked by tooling"); draw both.

States to draw: not validated yet; running; **zero findings** ("0 missing required KDEs" with a
positive icon — the demo money shot, C-013); errors unacknowledged (A and B); errors acknowledged
(reason, actor, time); warnings only; stale.

### 8. Package generation

Single primary button **Prepare package** (never "Generate and submit", never "Send").
Preconditions surface _before_ the click: no effective plan → blocked with "An effective
Traceability Plan is required" and a link to the plan list; empty scope → blocked.

While running: Queued → Processing with a **live elapsed timer** (`00:41`). On **Ready**:

- **Timing panel** (`DefinitionGrid`): Started (operator pressed the button), Generation started,
  Completed, **Elapsed 00:52**, Operator; and **Operator time** since the request was created
  (`11 min 40 s`). Both numbers are evidence — plain, tabular numerals, never in a tooltip.
- **Artifacts table**, keyed by kind, in this order: workbook `.xlsx` (FDA-aligned electronic
  sortable spreadsheet), Traceability Plan PDF (v2, same hash as on the plan list), validation
  report `.json`, request report `.pdf`, `manifest.json`, and the **package ZIP** (with
  `SHA256SUMS` inside). Columns: name, size, **SHA-256** (mono, copy button, full hash on hover),
  Download. P1 adds CSV ZIP and canonical JSON rows with no layout change.
- **Download package (ZIP)** as the primary action; the link lives 300 s — "link expires in 4:59".
- **Case ready** chip (yes / no with the reason).
- **Prepare new revision** with the explainer "Freezes current data as r2; r1 stays unchanged".

States to draw: blocked (no effective plan); queued; processing with timer; ready and case-ready;
ready and **not** case-ready; failed-retryable (error codes from the spec — `PLAN_NOT_EFFECTIVE`
links to the plan, `STORAGE_FAILED` offers Retry); failed non-retryable; download link expired;
revision history with r1 and r2 side by side.

### 9. Request detail

Route `/traceability/requests/:id`. Header: request number, requester, received, due with the
countdown chip, alternate-deadline note, status. Body: scope summary as chips, latest validation
summary, **revision history** (per run: revision, status, case-ready, elapsed, operator, QA
decision, downloads), Prepare new revision, Close request ("Runs stay downloadable after closing").

States to draw: no runs yet; r1 ready; closed; auditor view (downloads only).

### 10. Request report

A PDF inside the package; draw its first page like the plan: requester and scope, received and
due in tenant timezone **and** UTC, timing (started, generation started, completed, elapsed),
operator time, validation summary, artifact table with SHA-256, baseline ID, the allowed-wording
disclaimer and the fixed sentence "Package prepared locally; delivery to the requester is performed
by the covered entity". No logo other than the Markiro mark used on billing documents.

### 11. QA sign-off (P1 — must not block the P0 screens)

A panel on the run detail: Approve / Reject with a mandatory reason, one decision per revision,
shows decider and time. States: no decision yet, approved, rejected. Draw it collapsed so the P0
layout is complete without it.

## Cross-cutting notes

- **Countdown visible from the overview.** The Traceability overview (U.S. brief 02) gains a tile
  "Open trace requests" with the nearest due-at countdown chip and a link to the list — same chip
  component, same rules. The US-00 overview spec does not list this tile yet; treat it as a delta to
  brief 02 and reuse its tile grid.
- **Countdown accessibility.** Text + icon + tone, never color alone; `aria-live="polite"` at most
  once per minute; tabular numerals so the width does not jitter; overdue is also readable in the
  Status column, so a user who cannot see the chip still reads "Overdue".
- **Time-boxed evidence shown plainly.** Started / completed / elapsed are first-class fields in the
  run detail and the report, tenant timezone with UTC beside.
- **Formats.** Dates `MM/DD/YYYY`, times `h:mm AM/PM TZ`; the workbook stores ISO dates
  (`yyyy-mm-dd` typed cells, US-07) but the UI never shows ISO. Quantities decimal + unit
  (`100 case`, `900 lb`). Hashes mono, lower-case hex, 64 chars, copy button wherever shown.
- **RU strings.** Every screen gets an RU pass (status words 1.3–1.5× longer: "Пакет подготовлен",
  "Просрочено на 40 мин"); the countdown chip must not truncate in RU.
- **Dark mode.** Attention and error tones must hold AA on dark; the DRAFT watermark and the PDF
  viewer are light documents inside a dark shell.
- **Wording gate.** Every string is scanned by the prohibited-wording test; put the exact allowed
  disclaimer text in mockups, not lorem ipsum.
- Brief 03 list rules apply: empty, loading, error, stale; destructive actions get confirmation.

## How this grows

- **QA sign-off (RQ-008)** lands in the collapsed panel of screen 11; if preparer and reviewer become
  different roles, only button visibility changes.
- **Review reminders (PLN-009)** move from banner to email; the banner stays as the in-app half.
- **Derived artifacts (EXP-009)** — CSV ZIP and canonical JSON — are extra rows in the artifacts
  table, which is keyed by kind for exactly this reason.
- **Validation history** (OQ-US09-3): if auditors need every dry run kept, screen 7 gains a
  "Previous validations" list beneath the current result; the result layout does not change.
- **Generic profile** (OQ-US08-7 / OQ-US09-16) is out of P0; if added, the request is worded
  "recall drill" and the package has no plan PDF — one row fewer, same table.
- **Plan diff** is out of scope; the list is already frozen rows, so a diff arrives as an action on
  two rows, not a new screen.

## Questions for the designer

1. OQ-US09-2: draw both variants of screen 7 (allowed vs blocked); which reads more honest to a
   first-time QA manager under time pressure?
2. Should the countdown chip change tone at 4 h or at a tenant-set threshold? The spec fixes none;
   propose one and note it on the mockup.
3. Self-approval of the plan is allowed in P0 (OQ-US08-8): should the approve dialog show a soft
   "four-eyes recommended" hint, or stay silent?
4. Prohibited-wording check: inline underline in the textarea, a side panel, or both? It must work
   for RU narrative too.
5. Is the superseded marker in the viewer header enough, or should the versions list also badge the
   download as "historical"?

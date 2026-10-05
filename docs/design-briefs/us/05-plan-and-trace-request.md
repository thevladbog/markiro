# U.S. Design Brief 05 — Traceability Plan and Trace Request (24-hour readiness drill)

> Revised 2026-09-04: read the [shared MVP contract](../../us/mvp-contract.md) first. It resolves cross-slice scope and safety rules and supersedes conflicting draft recommendations below. Design only; implementation is not claimed.

> U.S. series, office mode of the design system (brief 02). Web admin, desktop-first 1440px,
> adaptive down to 1024. Users: the **QA / Traceability Manager** (owns the plan, runs the drill),
> the **Owner / Tenant Admin** (approves, downloads) and the **Auditor** (read-only). EN primary,
> U.S. Spanish secondary; light + dark. This is a **delta to RU brief 03 (admin panel)**: it adds two items,
> **Plan** and **Trace requests**, to the Traceability sidebar group introduced by the earlier U.S.
> briefs, plus one tile on the Traceability overview. Do not redesign the shell, tables, dialogs,
> chips or the PDF viewer chrome; reuse them. Grounded in slice specs US-08 (plan), US-09 (trace
> request) and US-07 (what the package contains).

> US-08 implementation correction (2026-10-02): use the [owner-approved current plan design](../../superpowers/specs/2026-10-02-us-08-traceability-plan-current-design.md). The screen concepts below are target states, not the current route structure. Build them in `apps/admin/src/us/` with the US-only API. A processor profile alone does not establish farm-map non-applicability, and infrastructure statements require an attributed operator confirmation. Synthetic plans and PDFs need a persistent demo label.

> US-09 correction (2026-10-04): use the [current request/package design](../../superpowers/specs/2026-10-04-us-09-trace-request-current-design.md) for new work. These screens are concepts for the existing US in-cabinet navigation, not RU page/routes or implementation evidence. US-07 supplies the frozen XLSX core; US-09 owns requests, complete scope, package and publication. Without configured private US storage, request editing and validation remain available but preparation/download do not.

## Purpose

The request drill defaults to a 24-elapsed-hour deadline and records an agreed alternate time when applicable. This brief makes the response question
answerable in one place: _do we have a current Traceability Plan, and if a request landed right now,
could we prepare a complete package before the clock ran out — and prove how long it took?_

Two records answer it: the **Traceability Plan** (a versioned, approved PDF derived from tenant
configuration) and the **trace request** (a due-at clock, a dry-run validation, a frozen
hash-verified package). The demo (docs/us/demo-scenario.md §5.4 steps 7–8) ends on these screens.

## Design principle: frozen records on a visible clock

Every artifact here is **frozen the moment it matters** and never silently rewritten. A plan version
is approved once and keeps its PDF, configuration snapshot and SHA-256 for the required retention period; a superseding version
sits next to it, it does not replace it. A package run pins the exact event revisions it was built
from; regenerating creates revision 2 and revision 1 stays downloadable byte-for-byte. The UI never
shows a "current" document that could quietly change under an auditor's eyes — it shows versions and
revisions, each with a date, an actor and a hash.

The second half: **the due clock continues through gaps and outages.** Validation can flag missing
data and refuse the _export-ready_ badge. Draft/validation findings remain visible without artifact
storage; actual downloadable reports and packages require the configured private US store. Time is
shown plainly — received, due, preparation started, worker started, report data prepared,
report-render completion and publication completion. The PDF labels its earlier boundary
**Report data prepared at**; actual render/publication completion belongs to run detail, not
retroactively inside that PDF. System/session elapsed is evidence for C-014; C-013 active human time needs
a separately observed drill, not a subtraction of two server timestamps.

Wording rule binding every string: the product **prepares** a package; it never "submits", "sends"
or "uploads" anything to FDA (RQ-007). Buttons must not contain "FDA", "submit" or "upload". The
plan is "designed to support applicable FSMA 204 recordkeeping requirements"; never "compliant".

## Screens

### 1. Plan versions list

Conceptual route `/traceability/plans`; P0 uses the existing in-cabinet U.S. navigation. Table,
newest first: **Version** (`v2`), **Status** chip with text (Draft / Effective / Superseded),
**Effective date** (`09/10/2026`), **Provenance**, retention date when applicable, and actions
(View; Download PDF; Edit for the draft). The version detail shows its change summary and, for a
published version, the recorded approver user ID and approval time. P0 must not substitute the
point-of-contact name/title or a mutable directory name for the approver. Primary action **New
draft** is disabled with a hint when a draft exists ("v3 is open").

Below the table a quiet **retention note**: "Prior versions are retained for at least 5 calendar years
(tenant setting; minimum 2)". The number is data from the profile, not copy.

Two banners may appear above the table (warning tone, icon + text):

- **Configuration changed** — "Configuration changed since v2 became effective: TLC source
  locations, product classifications." with a link to open a new draft. The section list is data;
  a plan-owned contact is not inferred from unrelated configuration.
- **Annual review due** (P1) — "Annual review due on 09/10/2027" when within 30 days or past.

States to draw: empty (no plan yet — explains what the plan is in allowed wording, offers New
draft); draft only (no effective version — the request screens reference this state); effective +
one superseded row; effective + configuration-changed banner; loading; error; stale/offline.

### 2. Plan editor

Conceptual detail `/traceability/plans/:id`; P0 selects the draft inside the cabinet. `DataTabs`,
one tab per section in the fixed order of the domain model:

| Tab                | Derived from configuration (read-only block)                                                   | User-editable                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Record maintenance | profile, retention and timezone; never an unverified backup or storage claim                   | system of record, actual procedures, formats, record locations, roles and confirmed backup/recovery statement |
| FTL identification | current classification workflow and reviewed product facts                                     | identification procedure and actual review cadence                                                            |
| TLC assignment     | current assignment rules, including reviewed exempt-source receiving, and TLC source locations | narrative paragraphs                                                                                          |
| Point of contact   | —                                                                                              | name, title, phone, email                                                                                     |
| Farm map           | only after confirmed no growing/raising of applicable FTL food in this operation               | non-farm declaration and explanation; yes/unknown blocks P0 approval                                          |
| Review and update  | no system-enforced cadence currently                                                           | actual review/update procedure and cadence                                                                    |

Every genuinely derived block is labelled "Derived from configuration" and links to the screen that owns the
fact (profile, locations, products). Operator-confirmed procedures are distinct editable fields in the plan;
they are not automatically derived from architecture or storage settings. Narrative is plain-text
paragraphs (OQ-US08-10). A **Change summary** field sits above the tabs and is mandatory from v2
on. Phone example: `+1 (503) 555-0120`.

**Prohibited wording check.** As the manager types, a phrase from the "Not allowed" column
of docs/us/limitations.md ("FDA approved", "guarantees compliance", …) is identified beside
the affected plain-text field and in an issues panel naming the tab. Do not imply that the
native textarea can underline only a substring. Approve stays disabled while server issues remain.
This is a validation state, not a spell-checker: unmissable, not shaming. The server checks
affirmative variants with spaces, line breaks or hyphens; a simple explicit negative disclaimer
such as "not FDA approved" is not marked as an affirmative claim. The editor may explain the
bounded check, but must not present it as legal review.

Toolbar: **Save draft**, **Preview PDF** (opens a new tab, announced), **Approve**, **Discard
draft** (confirmation; drafts are not regulated records, OQ-US08-4).

States to draw: new draft prefilled from the effective version; draft with validation issues
(missing contact phone, a prohibited phrase, no TLC source location configured — the last links to
Locations); clean draft ready to approve; saving / save error; the configuration-changed banner
inside the editor pointing at the affected tabs; read-only view of an effective or superseded
version (same tabs, no inputs, header "v1 — superseded on 09/10/2026 by v2"); ES tab bar.

### 3. Plan preview and PDF

The PDF is rendered by the API and shown in the cabinet's document viewer. Draw the **document itself**
(first and last page) because it is what the auditor will hold:

- Header: tenant name, profile code, regulatory baseline ID, **Version 2**, effective date with
  timezone, recorded approver user ID and approval instant. The contact's name/title are a
  separate operator statement, not the approver's identity.
- The six plan sections in order, followed by provenance and limitations. Farm activity prints
  the confirmed non-farm declaration plus its explanation; a synthetic demo PDF shows its demo
  marker on every page.
- **Change history** after the plan sections: every prior version — number, approval instant,
  approver user ID, change summary (OQ-US08-13). The table may flow across final pages. This
  approved P0 requirement is not yet in the current renderer and must be corrected before
  claiming the Plan PDF complete.
- Running page number on every page; renderer version and allowed-wording disclaimer in the
  provenance/limitations section. Do not depict them in a footer the renderer does not produce.
- There is **no "generated at"** line: the document is deterministic and prints only the effective
  date (OQ-US08-12). Do not add one.

States to draw: draft preview with a diagonal "DRAFT — not effective" watermark; effective
document; superseded document — the PDF is immutable, so "Superseded by v3 on 11/02/2026" lives in
the **viewer header**, never on the page; download row with filename `traceability-plan-v2.pdf` and
the SHA-256 (mono, copy button); viewer loading; authenticated stream failure and retry. The P0
HTTP endpoint streams a verified stored PDF; it does not issue a 300-second signed URL.

### 4. Approve flow

`ConfirmDialog` from the design system, one screen, no wizard:

- What happens: "If approved, version 2 becomes effective and supersedes v1." Show the actual
  server-recorded effective time only after success; do not predict it in the confirmation dialog.
- Validation result: the issue list (each with its tab), or "All checks passed".
- Approver line: "Your account will be recorded as approver" — self-approval is allowed in P0.
  The completed version displays the immutable approver user ID and approval time (OQ-US08-8).
- Idempotent: pressing twice yields one effective version; show a neutral "Already approved"
  outcome, not an error.

States to draw: blocked (issues listed, Approve disabled); ready; in progress (inline status, duration not promised); success (back on the list: v2 effective, v1 superseded, toast with
Download PDF); failure ("Approval rejected" with issue codes).

### 5. Trace request list

Conceptual `/traceability/requests` view inside the US cabinet. Columns: **Request** (`REQ-2026-APPLE-001`), **Requester** (name,
organization), **Received** (`09/17/2026 9:02 AM PDT`), **Due** — date plus the **countdown chip**,
**Status** (Open / Validated / Package ready / Export-ready / Closed), **Latest revision** (`r1`),
**Export-ready** (yes/no with icon), actions. Filters: status, "due before". Primary action **New
trace request**.

Validated/package/export-ready labels are derived from the latest matching validation and run;
they are not independent stored request statuses. Show the run mode and its separate result in
the list rather than treating an incomplete package as export-ready.

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
readiness, prepare the package — prepared in this instance; nothing is submitted to FDA"); populated with one row in
each countdown situation; loading; error; stale/offline ("Countdowns may be behind; last update
12 s ago").

### 6. Request wizard

Four `DataTabs` steps; the request row is created after step 1 so a reload never loses the drill
("Draft request saved"). Steps are keyboard-reachable and completed steps are revisitable.

**Step 1 — Requester and timing.** Request number (user-entered, unique per tenant; the demo uses
`REQ-2026-APPLE-001`), requester name, organization, contact (as given, not normalized),
**Received at** (defaults to now, entered and shown in tenant timezone), **Due at** pre-filled
+24 h and shown as a live countdown beside the field. Both are stored as instants (`timestamptz`);
Due at = Received at + exactly 24 elapsed hours, no calendar arithmetic, so a DST day still yields
24 h (US-09 `defaultDueAt`). Conversion to tenant time happens only for display — the pre-filled
value, the countdown and an edited Due at are all shown in tenant time and saved as instants. Editing Due at reveals the mandatory **Agreed alternate deadline
reason** (free text in P0, OQ-US09-12). Due must be after received.

**Step 2 — Scope.** Product (combobox), date range, TLC list (chips, paste several), locations.
Opened from the search page ("Create trace request from results", owned by U.S. brief 04) the
fields arrive prefilled and a banner says "Scope copied from search: 1 lot, 3 events". A live
preview line shows matched counts ("2 lots · 3 events · 3 locations") and whether the server
resolved the **complete** scope. Counts from a limited search page are not export proof. At least
one selector is required for validation; step 1 may save a request shell without one.

**Step 3 — Validation.** Screen 7. **Step 4 — Prepare package.** Screen 8.

States to draw: step 1 default and with the alternate-deadline reason revealed; step 2 empty,
prefilled-from-search, and "no records match this scope" (not an infrastructure error, but never
Export-ready); saving between steps; ES step bar. A scope above the supported server bound shows
a visible limit finding, never a silent partial count.

### 7. Dry-run validation results

One **Run validation** button; results grouped by severity (Error / Warning / Info, each with a
count and icon), then by CTE (Receiving, Transformation, Shipping). A row: code, KDE group and
field (data-dictionary grouping: Lot, Quantity, Product, Previous source, Receiving location, Date,
References), message, and a provenance link to the event or lot (`Receiving · rev 2 ·
OSS-260914-A2`).

Errors block **Prepare export-ready package** and the **Export-ready** badge. Keep a separate
authorized **Prepare available records — incomplete** action with an **Incomplete** label,
findings, unavailable artifacts and the frozen request revision. Acknowledgement never waives
errors; preparing or downloading does not fulfil the request. Findings remain readable while
private storage is unavailable, but package preparation and downloads are disabled. The due
clock continues. Both paths enforce tenant/export permissions.

A changed scoped-content digest shows “Data changed since validation: run it again”. Revalidate a
changed snapshot for either mode. For export-ready, resolve errors, obtain a nonempty complete
scope and an effective Plan; incomplete mode records these gaps without bypassing permissions or
profile restrictions. The later full workbook-input digest includes the frozen generation time;
it is not the stale-validation comparator.

States: not validated; running; zero errors; errors with source links; warning acknowledgement; stale validation; incomplete traversal; no effective plan; successful empty retrieval with scope shown; failed retrieval/storage/rendering. Technical failures must never use the successful Incomplete state. Download initiation is not proof of human review.

### 8. Package generation

Primary button **Prepare export-ready package** (never "Generate and submit", never "Send"). The
secondary **Prepare available records — incomplete** action creates a separately labelled run,
with available records, validation and manifest; absent Plan or artifacts are explicit. Once a
run is ready, its downloads appear separately. Reuse the progress/history layout with mode and
completeness shown in list, detail and downloads. See [CLAR-03](../../us/development-clarifications.md).
Preconditions surface _before_ the click: no effective Plan → export-ready blocked with a link
to the Plan list, while incomplete preparation may proceed; no selector or stale validation →
both actions blocked; valid selector with zero matches → only a clearly empty incomplete response
may proceed. Unconfigured private US storage blocks **both** preparation actions and downloads,
but not editing or validation.

While running: Queued → Processing with a **live elapsed timer** (`00:41`). On **Ready**:

- **Timing panel** (`DefinitionGrid`): Preparation started (operator pressed the button), worker
  started, report data prepared, report rendered, publication completed, **System elapsed 00:52**, Operator; and
  **Session age** since the request was created (`11 min 40 s`). These server durations are
  visible evidence, but neither is labelled active human time. C-013 requires an observed drill.
- **Artifacts table**, keyed by kind: workbook `.xlsx` when representable, exact pinned Plan PDF
  when effective, validation report `.json`, request report `.pdf`, `manifest.json`, and the
  **package ZIP** (with `SHA256SUMS` inside). In incomplete mode, absent workbook or Plan rows
  show an explicit reason, not an invented file/hash. Columns: name, size, **SHA-256** (mono,
  copy button, full hash on hover), Download. P1 CSV ZIP and canonical JSON are not P0 rows.
- **Download package (ZIP)** after a ready run; use a bounded authenticated US download, not an
  assumed RU presigned URL or a five-minute expiry countdown.
- **Export-ready** or **Available records — incomplete** chip, never a generic success badge.
- **Prepare new revision** with the explainer "Freezes current data as r2; r1 stays unchanged".

States to draw: export-ready blocked (no effective Plan or findings); storage unavailable for
both actions; queued; processing with timer; ready and export-ready; ready and **incomplete**
with absent-artifact reasons; failed-retryable (storage failure offers Retry of the frozen run);
failed non-retryable (corrupt pinned data cannot be shown as incomplete); authorized download
failure; revision history with r1 and r2 side by side.

### 9. Request detail

Conceptual `/traceability/requests/:id` detail inside the US cabinet. Header: request number, requester, received, due with the
countdown chip, alternate-deadline note, status. Body: scope summary as chips, latest validation
summary, **revision history** (per run: revision, mode, result, elapsed, operator, downloads),
Prepare new revision, Close request ("Runs stay downloadable after closing"). P1 QA decision is
not shown as a required P0 field.

States to draw: no runs yet; r1 ready; closed; auditor view (downloads only).

### 10. Request report

A PDF inside the package; draw its first page like the Plan: requester and scope, received and
due in tenant timezone **and** UTC, timing (preparation started, worker started when known,
**Report data prepared at**), operator and **Elapsed to report data preparation**, validation summary, hashes of artifacts built
before the report (not its own, the manifest's or the ZIP's hash), baseline ID, the allowed-wording
disclaimer and the fixed sentence "Package prepared in the U.S. instance; delivery to the requester is performed
by the covered entity". Publication completion appears later in run detail/audit, not
retroactively inside this PDF; actual PDF-render completion is likewise a later run-detail field.
Unknown worker timing is labelled unavailable, never invented. Synthetic reports show a visible non-operational mark. No logo
other than the approved Markiro mark.

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
- **Time-boxed evidence shown plainly.** Preparation, worker, report-data, report-render and publication times
  are first-class fields in the run detail, tenant timezone with UTC beside. The PDF stops at its
  **Report data prepared at** boundary, before its own rendering; the observed human-time drill is recorded separately.
- **Formats.** Dates `MM/DD/YYYY`, times `h:mm AM/PM TZ`; the workbook stores ISO dates
  (`yyyy-mm-dd` typed cells, US-07) but the UI never shows ISO. Quantities decimal + unit
  (`100 case`, `900 lb`). Hashes mono, lower-case hex, 64 chars, copy button wherever shown.
- **Spanish strings.** Every screen gets an ES pass with expanded status text ("Paquete preparado",
  "Vencido hace 40 min"); the countdown chip must not truncate in Spanish.
- **Dark mode.** Attention and error tones must hold AA on dark; the DRAFT watermark and the PDF
  viewer are light documents inside a dark shell.
- **Wording gate.** Every string is scanned by the prohibited-wording test; put the exact allowed
  disclaimer text in mockups, not lorem ipsum.
- Brief 03 list rules apply: empty, loading, error, stale; destructive actions get confirmation.

## How this grows

- **QA sign-off (RQ-008)** lands in the collapsed panel of screen 11, with a separate permission,
  decision audit and reviewer identity design when P1 is scheduled.
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

1. Resolved by CLAR-03 and the current US-09 design: validation stays visible; separately prepare
   and download the incomplete package only with configured private US storage. Errors cannot be waived.
2. Should the countdown chip change tone at 4 h or at a tenant-set threshold? The spec fixes none;
   propose one and note it on the mockup.
3. Self-approval of the plan is allowed in P0 (OQ-US08-8): should the approve dialog show a soft
   "four-eyes recommended" hint, or stay silent?
4. Resolved for P0: field-adjacent feedback and an issues panel, without substring underlining in
   a native textarea. The server rule applies to English and Spanish narrative alike.
5. Is the superseded marker in the viewer header enough, or should the versions list also badge the
   download as "historical"?

## Artifact display boundary

The report cannot list its own hash or the later manifest/ZIP hashes. The completed run page can list all artifacts after publication. Use the shared-contract hash order and distinguish report-preparation timing from run completion. Plan approval has no unmeasured sub-second promise; show a cancellable wait state only if cancellation is actually supported.

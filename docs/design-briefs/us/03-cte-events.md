# U.S. Design Brief 03 — Critical Tracking Events: Receiving, Transformation, Shipping

> Third brief of the U.S. series. Office mode of the existing design system, desktop-first
> 1440px, adaptive down to 1024. Users: the Receiving, Production and Shipping Operators who
> record events, the QA / Traceability Manager who finalizes, amends and voids them, and the
> Auditor who reads. English primary, Russian secondary; light + dark. This is a **delta to
> RU brief 03** (admin panel): it adds three event forms, one event list and one detail page to
> the cabinet's `Traceability` section. Do not redesign the catalog, shifts, boxes or the RU
> history screens — the U.S. forms reuse the office components (tables, side panels, status
> chips, confirm dialogs). Grounded in slice specs US-03/04/05 and `docs/us/data-dictionary.md`
> §7.3–7.5; open UI choices are collected at the end.

## Purpose

A processor records three things about a food lot: it arrived, it was turned into something
else, it left. Under the FDA Food Traceability Rule those are the Receiving, Transformation and
Shipping critical tracking events, each with a fixed set of key data elements (KDEs). Markiro
U.S. Traceability is designed to support applicable FSMA 204 recordkeeping requirements: these
forms are where the KDEs are captured, checked for completeness, frozen, and — when reality
changes — corrected without losing the earlier record.

Three forms drawn as three unrelated screens would be three products: trace (brief 04), the
XLSX export and the trace request (brief 05) read events as one shape, and the QA Manager
reviews all three in one sitting. The job is one component family, three configurations.

## The core idea: one event anatomy

Every event, regardless of type, is drawn from the same five regions, top to bottom:

1. **Header** — type, event number, status chip, the CTE date, the tenant's own location for
   this event, and the actions that apply to the current status.
2. **Lines** — one row per lot. The only region whose columns differ per type.
3. **Reference documents** — business records (ASN, BOL, work order, batch log, invoice…)
   linked as type + number; several allowed.
4. **Completeness panel** — what is still missing before finalization, by KDE group and line.
5. **Audit / revision strip** — who created and finalized, when, revision number, links to
   previous and next revisions, void reason if any; U.S. brief 02's History panel underneath.

Why not a wizard: the operator rarely has the data in wizard order — the BOL arrives before
the truck, the TLC is on the pallet tag. An event is a **draft you fill in any order** plus a
panel that says what is left (the "Draft — complete it" idea of RU product cards, extended to
lines). The audit strip is in the anatomy, not a tab, because a finalized event is a regulated
record: "which revision is this and who signed it" needs no click.

### Event numbers and statuses

Events get a per-type number kept across revisions: `REC-26-0001`, `TRN-26-0001`,
`SHP-26-0001`. The status chip carries text and an icon, never color alone:

| Status    | Chip text (EN / RU)                    | Meaning for the UI                                                                  |
| --------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| Draft     | Draft / Черновик                       | Editable; excluded from trace, exports and readiness.                               |
| Finalized | Finalized / Финализировано             | Read-only; snapshots frozen; included everywhere.                                   |
| Amended   | Amended, rev 1 of 2 / Изменено, ред. 1 | A later revision supersedes it; viewable; excluded from trace by default.           |
| Void      | Void / Аннулировано                    | Not deleted; reason and actor shown; excluded from exports with the reason as note. |

The chip shows the revision above 1 ("Finalized, rev 2"). A draft created by an amendment
reads "Draft, rev 2 — amending REC-26-0001 rev 1" so nobody mistakes it for a new event.

## Screens

### 1. Events list

One list for all three types, route `Traceability → Events`, with the type as a filter rather
than three lists — the QA Manager's question is "what is waiting for me", not "which
receivings". Per-type entry points (New receiving / transformation / shipping) form a split
button in the header, each gated by its own write capability.

Columns: event number, type (icon + text), status chip, CTE date (MM/DD/YYYY), location (the
tenant's own site), counterpart (previous source for receiving, recipient for shipping,
"2 inputs → 1 output" for transformation), lines, documents (count; numbers on hover),
revision, updated. Row click opens the detail page; the row menu offers Open, Amend, Void (QA
only). Filters mirror the query: type, status, date range, location, reference number, free
text (event number, TLC, document number). A transformation created with a closed shift
attached carries a **"from shift SEP26-003"** badge in the counterpart column — the same
visual as the RU "created on line" badge on shifts. Demo rows: the three events of screens 2–4.

States to draw: empty ("No traceability events yet" with the three create actions), loading
(skeleton rows), error with retry, stale ("updated 40 s ago"), filtered-to-nothing, all four
status chips present, and a draft revision 2 beside its finalized revision 1 (toggle "show
superseded revisions", off by default).

### 2. Receiving form

Persona: Receiving Operator, then QA finalizes. The KDE groups of data-dictionary §7.3 are the
section labels (U.S. brief 02's group header with its "Required for case-ready" marker), so
the regulatory grouping is visible in the form itself. **Header (event level)** — `Date received` (date picker; tenant timezone America/Los_Angeles shown as text
once), `Receiving location` (combobox over the tenant's own receive-at locations; the selected
card shows business name, phone, street, city, state, ZIP, country), `Immediate previous
source` (combobox over partner locations; same card), operational `Dock / note`. One previous
source per event; a mixed delivery is two events (OQ-US03-11).

**Lines** — a table where each row is a lot:

| Column          | Control                                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product         | Combobox with search; below it the **product description snapshot** preview: name, brand, commodity, variety, packaging size + style                     |
| TLC             | Monospace input; opaque string, no format hint                                                                                                           |
| TLC source      | Toggle: **Source location** (combobox) or **Source reference** (text); one of the two is required                                                        |
| Quantity        | Decimal input + unit select from the closed list (lb, oz, kg, g, each, case, bag, cup, gal, l)                                                           |
| Exempt supplier | Checkbox; reveals `Reason` (required) and `Supplier lot reference`; TLC source locks to the receiving location: "You assign the TLC; source = this site" |
| Link            | "Create lot on finalize" (default) or "Link existing lot" (picker filtered to product; TLC must match)                                                   |

Demo: line 1 `OSS-260914-A1`, Fresh-Cut Red Delicious Apple Slices, Orchard Slice, 10 lb bag,
500.000 lb, source Orchard Slice Supply LLC (Yakima, WA); line 2 `OSS-260914-A2`, same
product and source, 500.000 lb.

**Reference documents** — picker with inline create (type, number, issuing party, issued on).
Demo: `ASN-2026-0914-001` (ASN), `BOL-0914-A` (BOL); required under the FSMA processor profile,
a warning under the generic one. **Actions**: Save draft, Finalize (QA capability; disabled
with the reason "3 required elements missing" while the panel has errors), Discard draft.

States to draw: new empty draft; draft with two lines and one error per KDE group (missing
phone on the previous source, blank TLC, no document); exempt-supplier line expanded; "link
existing lot" line with a TLC mismatch; save conflict (409 `not_draft`, finalized meanwhile);
draft revision 2 with locked TLC/source cells ("lot identity is locked after finalization;
void and re-enter to change it").

### 3. Transformation form

**Header** (Production Operator, then QA; groups of data-dictionary §7.4) — `Reason` select
(Commingling and repacking, Repacking, Relabeling, Processing, Other + note), `Completion
date` with the tenant timezone as text, `Transformation location` (becomes the TLC source of
every output — say so in a helper line), `Closed shift` (optional combobox over closed shifts:
number, product, production date, linkable cases; "100 cases will be linked at finalization").

**Inputs** — rows pick existing lots (combobox by TLC or product; option shows product, TLC,
source, status chip), `Regulated` checkbox (FTL input that must carry a lot; off = free-text
ingredient), `Quantity used` + unit, `Consumes lot` (default on). Demo: `OSS-260914-A1`
500.000 lb and `OSS-260914-A2` 500.000 lb, both regulated, both consumed.

**Outputs** — rows create new lots: product combobox, `TLC` input with a **Suggest** button
(`NRF-260915-APL01` pattern, editable), quantity + unit, production and expiry dates
(operational). Source is read-only "= the transformation location". Demo: Fresh-Cut Apple
Snack Cups, North River, 6 oz cups, 24 cups/case, `NRF-260915-APL01`, 100.000 case.

**Genealogy preview** — a small inline diagram under the tables: 2 input nodes → 1 output
node, quantities on the edges, redrawn as rows change; the trace graph of brief 04 at its
smallest, same node and edge styles. **Operational block (P1, labelled "Operational — not an
FDA KDE")** — planned output, waste (demo: 100 lb trim loss), computed yield shown only when
all quantities share one unit, otherwise "not comparable across units". **Reference
documents** — at least one of work order, batch log, production log. Demo:
`WO-2026-0915-APPLECUP` (work order), `BATCH-2026-0915-01` (batch log).

States to draw: empty; draft with two inputs, one output and the preview; shift selected with
the cases hint; a quarantined input lot disabled in the picker with the reason; completeness
row "output product coverage status unknown — review the product first" linking to the FTL
card; finalized view with the Cases panel (100 linked, first/last SSCC, link to boxes);
multi-output draft with the "cases must be linked manually" hint.

### 4. Shipping form

Shipping Operator, then QA; groups of data-dictionary §7.5. The rule that shapes this screen:
**a shipment never creates a lot** — no TLC input, no product input, no "new lot" affordance.

**Header** — `Date shipped`, `Ship-from` (own location, role ship-from), `Immediate
subsequent recipient` (partner location; helper "the recipient, not the transporter"),
operational `Carrier reference`.

**Lines** — `Lot` picker (option: product, TLC in monospace, source, status chip, "100 case
remaining"); TLC and product show read-only once picked, with a lock glyph and the tooltip
"TLC comes from the lot". `Quantity` + unit (defaults to the lot's origin unit) with the
balance beside it ("100.000 of 100.000 case"); a partial quantity shows "60 case will remain —
partial shipment"; a quantity above the balance shows the over-shipment warning (warning, not
error). `Cases` (P1, clearly marked optional): SSCC scan/paste list with the counter "N of 100
cases in lot" and a "Set quantity from cases" button that never fires by itself.

**Flow warnings (P1)** — when the recipient address normalizes to the ship-from address, or
the flow is marked direct-to-consumer, donation or intra-company transfer, a warning card asks
the user to classify the flow and tick "I have classified this shipment myself". The copy
states no legal conclusion. The recipient being the same location _record_ as ship-from is an
error, not a warning. **Reference documents** — BOL, invoice, ASN.

Demo: `SHP-26-0001`, 09/16/2026, ship-from North River Fresh Foods LLC, 500 Example River
Pkwy, Portland, OR 97203, +1 (503) 555-0120; recipient Harbor Market Distribution Center,
200 Example Harbor Ave, Seattle, WA 98134, +1 (206) 555-0147; line `NRF-260915-APL01`
100.000 case, balance 100 → 0; documents `BOL-0916-H`, `INV-2026-0916-047`.

States to draw: empty; one full line; partial shipment; over-shipment warning; blocked lot in
the picker (quarantined, recalled) and unavailable lot (consumed, archived); flow warning card
with the classification select; P1 case selector with three SSCCs; finalized, lot Shipped.

### 5. Completeness panel

The same component on all three forms and on the detail page. It lists **missing KDEs by
group, then by line**:

```text
Previous source     Phone number is missing                          → Locations
Lines · Line 2      TLC source location or reference is required
References          Add at least one reference document
```

Each row is a link that moves focus to the field (or to the master-data card when the gap is
in a location or product). Errors block Finalize; warnings do not (same TLC on two lines with
the same source; previous source equals receive-at; over-shipment). The header shows the count
in text: "3 required elements missing" / "Complete — ready to finalize". The server can also
refuse (`409 event_incomplete` with the same issue list, e.g. a colleague changed a location
card meanwhile): draw it as the panel refreshing with "Re-checked just now: 1 new issue".

Shipping adds a fourth kind of issue (P1, US-05): the same-address and non-standard-flow
warnings require acknowledgement. They do not disable Finalize, but the confirm dialog carries a
required checkbox ("I confirm this flow is intended"); without it the server answers
`409 flow_warning_unacknowledged` and the panel shows the warning with an "Acknowledgement
required" marker until the box is ticked (stored as `flow_warning_acknowledged_at / _by`). Ordinary
warnings stay non-blocking and need no acknowledgement.

States to draw: complete; errors only; errors + warnings; warnings only (Finalize enabled,
warnings restated in the confirm dialog); warnings requiring acknowledgement (shipping, checkbox
in the dialog, 409 after an unticked attempt); stale after 409; the generic-profile variant where
the document rule is a warning.

### 6. Finalize confirmation

A confirm dialog restating what will be frozen: type, number, date, line count and total
quantity per unit, documents, and the consequence per type — Receiving: "2 lots will be
created"; Transformation: "1 lot will be created, 2 lots marked consumed, 100 cases linked";
Shipping depends on the balance (OQ-US05-1 (a)): when the shipped quantity takes the balance to
zero, "lot NRF-260915-APL01 will be marked shipped"; for a partial shipment, "lot NRF-260915-APL01
balance 100 → 40 case; the lot stays active". Warnings are listed again. The primary
button reads "Finalize" — never "Submit"; nothing is sent anywhere. States to draw: default;
with warnings; in progress; failure (409 issue list inside the dialog, "Back to form").

### 7. Amendment flow

Amend is available on a finalized event to the QA Manager. It opens a dialog with a required
`Reason` and creates **draft revision 2** of the same number. The editor shows the previous
revision in a right-hand read-only pane (side by side at 1440, tabbed at 1024) with changed
fields highlighted as the user edits. Lot identity cells (TLC, source, product) of lines that
already created lots are locked (screen 2). Finalizing turns revision 1 into Amended.

States to draw: reason dialog; side-by-side editor with two changed fields; locked identity
cells; revision 1 detail after supersession (banner "Superseded by rev 2 on 09/18/2026 by
A. Reyes — reason: quantity corrected after recount", with link).

### 8. Void flow

Void applies to drafts and finalized events; reason required. The event stays in the list and
on lot cards, greyed with the Void chip; its detail page opens with a banner: reason, actor,
time, "Excluded from trace results and exports; the exclusion is recorded with this reason".
Consequences differ by type and the dialog must say so: Receiving — lots it created stay and
appear on the readiness dashboard as "created by a void event"; Transformation — refused while
a finalized shipment uses the output lot (409 naming the shipment, with link), otherwise
output lots are archived; Shipping — the lot balance is restored, status may return to Active.
States to draw: void dialog per type; refusal for transformation; voided detail; voided row.

### 9. Event detail page (finalized)

Read-only anatomy with the KDE groups as headed blocks and every value taken from the
**snapshot**, not the live master record. When the location or product card has changed since
finalization, the block shows a quiet note "Master data changed since finalization — this
record keeps the values as finalized" with a link to the current card. The revision strip
shows the chain (rev 1 Amended → rev 2 Finalized), the audit lines (created, finalized,
amended — by whom, when, tenant time) and the documents with their snapshotted numbers.
Transformation adds the genealogy summary and the Cases panel; shipping adds balance
before/after per line. States to draw: finalized rev 1; rev 2 with chain; amended (superseded)
view; void view; "master data changed since" note; loading; not found.

## Cross-cutting notes

- **Never Edit or Delete on a finalized event.** The only actions are Open, Amend, Void,
  Print/Export. If a pencil icon feels missing, the amendment entry point is not visible enough.
- **Keyboard-first line entry.** Operators enter ten lines from one BOL: Tab moves across a
  row, Enter on the last cell adds a row, Esc discards an unsaved row, arrows move between
  rows; focus ring on cells, not only inside inputs; comboboxes accept a scanned or pasted TLC.
- **Quantities are decimal + explicit unit** everywhere ("500.000 lb"), tabular numerals, no
  unit conversion anywhere in the UI. **Dates** MM/DD/YYYY in tenant time; the timezone name
  appears once per form, next to the CTE date.
- **Wording.** Only the allowed wording of `docs/us/limitations.md`. Statuses are Draft /
  Finalized / Amended / Void; the completeness panel speaks of "required elements" and "data
  completeness", never of compliance.
- **RU strings.** Layouts must survive "Финализировано, ред. 2", "Аннулировано",
  "Недостающие обязательные элементы: 3" and long location names; check the line table at
  1024 with RU headers. **Dark mode.** Locked cells, snapshot notes and the greyed void state
  need their own dark tokens — grey-on-grey locks vanish on the laptop next to the dock door.
- **Accessibility (NFR-012).** Every status is text + icon; dialogs trap and return focus;
  completeness rows are real links; the genealogy preview has an `aria-label` and a text list.
  Standard list requirements from RU brief 03 apply: empty, loading, error, stale.

## How this grows

- **CSV import preview (P1).** "Import lines from CSV" on receiving and shipping opens a
  preview with the line editor's columns plus a per-row status (accepted / rejected with the
  issue) and an error report download; "Apply accepted rows" creates one draft event. The
  preview is the line editor read-only with a status column, not a new screen.
- **Station offline receiving / shipping (P2).** Events with `source = station` show a
  "recorded on station" badge like "from shift"; drafts synced later land in the same list.
- **Partner mapping profiles (P1).** A partner's CSV column names map to the same line fields;
  the mapping editor lives with the party, the import preview only names the profile applied.
- **More CTEs later** (harvesting, cooling, initial packing) are new header + line
  configurations of the same anatomy; if one cannot be expressed that way, fix the anatomy.

## Questions for the designer

1. Screen 1: one mixed list with a type filter (as drafted) or three lists under one section
   header? The specs describe three routes; prototype both.
2. Screen 2: the exempt-supplier toggle locks the TLC source to the receiving site. Disabled
   combobox, or a plain text line replacing it?
3. Screen 3: where does the genealogy preview live with more than four inputs — inline,
   collapsible, or detail page only?
4. Screen 4: the P1 case selector must read as optional ("lot-level workflow with optional
   case scanning"). Collapsed section, secondary tab, or per-line drawer?
5. Screen 5: the specs answer a failed finalize with `409 event_incomplete` (receiving,
   shipping) and `422 TRANSFORMATION_INCOMPLETE`; confirm one panel-refresh pattern covers both.
6. Screen 7: side-by-side previous revision at 1440 and tabbed at 1024, or an inline
   "was: 480.000 lb" under each changed field at all widths?
7. Screen 8: void consequences differ per type — one dialog with a per-type consequence
   paragraph, or three dialogs?
8. Under `US_GENERIC_LOT_TRACEABILITY` the same forms run with the document rule relaxed, no
   FTL wording, and the Scenario B statement "not classified as FTR-covered" — banner or sub-line?

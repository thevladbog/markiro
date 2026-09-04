# U.S. Design Brief 04 — Search, Lot Card, Trace Graph and Readiness

> Fourth brief of the U.S. series. Office mode, desktop-first 1440px, adaptive down to 1024.
> Users: the QA / Traceability Manager (runs traces, watches readiness), the Auditor / Read-only
> user (reviews history), the Owner / Tenant Admin (readiness on the dashboard) and the three
> operators (look up a lot before recording an event). English primary, Russian secondary;
> light + dark. This is a **delta to RU brief 03 §5 (History & codes)**: the U.S. equivalent of
> the code page and the aggregation tree, drawn for lots and events instead of marking codes
> and boxes. Do not redesign the RU code search; reuse its lookup box, card and left-border
> timeline. Grounded in slice spec US-06 and the lot card notes of US-02; open UI choices are
> collected at the end.

## Purpose

After brief 03 the tenant holds lots, three kinds of finalized events and genealogy edges. A
recall, an auditor or a mock trace request asks four questions: where did this output lot come
from, where did this input lot go, which lot carries TLC X / BOL-0916-H / this SSCC, and what
is still missing before we can answer. The 24-hour trace request workflow (brief 05) starts
from a search on these screens, and the acceptance targets are hard: a trace graph in under
2 s, an exact lookup in under 1 s. Everything here is read-only over brief 03's data.

## The core idea: one trace result

A trace is **one query result** — nodes (lots and locations), edges (received from, genealogy,
shipped to, each with quantity and unit), the events behind them, the events **excluded** with a
reason (void, superseded, draft), and provenance. The graph draws nodes + edges; the table
lists edges; the counts are therefore identical by construction, and both views show the same
metric strip (nodes / edges / excluded). If the two ever disagree, the UI must show it, not
hide it — an auditor will compare them.

Two rules follow. **Provenance everywhere**: every row, node and number carries the event
number and revision it came from, as a link. **Readiness is data completeness, never
compliance**: the dashboard score is labelled "Data readiness" with the hint "Explanatory only,
not a compliance score", findings are missing or inconsistent elements, and product coverage
remains a manual review that the screen never decides for the user.

## Screens

### 1. Search

Route `Traceability → Search`. Top: an **exact lookup box** (monospace) for a TLC, a reference
number, an SSCC (scanned `(00)` prefix stripped) or a lot id; the server classifies the input
and answers an exact hit in under 1 s. Below: a filter row — product, TLC list (chips), **TLC
range** with the visible note "text order (A–Z), not numeric", date range, CTE type, location,
reference type + number, SSCC, lot status.

Results are lot rows: TLC (mono), product snapshot summary, source, status chip, chain counts
(Receiving 1 · Transformation 1 · Shipping 1), first / last event date, "matched by" chips
(TLC, reference, SSCC, product, location, date). Row click opens the lot card. Header action
"Create trace request from these results" (QA capability) hands the applied filters to brief
05 as a scope summary — no second search there.

Demo: `NRF-260915-APL01` → one hit, matched by TLC; product "Fresh-Cut Red Delicious Apple
Slices" → `OSS-260914-A1`, `OSS-260914-A2`; `BOL-0916-H` → `NRF-260915-APL01` matched by
reference; an SSCC of the 100 cases → the same lot, matched by SSCC with an "active link" tag.

States to draw: before search (what can be searched, with a scan hint); exact hit; filtered
results with matched-by chips; no results (applied filters restated, "clear filters");
unrecognized input; not found for exact lookup; loading (exact lookup: button state only, no
skeleton; filtered list: skeleton rows); error with retry; stale after a failed refresh;
paging at 50 per page; the TLC-range filter open with its note.

### 2. Lot card

Route `/traceability/lots/:id`. U.S. brief 02 draws the header and body groups; this brief
adds the trace actions and the panels, and restates the header so the mockup is coherent.
**Header**:
TLC (mono), status chip (Active / Consumed / Shipped / Quarantined / Recalled / Archived, plus
the derived "Partially shipped" label), assignment basis (Imported / Transformation / Exempt
supplier receipt), product description snapshot, TLC source (location card or reference),
origin event link, balance ("0.000 of 100.000 case remaining"; "balance unknown" for manual
lots), production / expiry dates marked operational. Actions: **Trace backward**, **Trace
forward**, Change status (reason required), Link cases (P1).

**Panels**, each with a provenance column (event number + revision, linked):

| Panel        | Content                                                                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CTE timeline | Left-border list as on the RU code page: date, type, event number, revision, status, location, quantity; amended chains collapsed under the current revision; void events greyed with reason |
| Documents    | Type, number as snapshotted, event, link                                                                                                                                                     |
| Cases        | Count, first / last SSCC, list with link source (shift link / manual), unlink with reason (P1)                                                                                               |
| Findings     | Completeness findings for this lot: severity chip with text, field, message, deep link; "No gaps found" when clean                                                                           |
| Genealogy    | Inputs and outputs as lot links (2 inputs for the demo output; 1 output for each input)                                                                                                      |

Demo: `NRF-260915-APL01` — Transformation, source North River Fresh Foods LLC (Portland, OR),
Fresh-Cut Apple Snack Cups, Shipped, 0 of 100 case; timeline `TRN-26-0001` rev 1 09/15/2026
(output, 100.000 case) → `SHP-26-0001` rev 1 09/16/2026 (100.000 case → Harbor Market
Distribution Center); documents WO / BATCH / BOL / INV; 100 cases; inputs `OSS-260914-A1`,
`OSS-260914-A2`; no findings. `OSS-260914-A1` — Imported, source Orchard Slice Supply LLC
(Yakima, WA), Consumed; timeline `REC-26-0001` → `TRN-26-0001`; output `NRF-260915-APL01`.

States to draw: clean lot; lot with findings (missing TLC source); "created by a void event"
notice; lot with no events yet ("No events yet — balance unknown"); partially shipped lot
(60 of 100 case); quarantined lot with the status-change dialog; loading; not found;
generic-profile variant (Scenario B banner, "lot source" instead of "TLC source").

### 3. Trace view

Route `/traceability/lots/:id/trace`. Controls: direction segmented control **Backward |
Forward | Both** (text labels), depth (default 16), "include drafts" toggle (operators only,
off by default, never in export-ready views). A metric strip — nodes, edges, excluded — sits
above the **Graph | Table** tabs and reads the same on both.

**Graph** — a hand-drawn layered SVG, no graph library, sized for small graphs: layers by depth
from the root, nodes ordered deterministically within a layer — lot nodes by TLC then id,
location nodes by kind, then name, then id — straight edges. Lot nodes are rounded
rectangles (TLC mono, product short name, status chip); location nodes are outlined hexagons
with a pin glyph (business name, city, state). Edge labels: quantity + unit and the event
number. Excluded events (void, superseded) are drawn greyed and dashed with the reason in a
tooltip and in the table. Shapes and glyphs carry meaning; color never alone. Selecting a table
row highlights the node; arrow keys through the table walk the graph (keyboard navigation of
the graph is the table). The SVG has `role="img"`, an `aria-label` with the counts and a
visually hidden list of nodes.

**Table** — one row per edge: from, to, kind (received from / genealogy / shipped to),
quantity + unit, event number, revision, status, date, provenance link.

Demo backward from `NRF-260915-APL01`: nodes Orchard Slice Supply LLC (location),
`OSS-260914-A1`, `OSS-260914-A2`, `NRF-260915-APL01`; edges Orchard → A1 received from 500 lb
`REC-26-0001`, Orchard → A2 500 lb `REC-26-0001`, A1 → APL01 genealogy 500 lb `TRN-26-0001`,
A2 → APL01 500 lb; strip 4 / 4 / 0. Forward from `OSS-260914-A1`: A1 → APL01 (`TRN-26-0001`),
APL01 → Harbor Market Distribution Center shipped to 100 case `SHP-26-0001`; strip 3 / 2 / 0.

States to draw: backward; forward; both (root in the middle); **no genealogy yet** (a freshly
received lot: root only, "This lot has not been transformed or shipped yet"); with an excluded
void event (greyed, "Excluded: void — reason"); with a superseded revision excluded; **depth
limit** ("Stopped at depth 16 — 3 lots not expanded", with a deeper-depth action); drafts
included with a warning strip; loading ("Building trace…" progress line, target under 2 s, no
spinner-only); timeout ("The trace took too long — try a smaller depth"); error; not found.

### 4. Readiness dashboard

Route `Traceability → Readiness`. Metric strip: **Data readiness** (hint "Explanatory only,
not a compliance score"), checks run, errors, warnings, infos; scope line "last 24 months"
with a date window, product and lot filters. Group-by select **CTE | Product | Partner |
Severity**; a grouped table with severity chip (text), CTE, product, partner, field, message
and a record link (event number + revision, or lot TLC) — every gap deep-links to the event
or lot it belongs to. An info alert states that coverage status remains a manual review.

**Overdue classification reviews (P1)** — a group "Product reviews due" from the review due
date, each row linking to the product FTL card. **TLC / source consistency findings** appear
in the same table with the presentation of screen 5.

Demo (the acceptance screenshot): 0 errors, 0 warnings across 3 events and 3 lots — "0 required
elements missing". A second mock: `REC-26-0001` rev 1 · Line 2 · "TLC source location or
reference is missing" (error); lot `OSS-260914-A3` · "created by a void event" (warning);
product Fresh-Cut Apple Snack Cups · "coverage status unknown — review required" (error).

States to draw: empty ("Nothing to check yet" when there are no lots); all clear; findings
grouped by each of the four group-bys; filtered to one product; date window changed; loading
("Checking 3 events, 3 lots…"); error with retry; generic-profile variant (Scenario B banner,
FTL rules absent); P1 partner group present.

### 5. Consistency-rule finding

The TLC / source consistency rule is the weakest KDE in practice, so its finding is a card,
not a line. It shows the conflicting values side by side with their provenance:

```text
TLC OSS-260914-A1 · source disagrees                                  Error
  Lot record            Orchard Slice Supply LLC, Yakima, WA
  SHP-26-0001 rev 1 · line 1   Source reference "OSS-PO-4471"
  Open lot · Open event
```

When the later value comes from an amended revision, the severity is Info and the card cites
the amendment: "changed in REC-26-0001 rev 2 — reason: supplier corrected the source". There
is no "fix" button; corrections go through the amendment flow of brief 03. Other cross-record
rules (lot without events, output lot without genealogy, broken event–lot link, incomplete
location snapshot, missing or zero quantity, missing reference document) are one-line
findings: field, message, deep link, and the rule code as a small mono tag for support.

States to draw: error; info with amendment cited; the same finding as a row in the readiness
table and in the lot card findings panel.

## Cross-cutting notes

- **Provenance everywhere.** Hovering any number shows "from SHP-26-0001 rev 1, line 1";
  every event number is a link to brief 03's detail page.
- **Performance shapes loading.** Exact lookup shows no skeleton; the graph shows a progress
  line with a message; a refetch keeps the previous result on screen (dashboard pattern).
- **Read-only surface.** The only mutations are Change status and Link / Unlink cases on the
  lot card, both with a reason and a confirm dialog. They are explicit exceptions owned by other
  slices: Change status is US-02 `POST /traceability/lots/:id/status` (`traceability.qa.manage`,
  audit `traceability.lot.status_changed`); Link / Unlink cases is US-04
  `POST /traceability/lots/:lotId/boxes` and `/boxes/unlink` (`traceability.transformation.write`,
  `unlink_reason` recorded, rows never deleted). Users without the capability see the affordance
  disabled with the reason. No edit affordances on events here.
- **Wording.** "Data readiness", "data completeness", "required elements", "gaps"; nothing
  from the not-allowed column of `docs/us/limitations.md`. Generic-profile screens carry the
  Scenario B statement ("not classified as FTR-covered; general lot traceability only").
- **Formats.** Dates MM/DD/YYYY in tenant time; quantities decimal + explicit unit; TLC and
  SSCC always monospace.
- **RU strings.** Check "Готовность данных", "Трассировка назад / вперёд", "Исключено:
  аннулировано", "Недостающие обязательные элементы данных" in the strip, the segmented
  control and the finding card at 1024.
- **Dark mode.** Graph edges, edge labels and greyed excluded nodes need dedicated tokens; the
  SVG must use the same chip tokens as the rest of the page.
- **Accessibility (NFR-012).** Filters are labelled controls; the table is the accessible
  representation of the graph; severity and status are text + icon; focus is visible on nodes
  reached through the table.

## How this grows

- **Partner expectation profiles (P1).** Per-party expectations (direction, data channel,
  case scans required, extra fields) are edited on the party card; their findings arrive as
  the separate "partner" group and never add to the required minimum.
- **Larger graphs.** Above roughly 50 nodes the table stays primary; the graph may move to
  virtualization or a graph library later, but the layout rules (layers by depth, TLC order,
  shapes not colors) must survive the swap. Design the collapsed-layer affordance now
  ("12 lots at depth 3 — expand").
- **Trace request (brief 05)** reuses the search scope and runs the readiness sweep as its
  dry-run tab; the finding presentation here is the one it shows.
- **More CTE kinds** add edge kinds (harvested at, cooled at): one more edge style each, the
  same table.

## Questions for the designer

1. Screen 3: Graph | Table as tabs (spec) or side by side at 1440 and tabbed below it?
2. Screen 3: lot node content — TLC only with a tooltip, or TLC + product short name? Decide
   the truncation rule for 120-character TLCs.
3. Screen 3: locations as nodes (spec) or as swimlane headers grouping lots by site?
4. Screen 3: "Both" — one graph with the root in the middle, or backward and forward stacked?
5. Screen 3: excluded void events drawn greyed in place, or removed from the drawing and kept
   only in the table and the excluded count?
6. Screen 4: score as a percentage ring or as "N of M checks passed" only? A ring may read as
   a grade, which the wording rules want to avoid.
7. Screens 2 and 4: does a finding deep link open the event page or a side panel showing just
   the relevant KDE group?
8. Screen 1: rich lot cards or dense rows as the default result layout, and is a toggle worth
   it?

# U.S. Design Brief 04 — Search, Lot Card, Trace Graph and Readiness

> Revised 2026-09-28 to match the [current US-06 design](../../superpowers/specs/2026-09-27-us-06-current-trace-search-readiness-design.md), the [Search/Trace office design](../../superpowers/specs/2026-09-28-us-06-search-trace-office-design.md), the [detailed Readiness design](../../superpowers/specs/2026-09-28-us-06-readiness-server-design.md) and the [shared MVP contract](../../us/mvp-contract.md). Design only; implementation is not claimed.

> Fourth brief of the U.S. series. Office mode, desktop-first 1440px, adaptive down to 1024.
> Users: the QA / Traceability Manager (runs traces, watches readiness), the Auditor / Read-only
> user (reviews history), the Owner / Tenant Admin (readiness on the dashboard) and the three
> operators (look up a lot before recording an event). English primary, U.S. Spanish secondary;
> light + dark. Build inside the isolated U.S. workspace, alongside its existing Events and Lots
> views. Do not import RU code-search, its routes, or RU translation requirements. Reuse shared
> UI components and tokens; keep record navigation tied to exact U.S. event revisions.

## Purpose

After brief 03 the tenant holds lots, three kinds of finalized events and genealogy edges. A
recall, an auditor or a mock trace request asks four questions: where did this output lot come
from, where did this input lot go, which lot carries TLC X / BOL-0916-H / this SSCC, and what
is still missing before we can answer. The 24-hour trace request workflow (brief 05) starts
from a search on these screens. The P1 performance targets, measured but not gating P0, are a
trace graph in under 2 s and an exact lookup in under 1 s. These US-06 views are read-only.

## Design principle: one trace result

A current trace is **one server result** — lot, location, Transformation-event and non-FTL
material nodes; exact frozen-line edges; and provenance. Receiving connects a source location
to its lot, Transformation connects input lines through an event node to output lines, and
Shipping connects a lot to its recipient. The graph draws nodes and edges; the table lists the
same edge array, so counts match by construction. Void, amended, superseded and draft revisions
are **not** drawn as current evidence: show them in a separate Excluded/history section with
reason and revision links.

Two rules follow. **Provenance everywhere**: every event-derived row and number links to the
event, revision and frozen line that supplied it; an independent lot identity links to its lot
record. **Readiness reports evidence gaps, never compliance**: P0 shows concrete findings and
counts, not a percentage or grade; product coverage remains a manual review.

## Screens

### 1. Search

U.S. workspace view `Traceability → Search`. Top: an **exact lookup box** (monospace) for a TLC,
reference number, SSCC (scanned `(00)` prefix stripped) or lot ID. An ambiguous value can match
multiple types or multiple source-qualified TLCs: list every legitimate hit with its match
reason rather than silently redirecting to the first one. The under-1-second seed target is
measured and reported in P0, not a P0 gate. Below: a filter row — product, TLC list (chips), **TLC
range** with the visible note "text order (A–Z), not numeric", date range, CTE type, location,
reference type + number, SSCC, lot status.

Results are lot rows: TLC (mono), product ID and optional **current** catalog name, source,
status chip, current CTE total, first / last event date, "matched by" chips
(TLC, reference, SSCC, product, location, date). Equal TLCs show their distinct sources in
the result rows. An SSCC hit names current or historical link status, timestamps and synthetic
or existing-record provenance; it never implies a physical scan or pack. Row click opens the
lot card. The frozen product description and per-event CTE detail are on the card, not inferred
from this search response. The future "Create trace request from these results" action belongs
to US-09; do not render an inactive control in US-06.

Demo: `NRF-260915-APL01` → one hit, matched by TLC; product "Fresh-Cut Red Delicious Apple
Slices" → `OSS-260914-A1`, `OSS-260914-A2`; `BOL-0916-H` → `NRF-260915-APL01` matched by
reference; an SSCC of the 100 cases → the same lot, matched by SSCC with an "active link" tag.

States to draw: before search (what can be searched, with a scan hint); exact hit; filtered
results with matched-by chips; no results (applied filters restated, "clear filters");
unrecognized input; not found for exact lookup; loading (exact lookup: button state only, no
skeleton; filtered list: skeleton rows); error with retry; stale after a failed refresh;
paging at 50 per page; the TLC-range filter open with its note.

### 2. Lot card

Lot detail inside the U.S. workspace. U.S. brief 02 draws the header and body groups; this
brief adds the trace actions and panels, and restates the header so the mockup is coherent.
**Header**:
TLC (mono), status chip (Active / Consumed / Shipped / Quarantined / Recalled / Archived, plus
the derived "Partially shipped" label), assignment basis (Imported / Transformation / Exempt
supplier receipt), product description snapshot, TLC source (location card or reference),
origin event link, balance ("0.000 of 100.000 case remaining"; "balance unknown" for manual
lots), and production / expiry dates when recorded (operational, P1). Actions: **Trace backward**, **Trace
forward**, Change status (reason required), Link cases (P0 server-side only).

**Panels**, each with a provenance column (event number + revision, linked):

| Panel        | Content                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CTE timeline | Current finalized entries: date, type, event number, revision, location and exact line quantity; an adjacent expandable history lists draft/amended/void revisions with reason      |
| Documents    | Type, number as snapshotted, event, link                                                                                                                                            |
| Cases        | Active link count and SSCC rows; synthetic demo / existing record provenance, manual / demo seed link origin, audited history and unlink reason (P0 server-side; no Station action) |
| Findings     | Readiness findings for this lot in the **displayed server period**: severity chip with text, field, message, deep link; "No findings in this period" when clean                     |
| Genealogy    | Inputs and outputs as lot links (2 inputs for the demo output; 1 output for each input)                                                                                             |

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

Trace detail inside the U.S. workspace. Entering from the sidebar starts with a lot selector;
entering from a lot card uses that exact lot. Controls: direction segmented
control **Backward | Forward | Both** (text labels) and depth (default 16). No draft toggle
alters the current graph; drafts are available only in Excluded/history. A metric strip — nodes,
edges, excluded — sits
above the **Graph | Table** tabs and reads the same on both.

**Graph** — a deterministic layered view sized for small graphs: lot, location, Transformation
event and non-FTL material nodes have distinct shapes and text labels. Exact input quantities
label input-lot/material → Transformation edges; exact output quantities label Transformation →
output-lot edges. Direct lot→lot genealogy links, if shown as navigation, have **no quantity**:
2→2 records do not allocate each input across each output. Receiving and Shipping edges use
their own frozen line quantities. Shapes and glyphs carry meaning; color never alone. Selecting
a table row highlights its edge; the table is the full keyboard-accessible representation.
The SVG has `role="img"`, an `aria-label` with counts and a visually hidden node list.

**Table** — one row per current edge: from, to, kind (received from / Transformation input /
Transformation output / shipped to), exact quantity + unit, event number, revision, line,
date and provenance link. Excluded revisions are in a separate table.

Demo backward from `NRF-260915-APL01`: Orchard → A1 and A2 Receiving lines, A1 and A2 →
`TRN-26-0001` input lines, then `TRN-26-0001` → APL01 output line. The two `500 lb` input
values and `100 case` output value stay on their respective lines; no invented conversion or
per-pair allocation appears. Forward from A1 continues through the same event node to APL01
and its Shipping recipient. Node/edge strip values come from the returned graph, not mockup
constants.

States to draw: backward; forward; both; **no genealogy yet**; separate excluded void,
superseded and draft history with reasons; **traversal limit** with returned counts and an
"incomplete" warning on both tabs; **origin gap** as a different finding; loading; timeout
as a retryable error rather than a successful partial graph; storage error; not found.

### 4. Readiness dashboard

U.S. workspace view `Traceability → Readiness`. Metric strip: **Data readiness** with records
checked, errors, warnings and infos — **no percentage or score in P0**. Scope line "last 24 months"
with a date window, product and lot filters. Group-by select **CTE | Product | Severity** in
P0; a grouped table with severity chip (text), CTE, product, field, message
and a record link (event number + revision, or lot TLC). Event-wide findings link to their event
without a lot; Transformation non-FTL inputs link to the event and show input line number without
inventing a lot or line UUID. Lot-only findings link to the lot without inventing an event.
The displayed counts cover current finalized records in the selected scope;
older origins checked as dependencies are identified separately, not added to that count. An
empty scope is distinct from “No findings in the displayed scope.” An info alert states that
coverage status remains a manual review.

**Overdue classification reviews (P1)** — a group "Product reviews due" from the review due
date, each row linking to the product FTL card. **TLC / source consistency findings** appear
in the same table with the presentation of screen 5.

Demo clean-state mock: server-derived event and lot counts, 0 errors, 0 warnings — “No findings
in the displayed scope.” A second mock: `REC-26-0001` rev 1 · Line 2 · “TLC source location or
reference is missing” (error); lot `OSS-260914-A3` · “No current origin after void” (error);
product Fresh-Cut Apple Snack Cups · "coverage status unknown — review required" (error).

States to draw: empty ("Nothing to check yet" when there are no lots); no gaps in the displayed
scope; findings grouped by each P0 group-by; filtered to one product; date window changed; loading
(“Checking records in the selected scope…”); error with retry; generic-profile variant (Scenario B banner,
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

An unresolved mismatch in the **current** chain remains Error even when a revision number is
greater than one. A separately resolved historical discrepancy may be Info and cite the
amendment reason; revision number alone never downgrades the current finding. There is no
"fix" button; corrections go through the owning event or permitted lot-source correction
flow. Other cross-record rules (lot without events, output lot without genealogy, broken event–lot link, incomplete
location snapshot, missing or zero quantity, missing reference document) are one-line
findings: field, message, deep link, and the rule code as a small mono tag for support.

States to draw: current error; resolved historical info with amendment cited; the same current
finding as a row in the readiness table and in the lot card findings panel.

## Cross-cutting notes

- **Provenance everywhere.** Hovering any number shows "from SHP-26-0001 rev 1, line 1";
  every event number is a link to brief 03's detail page.
- **Performance shapes loading.** Exact lookup shows no skeleton; the graph shows a progress
  line with a message; a refetch keeps the previous result on screen (dashboard pattern).
- **Read-only surface.** The only mutations are Change status and Link / Unlink cases on the
  lot card, both with a reason and a confirm dialog. They are explicit exceptions owned by other
  slices: Change status is US-02 `POST /traceability/lots/:id/status` (`traceability.qa.manage`,
  audit `traceability.lot.status_changed`); Link / Unlink cases is US-04
  `POST /traceability/lots/:lotId/cases` and
  `POST /traceability/lots/:lotId/cases/:linkId/unlink` (`traceability.transformation.write`,
  reason recorded, rows never deleted). Reads use `GET /traceability/lots/:lotId/cases`
  with bounded pagination and optional history, and `GET /traceability/cases/lookup?sscc=…`.
  Provenance distinguishes `synthetic_demo` from `existing_record`, independently from
  `manual`/`demo_seed` link origin. Read-only users have no mutation controls. An origin gap
  retains active links and unlink but blocks new links. No edit affordances on events here.
- **Wording.** "Data readiness", "data completeness", "required elements", "gaps"; no P0
  percentage or grade and nothing from the not-allowed column of `docs/us/limitations.md`.
  Generic-profile screens carry the
  Scenario B statement ("FTR applicability not assessed in this profile; general lot traceability only").
- **Formats.** Dates MM/DD/YYYY in tenant time; quantities decimal + explicit unit; TLC and
  SSCC always monospace.
- **Spanish strings.** Check "Estado de los datos", "Rastrear hacia atrás / adelante", "Excluido:
  anulado", "Faltan datos obligatorios" in the strip, the segmented
  control and the finding card at 1024.
- **Dark mode.** Graph edges and edge labels need dedicated tokens; excluded revisions use
  readable history-row styles, not dashed current nodes. The SVG uses shared chip tokens.
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

## Resolved layout decisions and remaining detail

Graph | Table are tabs over one result; excluded history is a separate section, not dashed
current evidence. Locations and Transformation events are nodes. P0 readiness uses counts and
findings, not a percentage ring. Search defaults to dense, source-qualified rows. The
implementation plan may settle responsive truncation and whether a provenance link focuses an
inline section or opens the existing event detail, but it must preserve the exact revision and
line in either presentation.

## Incomplete trace state

A depth-limited result shows “Trace incomplete: traversal limit reached” with the returned counts; graph and table show the same warning. A timeout or storage inconsistency instead shows a retryable error, never a partial-success graph. A limited trace cannot seed an export-ready package until the full requested scope is available. TLC search can return several source-qualified matches. SSCC search and Cases panels are P0 under MUS-CR-001. Show synthetic linkage provenance and audited link/unlink history; no scan/print success is implied. Zero case links is not a missing KDE, but fails the separate 100-case demo acceptance.

## Available-records handoff — 2026-09-05

Readiness errors and incomplete traversal prevent an Export-ready badge, not authorized retrieval of available records. Link to Requests → Download available records, labelled Incomplete with scope/returned counts, source-linked gaps and frozen revision. Do not imply complete traversal or hide missing origins. No coverage-review or event-finalization bypass. See [CLAR-03](../../us/development-clarifications.md); the actual export action remains in Requests.

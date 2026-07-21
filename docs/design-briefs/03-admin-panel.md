# Design Brief 03 — Admin Panel UI

> Third stage. Office mode of the design system (brief 02). Web app,
> desktop-first 1440px, adaptive down to 1024/768. Users: admin and manager
> (email + password sign-in). RU primary, EN for key screens. Light + dark.

## Screens

### 1. Dashboard
- Active shifts right now: line, product, mode, progress vs plan, operators
  online, per-terminal counters.
- Day/week summary: units scanned, boxes/pallets closed, error/duplicate rate.
- Marking-codes stock KPI (optional code pool): codes remaining and estimated
  days left, when the client pre-loads ordered code files.
- Recent exports with statuses.

### 2. Product catalog
- List: search, filter by product group; columns GTIN, name, group, box/pallet
  capacity defaults, default label template.
- Product card: GTIN, name, photo, Chestny ZNAK product group, default box
  capacity, default pallet capacity, default label template (from the label
  library), optional default **counterparty** (tolling customer — see
  Counterparties below), notes.
- **GTIN owner auto-detection:** on entering an EAN/GTIN, its GS1 company
  prefix is compared against the organization's own prefixes and those of
  known counterparties. Foreign prefix → inline highlight "GTIN owner looks
  like another organization" with a one-tap suggestion to set the matching
  counterparty (or create a new one). Design the hint as helpful, not
  blocking.
- Products are created **only here** (approved decision — no creation from
  the line). Incomplete cards carry a "Draft — complete it" status; a draft
  product blocks starting a shift on the station until completed.

### 3. Shifts (production tasks)
- List with statuses: planned / in progress / closed; filters by date, line,
  product. Ad-hoc shifts created at the station carry a "created on line"
  badge.
- Create/edit: product, planned quantity, date, line, mode (validation only /
  validation + aggregation), box & pallet capacity (prefilled from product,
  overridable), label template (default from product, re-selectable per
  shift), counterparty (default from product, overridable) — a tolling shift
  runs under the customer's GLN, so SSCC and exports form for them.
- Shift card (live): progress vs plan, per-terminal counters, participants,
  scan feed, error/duplicate log, aggregation tree as it grows; close-shift
  action with summary.

### 4. Label template editor
A canvas editor for group/unit labels — a differentiating feature, worth
design attention.
- Template library: list with preview thumbnails, size/DPI, printer language
  (ZPL / TSPL), default flags per product.
- Editor: canvas with drag-and-drop elements — static text, **variable
  fields** (GTIN, SSCC, product name, date, shift, quantity, operator…),
  barcodes (DataMatrix, Code128, EAN-13), QR, logo/image, lines/boxes.
  Properties pane for the selected element (position, size, font, alignment,
  rotation).
- Label size and DPI presets (58×40, 100×100 etc. + custom), portrait/landscape.
- Target printer language ZPL or TSPL per template; **Cyrillic text is
  rasterized** for printing — the on-screen preview must communicate "what
  you see is what prints", including a font-coverage warning when a chosen
  font lacks Cyrillic glyphs.
- Preview with sample data + "test print" to a selected printer.

### 5. History & codes
- Search by code / shift / period / status.
- Code page: full journey — when scanned, by whom, which shift/terminal,
  validation result, current place in aggregation.
- Aggregation tree view: pallet → boxes → units, expandable; operations log
  (packed, disassembled, replaced) with timestamps and operators — audit-grade.

### 6. Exports
- Build export files by shift or period; format presets for GIS MT / 1C
  (file-exchange formats; direct API comes later).
- Filter/group by counterparty: tolling exports must be separable so files
  go to the customer's own GIS MT account.
- Export history: who, when, what range, file download, status.

### 7. Users
- Admins/managers: email + password, role.
- Operators: name, login, numeric PIN, optional **badge barcode** — with
  "print badge" action reusing the label editor/printing pipeline.

### 8. Counterparties
- Tolling customers: name, GLN, INN (tax id), GS1 company prefixes (for GTIN
  owner auto-detection), contact notes; used by product cards and shifts.
  No customer portal in MVP — we hand over export files.

### 9. Settings
- Organization profile (incl. own GLN and GS1 company prefixes);
  lines/workstations (name, expected hardware);
- API keys for external integrations (create/revoke, scopes read/write);
- Language (RU/EN) and theme (light/dark/system) defaults.

## Cross-cutting notes

- Every list: empty state, loading, error, and "offline/stale data" variants.
- Live elements (dashboard, shift card) show sync recency ("updated 12 s ago").
- Destructive actions (close shift, revoke key, delete template) get explicit
  confirmation patterns.
- Tables must survive RU strings and long product names without breaking.
- **Billing-status banners (delta from brief 06):** the customer admin shows
  overdue-escalation banners — overdue notice, "new shifts disabled from
  <date>", read-only mode — designed per the soft-escalation policy in
  brief 06; production is never interrupted mid-shift.

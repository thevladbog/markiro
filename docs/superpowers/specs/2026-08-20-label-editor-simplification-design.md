# Label editor simplification and default templates — Design Spec

**Date:** 2026-08-20

**Status:** Implemented — automated gates complete; hardware print acceptance pending

**Scope:** Remove the visual (canvas) label editor from the admin app, keep a
settings-form + code-import workflow; add `product.egais` and `expiry` label
fields (with a new product shelf-life attribute); seed a default set of box
label templates to every tenant.

**Related:**

- `docs/superpowers/specs/2026-08-14-default-box-label-template-design.md`
- `docs/superpowers/specs/2026-08-19-station-usb-printer-design.md`
- `docs/hardware-acceptance-checklist.md`

## Decision record

1. **Single language-neutral spec stays the source of truth.** A label
   template remains a `LabelTemplateSpec` (jsonb `spec` on
   `label_templates`). Pasted ZPL or TSPL is parsed into the spec by the
   existing importers; at print time the station keeps generating code in the
   language configured for its printer (`hardware-config.ts
printerLanguage`), ignoring `spec.language`. One template entity therefore
   serves both ZPL and TSC printers — no per-language code blobs are stored.
   Raw-code storage was rejected: it would need a new `{{field}}`
   substitution mechanism on the station and would break Cyrillic field
   values (product names), which the current pipeline rasterizes.
2. **The visual editor is removed, not feature-flagged.** The canvas,
   palette, and per-element properties panel are deleted outright (history
   stays in git). The template page becomes a settings form plus the import
   dialog plus a read-only preview.
3. **The label mock-up drives two new label fields.** `product.egais`
   (already a product column, `products.egais_code`) and `expiry` ("Годен
   до"). Expiry is computed on the station as production date + a new
   per-product "shelf life, days" attribute; when the product has no shelf
   life the field prints empty, matching the existing behaviour of
   `km.code` / `shift.no` on box labels.
4. **Defaults are tenant-owned copies.** Five stock templates are created for
   new tenants during provisioning and backfilled to existing tenants by a
   data migration (pattern of `0042_default_box_label_template.sql`).
   Tenants may edit or delete them like any other template.

## 1. Admin app (`apps/admin`)

### Removed

- `pages/labels/editor/LabelCanvas.tsx` (interactive canvas, hit-testing,
  keyboard nudge)
- `pages/labels/editor/Palette.tsx` (add-element buttons)
- `pages/labels/editor/PropertiesPanel.tsx` (per-element property editing)
- From `useEditorState.ts`: `select`, `moveBy`, `setElement`, `addElement`,
  `removeElement`, `undo`/`redo`, history ring. What survives is a much
  smaller state hook (or plain `useState`) holding `{spec, geometryError}`
  with `replaceSpec` (import) and `resizeLabel` (size/dpi form changes,
  still running `fitSpecElements` so imported elements are clamped to the
  new physical label).
- Associated tests (`labels-canvas.test.tsx`, canvas/palette/properties
  portions of `labels-editor.test.tsx`).

### Kept / reworked

The route structure (`/labels`, `/labels/new`, `/labels/:id`) and the library
screen are unchanged. `renderer.ts` and `geometry.ts` move out of
`pages/labels/editor/` to `pages/labels/` (they back the library thumbnails
and the preview, not just the editor).

`LabelEditorPage` becomes a two-column page:

- **Left — settings form:** template name; size preset select (58×40, 60×40,
  75×120, 100×100, 100×150, custom) with width/height inputs; resolution
  select (203 / 300 dpi); language select (ZPL / TSC) — kept as template
  metadata that drives the download button and the library badge only, with
  a hint that the station picks the language per printer; **"Импортировать
  код" as the primary action**; download; save. Dirty-state confirm stays.
- **Right — read-only preview:** the existing `PreviewPane`
  ("предпросмотр = печать": schematic draw + true-resolution rasterized
  Cyrillic + font-coverage alert) rendered with `sampleLabelData()`.
- **Empty state** (new template before any import): preview area shows a
  prompt to import ZPL/TSPL code.

`ImportCodeDialog` is unchanged in behaviour and remains the only way to set
label content. Its copyable `{{field}}` placeholder list automatically picks
up the two new fields from `LABEL_FIELDS`.

Saving continues to POST/PATCH the whole spec through the existing
`/label-templates` endpoints; no API contract change.

## 2. Domain (`packages/domain/src/labels/`)

### New label fields

`LABEL_FIELDS` gains `product.egais` and `expiry`. This automatically extends
the Zod spec, the `{{field}}` import placeholder parser, and both emitters
(fields are data lookups; no emitter change). `sampleLabelData()` gains
deterministic sample values (EGAIS code digits per the mock-up; an expiry
date formatted exactly like the existing `date` sample so admin preview and
station output share one format). Admin field-name copy (RU/EN i18n) is added
for both fields.

### Default template module

New `packages/domain/src/labels/defaults.ts` exporting
`buildDefaultLabelTemplates(): Array<{name: string, spec: LabelTemplateSpec}>`
— pure, deterministic, no I/O — used by tenant provisioning and by tests.
The layout reproduces the approved mock-up, scaled per size:

- product name — `field product.name`, bold, wrapped to **two** lines via
  `maxWidthMm` + `maxLines: 2`
- horizontal separator lines (`line` elements)
- three-column block: "Дата производства:" / "Годен до:" / "Кол-во в
  упаковке:" as `text` captions with `field date` / `field expiry` /
  `field qty` values beneath
- "Код ЕГАИС:" caption + `field product.egais`
- "SSCC:" caption + `barcode code128` bound to `sscc` (the emitter adds the
  `(00)` AI), with the human-readable digits as an explicit `field sscc`
  element beneath it

`maxWidthMm` is a hard CONSTRAINT, not an alignment hint (it was one
originally, which is how a long Russian product name came to print off the
right edge of a 58 mm label). Text is broken by `labels/wrap.ts` into at most
`maxLines` lines — the injected `RasterizeTextFn` measures with the real
canvas font and MUST NOT return a bitmap wider than the `maxWidthPx` it is
given; ZPL's native path uses `^FB<width>,<maxLines>`; TSPL's native path,
which has no field-block command at all, emits one positioned `TEXT` per
line using a documented character-count width estimate. Anything that still
does not fit is ellipsized, so a truncated name is visible rather than
plausible. `maxLines` defaults to 1 — a single line, clipped — for every
template that does not set it.

The mock-up wraps the name across four lines; the templates use two. Four
lines of 10 pt type is 21 mm of a 40 mm label, which the rest of the layout
cannot afford. See `defaults.ts`'s vertical-budget table.

**Barcode HRI is off in both languages.** A `LabelTemplateSpec` is
language-neutral — the station picks ZPL or TSPL per printer — so the ZPL
`^BCN,<h>,N,N,N` (no interpretation line) and TSPL `BARCODE ...,1,...` (HRI
on) pairing meant one template printed readable SSCC digits on a TSC printer
and none on a Zebra, with the TSPL-only line landing wherever the author had
not reserved space. TSPL now passes `0` for that parameter, and templates
that want digits place a `text`/`field` element under the barcode, which is
WYSIWYG in the admin preview and identical in both languages.

Five templates (one entity covers both languages; `spec.language` is set to
`"zpl"` nominally):

| Name                      | Size       | DPI |
| ------------------------- | ---------- | --- |
| Коробка 58×40 (203 dpi)   | 58×40 mm   | 203 |
| Коробка 58×40 (300 dpi)   | 58×40 mm   | 300 |
| Коробка 75×120 (203 dpi)  | 75×120 mm  | 203 |
| Коробка 100×100 (203 dpi) | 100×100 mm | 203 |
| Коробка 100×150 (203 dpi) | 100×150 mm | 203 |

Every generated spec must pass `parseLabelTemplate` and emit non-throwing
ZPL and TSPL with `sampleLabelData()` (unit-tested).

## 3. Data model (`packages/db`)

- `products.shelf_life_days` — `integer`, nullable. New Drizzle migration.
- Backfill data migration inserting the five default templates for every
  existing tenant. Idempotent: a template is inserted only when the tenant
  has no template with the same name. The spec jsonb is inlined into the
  migration SQL (generated from `defaults.ts` at authoring time; a test
  asserts the inlined jsonb equals the module output so they cannot drift).
  The migration does **not** touch `org_profiles.default_box_label_template_id`
  for existing tenants — tenants that already print have a working default,
  and choosing one for the rest is a UI action.
- Station SQLite mirror (`packages/db/src/sqlite/schema.ts` +
  `migrations.ts`): `product_mirror` gains `egais_code` (text, null)
  and `shelf_life_days` (integer, null).

## 4. API (`apps/api`)

- **Products module:** expose `shelfLifeDays` in product DTOs
  (create/update/read) and the admin product form. `egaisCode` already
  exists.
- **Shift reference bundle** (`shifts.service.ts getReferenceBundle`): the
  bundle's product payload gains `egaisCode` and `shelfLifeDays`.
- **Tenant provisioning** (`tenant-provisioning.service.ts`): insert the
  five templates from `buildDefaultLabelTemplates()` for the new tenant and
  set `org_profiles.default_box_label_template_id` to the created
  "Коробка 58×40 (203 dpi)" template (new tenants only).
- `/label-templates` CRUD, permissions, and the `labelEditor` entitlement
  gate are unchanged. Seeded templates are ordinary tenant rows: readable
  (and printable) on any plan, editable only where the entitlement allows —
  same as today.

## 5. Station (`apps/station`)

- `lib/shift-bundle.ts` / `lib/mirror.ts`: persist the two new product
  attributes into `shifts_mirror`.
- `lib/box-label.ts` `boxLabelFields()`: fill `product.egais` from the
  mirror (empty string when null) and compute
  `expiry = addDays(closedAt date, shelfLifeDays)` formatted like the
  existing `date` field; empty string when `shelfLifeDays` is null.
  Date arithmetic is pure and unit-tested (month/year rollover).
- Print path (`print-label.ts`, `box-printing.ts`, transports) is untouched.
  Older bundles without the new attributes degrade to empty field values —
  no error state is added.

## 6. Error handling

- Import errors: unchanged (`parseLabelCode` limits, unsupported-command
  acknowledgement, unknown/mixed placeholder rejection).
- Missing shelf life or EGAIS code → empty printed value, never a print
  failure.
- Size/dpi change on a template with imported content keeps running the
  existing geometry clamp (`fitSpecElements`) and surfaces
  `ELEMENT_TOO_LARGE` as today.
- Backfill migration is transactional and idempotent by (tenant, name).

## 7. Testing

- **domain:** default specs validate, emit ZPL and TSPL without throwing,
  and contain the expected elements; new fields flow through placeholder
  import (`{{product.egais}}`, `{{expiry}}`).
- **admin:** rewritten editor tests — settings form edits spec metadata,
  import replaces content, preview renders, canvas/palette/properties are
  gone; library tests unchanged.
- **api:** product DTO round-trips `shelfLifeDays`; reference bundle carries
  the new product attributes; provisioning creates 5 templates + default
  assignment.
- **db:** migration test for the backfill (inserts once, skips on re-run,
  skips name collisions); jsonb-equals-module drift test.
- **station:** `boxLabelFields` fills/omits the new fields; expiry date
  arithmetic edge cases; mirror round-trip of the new columns.

## Known limitations

- **No download-then-reimport round trip.** "Скачать ZPL/TSPL" emits code
  against `sampleLabelData()` and rasterizes any Cyrillic text to `^GFA`
  bitmaps — the importer rejects a bitmap-only source outright, so a
  downloaded file cannot be fed back in. With the canvas gone, editing a
  seeded template's content means hand-authoring ZPL/TSPL against the
  `{{field}}` placeholder list, not round-tripping through download/import.
  Worth saying plainly so nobody rediscovers it in front of a customer.
- **Nothing ties a template's DPI to the printer's actual resolution.** The
  station has no printer-resolution setting; it prints whatever `spec.dpi`
  the assigned template carries. Provisioning assigns the 203 dpi
  "Коробка 58×40 (203 dpi)" template as every new tenant's default, so a
  tenant whose printer is actually 300 dpi gets every box label at roughly
  two-thirds scale, silently. Known gap, not covered by this change.

## Out of scope

- Per-shift expiry override (product shelf life only, for now).
- Global (non-tenant) template catalogue or an in-UI "create from stock
  template" gallery.
- Removal of the dead item-label schema ballast
  (`products.default_label_template_id`, `shifts.label_template_id`) — noted
  as existing debt, not part of this change.

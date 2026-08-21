# Print-name box-label templates — Design Spec

**Date:** 2026-08-21

**Status:** Approved for implementation

**Scope:** The follow-up slice declared by
`docs/superpowers/specs/2026-08-21-product-print-name-design.md`: bring the
catalog's print name onto the box label by duplicating the stock templates,
not by changing what existing templates print.

## Decision record

Existing templates keep printing the full `product.name` — a tenant's labels
must not change under them. Instead:

- the label model gains a new field binding, `product.printName`;
- the ten stock box templates (both families, five sizes) get **duplicates**
  whose headline binds `product.printName` and whose seed names carry the
  ` [Назв. для печати]` suffix, e.g. `Коробка 58×40 (203 dpi) [Назв. для
печати]`;
- the station supplies the field as `productPrintName ?? productName`, so a
  print-name template never renders a blank headline for a product without a
  short name;
- which label a shift prints stays a template choice — the org default, the
  admin shift form, or the station's NewShift template picker.

The duplicates are geometry-identical to their originals: only the headline
binding and the name differ (pinned by a dedicated twin test).

## Data & seeding

- `LABEL_FIELDS` gains `"product.printName"`; `sampleLabelData()` gains a
  short sample so previews, thumbnails, and test-label printing render it.
- `buildBoxLabelSpec` gains a `nameField` axis;
  `buildPrintNameBoxLabelTemplates()` returns the ten duplicates and
  `buildDefaultLabelTemplates()` appends them, so **new tenants** are seeded
  automatically by provisioning (20 stock templates total).
- **Existing tenants**: migration `0058_print_name_label_templates` —
  insert-if-absent on `(tenant_id, name)`, modeled on 0053, with generated
  JSON pinned by a drift guard in `labels-defaults.test.ts`.

## Station

`BoxLabelInput` gains `productPrintName: string | null`; `boxLabelFields()`
maps `"product.printName": productPrintName ?? productName`. The value flows
`shiftContext.productPrintName` (already mirrored offline) → App → WorkScreen
→ `fieldsForClosedBox`, covering fresh close, recovery, and reprint through
the single existing construction site.

## Admin

The import-dialog field cheat-sheet lists `{{product.printName}}` with RU/EN
labels; previews use the sample data. No editor mechanics change.

## Non-goals

- changing what any existing template (stock or tenant-created) prints;
- making a print-name template anybody's default;
- reseeding or force-overwriting the original families.

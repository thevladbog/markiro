# Chestny ZNAK Product Groups — Design Spec

**Date:** 2026-08-29

**Status:** Proposed for implementation

**Scope:** Replace the product card's free-text «Группа продукции» with a selection from a
seeded reference table of Chestny ZNAK product groups, so a product carries the numeric
group code the ЧЗ APIs require.

## Why now

`products.product_group` is free text — `z.string().min(1).max(200)`, no validation, no
dictionary. An operator may have typed «Молоко», `milk`, or anything at all. That was
tolerable while the field was only a human-facing label.

It stops being tolerable with the inventory exports slice
(`2026-08-29-chz-inventory-exports-design.md`): ordering an export sends
`productGroupCode` — a **numeric** Chestny ZNAK code carried on the dispenser task — and
free text cannot supply it. Every future ЧЗ call that is scoped by product group (the `pg`
query parameter appears throughout True API) needs the same code.

So the dictionary lands first, as its own slice, and the exports slice reads from it.

## The dictionary

Both source documents publish the same list, and they agree on every code↔alias pair they
share:

- «Справочник "Товарные группы"», `API_СУЗ_3.0.pdf`, table 276, pages 472–473;
- «Справочник "Список поддерживаемых товарных групп"», `True_API_GIS_MT-v721.0`,
  appendix 1, pages 1213–1214.

They differ only in which codes each one lists, and in the wording of two names:

| Code                                     | Present in                                                                                              | Resolution                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 7 `pharma`, 55 `vetbio`, 57 `industrial` | СУЗ only                                                                                                | Seeded — a product may legitimately belong to one, and the catalogue is not export-only |
| 11 `alcohol`, 14 `furs`, 38 `pharmaraw`  | True API only                                                                                           | Seeded                                                                                  |
| 13 `water`                               | «Питьевая вода» (СУЗ) / «Упакованная вода» (True API)                                                   | True API wording                                                                        |
| 40 `fire`                                | «Средства обеспечения пожарной безопасности и пожаротушения» (СУЗ) / «Пожарная безопасность» (True API) | True API wording                                                                        |

The seed is the **union** of both lists, with True API naming where they disagree, because
True API is the interface we call. Seeding the union rather than the True API subset keeps
the catalogue usable for products in groups True API does not enumerate; if such a group is
ever used for an export, ЧЗ rejects the task and the per-status error surfaces its own
message, which is more honest than pretending the group does not exist.

Recording the provenance matters: when a future group appears, the same two tables are
where it will be found.

## Data model

A global (not tenant-scoped) reference table `chz_product_groups`, seeded by the migration
that creates it:

- `code` integer, primary key — the value sent as `productGroupCode` and `pg`;
- `alias` text, unique — the latin slug (`milk`, `beer`, …) used in СУЗ URLs and some True
  API parameters;
- `name` text — the Russian name shown to operators.

On products, `product_group text` is replaced by `chz_product_group_code integer`
referencing it. **Existing free-text values are discarded, not migrated** — this is the
explicit product decision, and it is irreversible: the old strings are unmatched against
any dictionary entry and would be guesswork to convert.

Consequence, stated plainly: `products.status` is computed as `active` only when the group,
box capacity and pallet capacity are all set, so every product that had a free-text group
falls back to `draft` until an operator picks its group. Nothing is deleted and no history
breaks — a `draft` product simply stops appearing in selection surfaces until it is
completed. Operators must be told before this ships.

## Blast radius, and what stays untouched

The field travels further than the product card: `shifts.service.ts` includes it in the
shift bundle, from where the Station stores it in its offline SQLite mirror
(`product_group TEXT`).

The Station is deliberately left unchanged. The shift bundle keeps sending
`productGroup` **as a string** — the group's `name`, resolved by joining the dictionary —
so the Station's mirror schema, its migrations and `mirror.ts` need no edit. The Station
shows a human label either way; only its source changes from operator free text to
dictionary name.

Changed: `packages/db` (new table, seed, column swap), the products module (schema, DTO,
service, validation), the admin catalogue (form field becomes a select, list column reads
the resolved name), `shifts.service.ts` (one join), and the tests that construct products.

## API

- `GET /chz-product-groups` — the dictionary, for populating the select. Cabinet-guarded
  like the rest of the catalogue surface, read-only, no tenant scoping in the payload.
- Product create/update accept `chzProductGroupCode: number | null` instead of
  `productGroup: string | null`; an unknown code is a validation failure, not a silent
  null.
- Product responses carry both the code and the resolved name, so the admin list does not
  need a second request to render a row.

## UI

In the product form the text input becomes a select over the dictionary, sorted by name,
with an empty option meaning "not chosen". The existing "200 characters or fewer"
validation message disappears with the field it validated.

The catalogue list column keeps showing a group name; products whose group was wiped show
it empty and are already visibly `draft`, which is the signal to fix them.

## Testing

- The seed: a test asserting the table contains the documented codes with their aliases,
  so a future edit cannot silently drop or renumber one. It pins a handful of anchors
  (`8 → milk`, `13 → water`, `15 → beer`) rather than restating all fifty rows.
- Products: creating and updating with a valid code, rejection of an unknown code,
  `status` falling to `draft` when the code is absent.
- The shift bundle: a product with a group yields its **name** in the bundle payload, so
  the Station contract is unchanged.
- Admin: the form renders a select and submits the code; the list renders the name.

## Out of scope

- Migrating old free-text values by fuzzy matching. The decision is to wipe them.
- Editing the dictionary from the UI. It is reference data; a new group arrives with a
  migration, which is also when any code that consumes it can be updated.
- Per-tenant subsets of groups.
- Using the code anywhere beyond the catalogue — the exports slice is where it is first
  consumed.

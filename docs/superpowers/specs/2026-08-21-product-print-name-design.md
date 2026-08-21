# Product print name — Design Spec

**Date:** 2026-08-21

**Status:** Approved for implementation

**Scope:** An optional catalog field `Наименование для печати` (print name) on
products, carried through the API, admin form, shifts list, station bundle,
and station SQLite mirror; displayed on the station shift card. Feeding the
print name into label rendering is a declared follow-up, not part of this
slice.

**Related:**

- the shift-card long-name overlap observation (station gallery,
  `shift-page-1`): marketing names of 90+ characters do not fit a fixed-height
  floor card. The product-level fix is a short print name; the CSS clamp
  defect remains tracked separately because products without a print name
  still render the full name.

## Decision record

Products keep their full legal/marketing `name` (`Сидр сухой газированный
Дикий Крест Особый 5%`) and gain an optional short `printName` (`Дикий Крест
Особый 5%`). Both fields are first-class:

- the cabinet catalog, search, and shift planning keep using the full name;
- the station shift card shows `printName` when set, otherwise the full name
  — the operator-facing surfaces prefer the short form;
- the shift bundle and the station SQLite mirror carry `printName` now so
  that offline label rendering can adopt it in the follow-up slice without
  another mirror migration or bundle contract change;
- label rendering itself is unchanged in this slice.

An empty or whitespace-only submitted print name is stored as `null` (the
field is "unset", never an empty string).

## Data model

- Postgres: `products.print_name text` nullable; no backfill (null means
  "use the full name").
- Station SQLite mirror: `product_mirror.print_name TEXT` nullable, added via
  the standard guarded `STATION_MIGRATIONS` ALTER; legacy rows stay null.

## API

- `POST /products` and `PATCH /products/:id` accept
  `printName?: string | null` with the same trim/length discipline as `name`;
  explicit `null` (or a blank string) clears the field.
- `ProductDto` returns `printName: string | null`.
- `GET /shifts` list items gain `productPrintName: string | null`, joined the
  same way as `productName`.
- The shift bundle's product object carries `printName` (current servers
  always serialize the field; older stations ignore unknown properties).
- No station-surface changes: no new routes, guards, or CORS entries.

## Cabinet UX

The product create/edit form adds an optional text input `Наименование для
печати` directly under `Наименование`, with a hint explaining it is the short
name shown on the station and (in the future) printed on labels. Blank keeps
the full name everywhere.

## Station UX

The shift card (shift selection screen) shows `productPrintName ?? productName`.
No other station screen changes: the NewShift found card intentionally keeps
the full name — after a scan the operator is verifying identity, and the full
name is the safer confirmation.

## Testing

- DB: schema snapshot + migration apply; mirror migration adds the column and
  round-trips the value.
- API: create/update round-trip, blank-to-null normalization, list join, and
  the bundle serializing `printName`.
- Admin: form renders, submits, and clears the field.
- Station: shift card prefers the print name and falls back to the full name;
  mirror upsert stores it.

## Non-goals

- binding the print name into ZPL/TSPL label rendering (follow-up slice);
- changing NewShift, WorkScreen, kiosk, or admin list displays;
- backfilling print names for existing products.

# Station shift card and compact header — design

**Status:** accepted by the owner 2026-09-20 (pen.dev mock: variant A
«фото-панель» together with variant D «компактная шапка»; canvas frames `10A`,
`10D` and the notes frame `10 Заметки к вариантам карточки смены` in
`pencil-new.pen`).

## Problem

The shift-selection screen of the station (`apps/station`) reads badly on the
real 1024×768 line terminal:

- The number badge and the status tag are 34 px floor tags and shout louder than
  the product name; on a narrow card they collide and the status truncates.
- The product photo is drawn on a light panel with a border although catalogue
  photos are transparent WebP, so a bottle sits in a white box on a dark screen.
- The mode line («Агрегация · паллеты · без плана») ellipsized; the interim fix
  wraps the plan but the line still reads as prose.
- The full catalogue name («Сидр полусухой газированный «ДИКИЙ КРЕСТ» 0,45 л»)
  is the headline even when the short print name exists.
- The header is two rows (identity + telemetry, then three 64 px buttons) and
  costs 145 px of a 768 px screen.

## Outcome

- Card: photo on a product-tinted gradient, print name as the headline, full
  name small below it, one quiet line of number + status, dates and mode as
  labelled facts, the action button unchanged (64 px).
- Header: one 72 px row — identity, telemetry pills, compact actions — on every
  station screen, not only shift selection.
- Nothing about behaviour changes: same props feed the same actions; the card
  still fits two per page on 1024×768 and 1280×800.

## Decisions

- **Print name first.** The headline is `productPrintName ?? productName`; when
  the print name exists, the full name is shown beneath in the meta size. The
  API list already carries both fields.
- **Photo on the product gradient.** The photo panel takes the hue from
  `useProductAccentHue({ exec, productId, image, gtin })` (dominant colour of the
  photo, GTIN hash as fallback) and paints
  `linear-gradient(305deg, hsl(h 40% 20%), hsl(h 36% 11%) 55%, hsl(h 32% 6%))`
  — the work screen's identity gradient with saturation lowered by ~6 points,
  so two cards side by side do not shout. Without a hue (no photo, no GTIN) the
  neutral `#2c2b31 → #1d1c21 → #141317` gradient of the work screen is used.
  The photo is `object-fit: contain` with no border and no background; the
  placeholder (no photo) is the product monogram from `productMonogram`, white
  at 70 %, on the same gradient. `GET /shifts` items gain `gtin14` on the
  station side (`ShiftListItem.gtin14?: string | null`; the API already sends
  it).
- **Tags on the card are office size.** Owner decision 2026-09-20 for this
  card only: the 34 px floor tag is right for verdicts read from two metres,
  but a shift card is read at arm's length while choosing, and the tags there
  are metadata, not the message. The number is `Badge size="office" mono`, the
  status `StatusChip size="office"` with the phase mapping that already exists
  (`planned → planned`, `active → active`, `closing → running`, `closed → done`).
  The mode is a category `Badge size="office"`: `validation → violet`,
  `aggregation → teal` (first union member gets violet, per the tag
  vocabulary); «Паллеты» is a neutral `Badge size="office"`. Elsewhere on the
  station floor tags stay 34 px.
- **Facts, not prose.** Dates are two mono lines, `Смена: 19.09.2026` and
  `Производство: 20.09.2026` (the second only when known). The mode row is
  the two badges plus the plan text (`план 12 000` / `без плана`) in mono; the
  counterparty line stays as today. The plan text never shares a badge.
- **Compact header.** `StatusBar` renders one row at all widths:
  `grid-template-columns: minmax(0, 1fr) auto auto` with no ≤1599 px two-row
  fallback. The action rail holds three 52 px controls: the update indicator
  as an icon button (`↻`/`!` glyph, severity colour, a dot when an update is
  available; the full label stays in `aria-label`), «Сменить оператора» as a
  52 px text button (it is used every shift), the window-mode control as an
  icon-only 52 px button (its glyph already exists; the label stays in
  `aria-label`). The collapsed variant (active shift) is unchanged. The
  identity deck keeps its two rows but its fonts drop to 16/13 px; pills keep
  their ≤1679 px caption rule.
- **Error banners of the controls** (operator switch / window mode) keep
  rendering under the rail as today; they are not part of the 72 px budget.

## Card anatomy (`ShiftCard`)

```
┌──────────────┬───────────────────────────────────────────┐
│              │ SEP26-008/S                  [▸ Активна]  │  ← Badge office mono · StatusChip office
│   photo on   │ Сидр Дикий Крест 0,45                     │  ← print name, floor-lg (2–3 lines)
│   gradient   │ Сидр полусухой газированный «ДИКИЙ КРЕСТ»…│  ← full name, 13 px fg-3, 2 lines max
│  (≈38–40 %)  │ Смена: 19.09.2026                         │  ← mono 14
│              │ Производство: 20.09.2026                  │
│              │ [Агрегация] [Паллеты]  без плана          │  ← Badges office + mono plan
│              │ для: Завод «Заря»                         │
│              │ ┌───────────────────────────────────────┐ │
│              │ │           Присоединиться              │ │  ← Button floor, unchanged
└──────────────┴─┴───────────────────────────────────────┴─┘
```

Grid rows of the details column: heading auto · title minmax(0,1fr) · full
name auto · dates auto · mode auto · counterparty auto · button 72 px. The
title clamps to 3 lines (2 under `max-height: 820px`), the full name to 2.

Props: `productName` stays the headline; new optional `productFullName`
(rendered only when non-null and different from `productName`), new optional
`gtin` for the accent fallback; `plannedDateLabel`, `productionDateLabel`,
`modeLabel`, `palletsLabel`, `plannedLabel`, `noPlanLabel` stay as they are.

## Header anatomy (`StatusBar`)

```
Линия №1 · терминал 1        (●) (● Синх. 0) (● Дубли 0) (●) (●)   [↻•] [👤 Сменить оператора] [▣]
Богатырев Владислав Сергеевич
```

`.station-status-actions` becomes a non-wrapping flex rail whose children are
52 px tall (`min-height: 52px`), icon buttons 52 px wide. Below 1100 px the
identity fonts and pill paddings already shrink; the rail does not wrap.

## Tests to update or add

- `test/shift-card.test.tsx`: headline is the print name and the full name is
  beneath; monogram placeholder without a photo; hue → `--product-hue` on the
  photo panel with `data-accent`; office-size tags with the phase glyphs;
  dates and mode rows; unchanged action button.
- `test/shift-selection.test.tsx`: the card receives `productFullName`,
  `gtin14` and the pallets flag from the list item.
- `test/status-bar.test.tsx`, `test/screen-gallery.test.tsx` (`floor-header-actions`),
  `test/App.test.tsx` (buttons found by accessible name, unchanged):
  the three controls stay in one labelled group; the update button carries
  `data-update-severity`; the window control is icon-only with its label in
  `aria-label`.
- `test/fixed-viewport-source.test.tsx`: rewrite the header assertions for the
  single-row rail (52 px children, no ≤1599 px two-row fallback, no wrap) and
  the card grid (`minmax(150px, 38%)`); keep the pill caption rules.
- `test/window-mode-control.test.tsx` «keeps the persistent action touch-sized»:
  52 px is the new floor for header controls; 64 px stays for everything else.
- Gallery: `shift-page-1/2` show the print name, gradient panel and office tags;
  `floor-header-actions` shows the compact rail.

## Not in scope

- No API change (`gtin14`, `productPrintName` already exist).
- The work screen's identity hero and the collapsed status bar are untouched.
- Variant B/C from the canvas are documented in the notes frame and not built.

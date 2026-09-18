# Pallet placard (A4 / A5) — design

**Status:** Approved 2026-09-18 (owner: mock-ups reviewed in chat; header reduced to «ПАЛЛЕТА» only).

## 1. Problem

A pallet built on a handheld or a station gets its 100×150 / 58×40 thermal label
only where a label printer stands. A warehouse without one still has to mark the
stack so a forklift driver, a goods-in clerk or a scanner can identify it. The
cabinet already prints «Состав паллеты» (`GET /code-search/pallets/:id/report`,
an A4 contents list), but that is a document for a file, not a placard for a
stack: the SSCC symbol on it is 8 mm tall in a table row.

The cabinet needs a **placard**: one page with a large SSCC barcode and the
pallet's identity, printable on any office printer in **A4** or **A5**, opened
from the pallet card.

## 2. What is printed

One page, portrait, in reading order:

| Block           | Content                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header          | Organisation logo (the uploaded organisation logo; the Markiro lockup when none, exactly as `contents-report.ts`'s `brandLogo`) and organisation name on the left; the word **ПАЛЛЕТА** on the right. Nothing else: no kind, no status, no timestamp. A rule under the header. |
| Product         | Product name, large (A4 18 pt / A5 14 pt, up to three lines).                                                                                                 |
| Key figures     | Three cells separated by vertical rules and framed by horizontal rules: **GTIN** (mono), **Коробов** (live member boxes), **Единиц** (live unit codes across those boxes). |
| Date summary    | Table grouped by member boxes' production date: `Дата производства · Годен до · Коробов · Единиц`, ascending by date, plus an `Итого` row. Column dividers as in the mock-up. A5 drops the `Единиц` column and shortens the captions (`Произв.`, `Кор.`). |
| Barcode         | GS1-128 (Code 128 with FNC1) of the SSCC, full content width; bars A4 ≈ 30 mm tall, A5 ≈ 22 mm. Under it the HRI `(00)…` in one unbroken line (mono, A4 15 pt / A5 11 pt, no grouping spaces). |
| Footer          | A4: `ИНН …` left, `Сформировано в Маркиро` right. A5: `Маркиро` right only.                                                                                   |

Counting rules are the ones the contents report already applies: a disassembled
member box stays out of every count (`liveBoxes`), so the placard never claims
more than what stands on the stack.

### 2.1 Date summary semantics

- A box's date is its shift's effective production day,
  `coalesce(shifts.production_date, shifts.planned_date)` — the same expression
  `getPalletCard` uses for `boxes[].productionDate`.
- «Годен до» is `shelfLifeExpiryDate(productionDate, product.shelfLifeDays)` from
  `@markiro/domain` (inclusive rule: production day counts as day one). With no
  shelf life on the product the cell prints `—`.
- A box without a production date (shift with neither date) is grouped under
  `—` as the last row; its expiry is `—`.
- On a production pallet every box shares one shift, so the table collapses to
  one row plus `Итого`; that is by design, not special-cased.
- **Row cap.** A4 prints up to 12 date rows, A5 up to 6. Beyond that the table
  keeps the first N−1 rows and replaces the rest with one row `и ещё K дат`
  whose counts are the sum of the folded rows, so `Итого` still adds up.

### 2.2 Product of the pallet

`coalesce(pallets.product_id, shifts.product_id)` — a warehouse pallet carries
its own product, a production one reaches it through its shift (the rule
`PalletsService.listPallets` already applies). The existing `palletReportData`
joins products only through the shift and therefore prints `—` for a warehouse
pallet; the placard loader must not inherit that gap. (Fixing the contents
report's product join the same way is a one-line improvement to make in the
same change, since both loaders live side by side.)

### 2.3 Which pallets get a placard

- Closed pallet with an SSCC: the normal case.
- Disassembled pallet: printable (a reprint of a historical placard is
  legitimate), with a diagonal watermark **РАСФОРМИРОВАНА** across the page so
  it cannot be mistaken for a live one.
- Open pallet or any pallet without an SSCC: no placard. The server answers
  `409 { code: "PALLET_NOT_CLOSED" }`; the card does not offer the action.

## 3. API

`GET /code-search/pallets/:palletId/placard?format=a4|a5&timeZone=<IANA>`

- Same contract as `…/report`: `text/html; charset=utf-8`, self-contained HTML
  for opening in a new tab and printing; `OPERATIONS_READ`; 404 for a pallet of
  another tenant (the loader is tenant-scoped like `palletReportData`).
- `format` defaults to `a4`. `timeZone` is accepted for symmetry with the other
  reports but the placard prints no instants, only civil dates.
- `@page { size: A4 }` / `{ size: A5 }`, page box 210×297 mm / 148×210 mm,
  margins 14 mm / 10 mm, `body` background white in print, grey preview
  background on screen as in the contents report.

### 3.1 Modules (`apps/api/src/modules/code-search/`)

- `pallet-placard.ts` — pure renderer `renderPalletPlacardHtml(data, format)`.
  Reuses from `contents-report.ts`: `brandLogo`, `ssccBarcode`, `ssccHri`,
  `escapeHtml`, `ReportOrg`. Owns: `summarizeByProductionDate(boxes, shelfLifeDays)`
  (exported for tests), the row cap, the two size presets, the watermark.
  No I/O, no `Date.now()`.
- `code-search.service.ts` — `palletPlacardData(tenantId, palletId)` returning

  ```ts
  interface PalletPlacardData {
    sscc: string | null;            // 20-char AI-00 machine form
    status: "open" | "closed" | "disassembled";
    productName: string | null;
    gtin14: string | null;
    shelfLifeDays: number | null;
    org: ReportOrg | null;
    boxes: { productionDate: string | null; codeCount: number; disassembledAt: Date | null }[];
  }
  ```

- `dto.ts` — `palletPlacardQuerySchema = boxReportQuerySchema.extend({ format: z.enum(["a4","a5"]).default("a4") })`.
- `code-search.controller.ts` — the route, documented for OpenAPI like `palletReport`.

## 4. Cabinet (`apps/admin`)

On `PalletCard.tsx`'s header actions, next to «Расформировать» and
«Распечатать»: a button **«Ярлык»**. `@markiro/ui` has no menu/popover
component, so the choice is a compact `Modal` («Ярлык паллеты») with a
`RadioGroup` `A4 / A5` (A4 preselected) and a primary «Открыть» that calls
`window.open('/api/code-search/pallets/${id}/placard?format=…&timeZone=…')` and
closes. The button renders only for `status === "closed" || "disassembled"`
with a non-null `sscc`; for an open pallet it is absent (the same rule as the
server's 409), no disabled-button state to explain.

i18n keys under `pages.codeSearch.palletCard.placard.*` (`action`, `title`,
`format.a4`, `format.a5`, `open`), RU and EN.

## 5. Errors and edge cases

- No SSCC / open pallet → 409 from the API; the UI never links there.
- Product without GTIN (`null`): the GTIN cell prints `—`.
- Organisation profile missing: logo falls back to the Markiro lockup, the
  name cell prints `—`, the INN footer cell is omitted (A4).
- Very long product name: three lines with `line-clamp`, then ellipsis — the
  barcode block is anchored to the page bottom and never moves.
- Code 128 rendering failure (`ssccBarcode`'s catch): the same «Код не
  отображается» note the reports print; the HRI digits still print, so the
  placard remains usable by hand.

## 6. Tests

- `apps/api/test/pallet-placard.test.ts` (pure): summary grouping and ordering;
  expiry via the inclusive shelf-life rule and `—` without shelf life; the
  `—` group for undated boxes; disassembled boxes excluded from every count;
  A5 row cap folding with a correct `Итого`; production pallet collapses to one
  row; header carries only «ПАЛЛЕТА» (no status word, no timestamp); the
  watermark only on a disassembled pallet; `@page` size per format; HRI digits
  present once under the symbol without spaces.
- `apps/api/test/code-search.e2e.test.ts` (or the existing pallet e2e file):
  route returns HTML for a closed pallet, 409 for an open one, 404 across
  tenants, `format` default and validation; warehouse pallet resolves its
  product through `pallets.product_id`.
- `apps/admin/test/warehouse-pallets.test.tsx`: the «Ярлык» button appears for
  a closed pallet and not for an open one; choosing A5 opens the URL with
  `format=a5` (stub `window.open`).

## 7. Out of scope

- PDF generation (browser print of HTML is the established path for every
  report in the cabinet).
- Printing the placard from the station or the handheld.
- A menu component in `@markiro/ui` — worth adding when a second action needs
  one; the modal is enough here.

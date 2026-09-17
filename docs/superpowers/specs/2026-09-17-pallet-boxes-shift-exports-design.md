# Shift exports: pallet → boxes documents without codes

Status: accepted 2026-09-17 (owner answered the two open questions in chat).

## Problem

Since contour 06d (#538) a shift can stack closed boxes on pallets, and the
export dialog offers three `boxMode: "pallets"` formats. Each of them still
lists every KM code inside every box. Tenants that already submitted the
box-level GISMT aggregation (`shift_xml_gismt_aggregation`) need a second,
pallet-level document that names only pallets and their boxes, and a plain
TXT of the same shape for 1С/warehouse hand-off.

## Decision

Two new format descriptors, both `version: 1`, both rendered from the
existing `mode: "pallets"` source (no new SQL), both advertised only for a
shift with `palletsEnabled`:

| id                             | ext | label                                     |
| ------------------------------ | --- | ----------------------------------------- |
| `shift_txt_pallet_boxes`       | txt | `[TXT][Паллеты → короба] Отчет смены`     |
| `shift_xml_gismt_pallet_boxes` | xml | `[XML][ГИСМТ] Агрегация паллет без кодов` |

They carry a new `boxMode: "pallet_boxes"`. The source service treats it like
`pallets` (same eligibility, grouping, ordering, `SHIFT_HAS_NO_PALLETS`, and
`openPalletSuppressedBoxCount`). `renderShiftExport` maps the descriptor's
`boxMode` to the source mode it consumes (`pallet_boxes` → `pallets`).

### TXT shape

One block per pallet, pallets in the source order (pallet `closed_at`, then
SSCC), boxes inside a pallet ordered by SSCC as the source already does:

```
00<pallet SSCC>
00<box SSCC>
00<box SSCC>

00<pallet SSCC>
...
```

Loose boxes (no closed pallet) are not written: without codes they have
nothing to report at pallet level. LF line endings, no BOM (as `shift_txt_*`).

### XML shape

`unit_pack` with the tenant `LP_TIN` and one `pack_content` per pallet whose
children are `<sscc>` of its boxes. No `<cis>` and no box `pack_content`.
Same INN requirement (`ORG_INN_MISSING`).

### Counts, filenames, splitting

- A pallet is one atomic block; overflow reports `PALLET_EXCEEDS_LINE_LIMIT`.
- `codeCount` / `boxCount` of a part are the codes and boxes covered by the
  pallets in that part (loose boxes excluded), so the artifact filename
  `<product>_<N>pcs_<M>box_<date>[_часть_k].<ext>` keeps its meaning and the
  artifact DTO's `codeCount >= 1` invariant holds (a group always has a box
  with at least one code).
- `EMPTY_SOURCE` fires only when no pallet group exists; the API already
  raises `SHIFT_HAS_NO_PALLETS` before rendering in that case.

### Surfaces

- `@markiro/domain`: descriptors, block builders, XML renderer accepting an
  empty box list, `shiftExportFormatRequiresPallets` helper.
- API: `formatId` enum and `boxMode` enum in DTO/OpenAPI.
- Admin: pallet gating uses the domain helper instead of a literal compare.

Not in scope: CSV variant, pallet count in filenames, changing any existing
format's bytes.

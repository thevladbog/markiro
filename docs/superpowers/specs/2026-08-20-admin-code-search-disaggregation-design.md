# Admin: Code Search & Disaggregation — Design

**Date:** 2026-08-20
**Status:** Approved by user (brainstorming session)

## Overview

Two new admin (cabinet) screens:

1. **Code Search** (`/codes`) — exact lookup by product code (KM/DataMatrix) or box code (SSCC), plus a browsable, filterable registry of all tenant codes. Code card shows full movement history; box card shows composition with links to each code.
2. **Disaggregation** (`/disaggregation`) — documents that dissolve whole boxes so their codes become free for re-aggregation on stations. Draft → applied/cancelled lifecycle, mandatory reason from a managed dictionary, manual SSCC entry or file import, full history retention, validation that codes are not written off (kiosk) and the shift is closed.

## Key decisions (from brainstorming)

- **Whole boxes only.** A disaggregation document consists of SSCCs; applying it dissolves each box entirely. No per-code extraction.
- **Reason dictionary + optional comment.** Managed `disaggregation_reasons` dictionary (clone of `pickup_order_reasons` pattern) plus a free-text comment on the document.
- **Draft → Applied / Cancelled.** Apply is an explicit, atomic, **irreversible** action (freed codes may already be re-aggregated). Drafts are editable; only drafts can be cancelled.
- **All-or-nothing apply.** Lines are re-validated inside the apply transaction; any invalid line blocks the whole apply (409 with updated line statuses, document stays draft). No "partially applied" state.
- **Exact search only.** Full KM (canonicalized → `kmHash`) or SSCC (18/20 digits, tolerant of `(00)`/spaces HRI). No substring/serial search — DB stores only the code hash + gtin/serial.
- **Search screen = exact lookup + code registry.** Below the search bar: paginated table of all tenant codes with filters (scan period, product, derived status, shift).
- **Shift must be closed.** Boxes belonging to a shift that is not `closed` cannot be disaggregated — while the shift is active, the station owns box management (it has its own disassemble). New validation status `shift_open`.
- **Architecture: derive, don't materialize** (Approach 1). No code status column, no movements table. New tables only for documents. Apply reuses the exact station disassemble mechanics (`boxes.disassembledAt`, `box_items.removedAt`, `box_exceptions` kind=`disassemble`, `box_registry_versions` bump under `box-registry-lock`), so kiosk and stations stay consistent automatically. Code status and history are computed by SQL over existing tables.

### Derived code status

- **aggregated** — active `box_items` row (`displaced_at IS NULL AND removed_at IS NULL`) in a non-disassembled box;
- **written_off** — `pickup_order_items` row with `voided = false`;
- **free** — neither.

## 1. Database schema

New tables in `packages/db/src/schema/platform.ts` (near boxes/box_exceptions). Migration in `packages/db/migrations/`. After schema edits: `pnpm --filter @markiro/db build` (repo rule).

### `disaggregation_reasons`

`id`, `tenantId`, `title` (unique per tenant), `isActive`, `sortOrder`, `createdAt`, `updatedAt`. Clone of `pickup_order_reasons`.

### `disaggregation_documents`

- `id`, `tenantId`
- `docNo` — from per-tenant counter table `disaggregation_doc_counters` (same pattern as `pickup_order_counters`)
- `status` — enum `draft | applied | cancelled`
- `reasonId` → `disaggregation_reasons` (nullable in draft, required to apply)
- `comment` — text, optional
- `source` — `manual | import`
- `createdByUserId`, `createdAt`, `appliedAt`, `appliedByUserId`, `cancelledAt`, `updatedAt`

### `disaggregation_document_lines`

- `id`, `tenantId`, `documentId`
- `ssccInput` (as entered), `sscc` (normalized 18 digits), `boxId` (nullable until resolved)
- `validationStatus` — `ok | not_found | not_closed | shift_open | already_disassembled | written_off | duplicate`, plus `validatedAt`
- UI snapshot: `productId`, `codeCount` (filled during validation)
- Unique `(documentId, sscc)`

### Existing table changes

- `box_exceptions`: add nullable `disaggregationDocumentId` so box history links to the document. Admin-originated disassemble keeps `kind = 'disassemble'`; `shiftId/terminalId/operatorId` taken from the box row. Extend `box_exceptions_kind_payload_check` if needed.

### History retention

Document itself (who/when/reason/composition) + standard `box_exceptions` row per box + `tenant_audit_events` rows for create/apply/cancel actions.

## 2. API

Two new NestJS modules. Standard stack: `TenantGuard + AuthorizationGuard + SubscriptionAccessGuard`; reads `CABINET_CAPABILITY.OPERATIONS_READ` + `@AllowSubscriptionReadOnly("read")`, mutations `OPERATIONS_WRITE` + `@RequireSubscriptionWrite()`; zod DTOs via `ZodValidationPipe`; registered in `app.module.ts`; `@ApiTags` for OpenAPI.

### Module `code-search` (`apps/api/src/modules/code-search/`) — read-only

- `GET /code-search?q=` — input classification: SSCC (18/20 digits, tolerant of `(00)`, spaces, hyphens) → `{ type: "box", boxId }`; otherwise KM canonicalization via `canonicalizeKm`/`kmHash` from `@markiro/domain` → `{ type: "code", codeHash }`; unrecognized/not found → 404 with a reason code (`unrecognized` | `not_found`).
- `GET /code-search/codes?page=&from=&to=&productId=&status=&shiftId=` — paginated tenant code registry from `code_registry` ⋈ `codes` (gtin14/serial/scannedAt), derived status via `EXISTS`/`LATERAL` over `box_items` and `pickup_order_items`. Product filter via `products.gtin14`.
- `GET /code-search/codes/:codeHash` — code card: product, gtin, serial, derived status, current box (if any), and **history timeline** — a time-sorted union of:
  - `scan_events` (scan + verdict),
  - `box_items` (added / displaced / removed),
  - `box_exceptions` of the owning box (undo/clear/disassemble/reprint, with `disaggregationDocumentId` link),
  - `pickup_order_items` + `pickup_orders` (locked into order / punched / written off / cancelled).
- `GET /code-search/boxes/:boxId` — box card: SSCC, derived box status (open/closed/disassembled), shift, product, composition (active rows + displaced/removed rows flagged), `box_exceptions` events, pickup-order participation.

### Module `disaggregation` (`apps/api/src/modules/disaggregation/`)

- `GET /disaggregation` — document list; filters: status, reasonId, date range, docNo search.
- `POST /disaggregation` — create draft (optionally with reasonId/comment).
- `GET /disaggregation/:id` — document with lines.
- `PATCH /disaggregation/:id` — reason/comment (draft only).
- `POST /disaggregation/:id/lines` — add SSCCs (array, ≤500 per call); each validated immediately and stored with its status. Draft only.
- `DELETE /disaggregation/:id/lines/:lineId` — remove line (draft only).
- `POST /disaggregation/:id/import` — multipart (`FileInterceptor`, `memoryStorage`), text file `.txt`/`.csv`, one SSCC per line (separators: newline/`;`/`,`), limits ~10 000 lines / 1 MB. Parsed in the service; produces lines with validation statuses; sets `source = import`. Draft only.
- `POST /disaggregation/:id/apply` — single transaction under `box-registry-lock`:
  1. re-validate every line;
  2. any non-`ok` line → update line statuses, keep document `draft`, return **409** with problem lines;
  3. all `ok` → for each box: set `boxes.disassembledAt`, set `box_items.removedAt` on active rows, insert `box_exceptions` (kind=`disassemble`, reason = reason title + comment, `disaggregationDocumentId`), bump `box_registry_versions`; document → `applied` (`appliedAt`, `appliedByUserId`). Requires `reasonId` set and ≥1 line.
- `POST /disaggregation/:id/cancel` — draft → `cancelled` only.
- `GET/POST/PATCH /disaggregation-reasons` — dictionary CRUD, clone of `pickup-reasons` module.

### Line validation rules (on add, on import, and re-checked inside apply)

In order; first failure wins:

1. SSCC normalizes to 18 digits and box exists in tenant → else `not_found`;
2. no duplicate of the same `sscc` in the document → else `duplicate`;
3. box is closed (`closedAt` + `closureReceivedAt` + `sscc`) → else `not_closed`;
4. box's shift has `status = 'closed'` → else `shift_open` (while the shift is active, the station owns box management);
5. box not already disassembled (`disassembledAt IS NULL`) → else `already_disassembled`;
6. box is not referenced by an active pickup order (`pickup_order_boxes` of a non-cancelled order) and none of its active codes have a `pickup_order_items` row with `voided = false` → else `written_off`.

## 3. Admin UI

Two `NAV_ITEMS` entries (production section, `apps/admin/src/layout/AppShell.tsx`): "Поиск кодов" and "Дезагрегация". Routes in `apps/admin/src/app.tsx` wrapped in `RequireCapability` (`OPERATIONS_READ`); mutation controls hidden without `OPERATIONS_WRITE`. API hooks per page in `api.ts` (TanStack Query over `apiFetch`). i18n keys added to **both** `ru.json` and `en.json` (missing keys fail tests).

### Code Search (`apps/admin/src/pages/code-search/`, route `/codes`)

- Top: prominent exact-search input (paste KM or SSCC, Enter/button). Code found → navigate `/codes/km/:codeHash`; box → `/codes/box/:boxId`; failure → inline alert (unrecognized format / not in system).
- Below: code registry — `FilterBar` (period via 2× `DatePicker`, product `Combobox`, status `Select`: free/aggregated/written_off) + `Table` (code = GTIN+serial mono, product, `StatusChip` status, box SSCC link, scannedAt), pagination. Row click → code card.
- **Code card** `/codes/km/:codeHash`: `PageHeader` + detail fields (product, GTIN, serial, status, current box link) + vertical history timeline (event type icon, time, shift/terminal/operator, links to box / pickup order / disaggregation document).
- **Box card** `/codes/box/:boxId`: header (SSCC in HRI format via `formatSsccHri`, status, product, shift, opened/closed/disassembled by-whom-when) + composition table (each code links to its card; displaced/removed rows dimmed and flagged) + box events block.

### Disaggregation (`apps/admin/src/pages/disaggregation/`, route `/disaggregation`)

- Document list (pickup-list pattern): `FilterBar` (status, reason, period) + `Table` (docNo, date, `StatusChip`, reason, box/code counts, author). "Create document" → creates draft, opens it.
- **Document detail** `/disaggregation/:id` (modeled on `pickup/OrderDetail.tsx`):
  - Header: docNo, status chip, reason `Select` (dictionary) and comment `Textarea` — editable in draft;
  - Add panel: multiline scan/paste field for SSCCs + "Import from file" (file input → multipart);
  - Lines `Table`: SSCC, product, code count, validation `StatusChip` (ok / not found / not closed / shift open / already disassembled / written off / duplicate), per-line delete;
  - Footer: **Apply** (enabled iff ≥1 line, all lines `ok`, reason selected; `ConfirmDialog`: "N boxes, M codes will become free; irreversible") and **Cancel document**. On apply 409: lines re-render with fresh statuses + alert.
  - Applied/cancelled document: read-only, shows appliedAt/by; line SSCCs link to box cards.
- Reasons dictionary: section/tab on the Disaggregation screen (pattern: `apps/admin/src/pages/kiosks/ReasonsPage.tsx`).

## 4. Edge cases

- **Race with kiosk/station:** between draft validation and apply a box may enter a pickup order or be disassembled from a station — closed by re-validation inside the apply transaction under `box-registry-lock` (same lock as station batches and kiosk).
- **Re-aggregation after disaggregation:** nothing extra needed — after `removedAt` codes are free and stations accept them into new boxes normally; a disassembled box's SSCC is never reissued (existing rule).
- **Same box in two drafts:** allowed (drafts are working lists); applying the second document fails validation with `already_disassembled`.
- **Import:** digits-and-separators only so encoding-safe; empty lines skipped; in-file duplicates collapse to one line + `duplicate` lines; unparseable lines stored as `not_found` preserving `ssccInput`.
- **Open box on a station:** `not_closed` — cannot disaggregate until the station closes it.
- **Open shift:** `shift_open` — cannot disaggregate until the shift is closed; UI copy explains disaggregation becomes available after shift close.
- **KM that was scanned but sits nowhere:** code card shows status "free" with its scan history — a valid result, not an error.

## 5. Testing

- **API — `disaggregation`:** line validation across all seven statuses; apply happy path (assert `disassembledAt`, `removedAt`, `box_exceptions` row with document link, registry version bump); apply race (409, document stays draft, line statuses updated); mutation rejection on applied/cancelled; import parsing (separators, limits, duplicates, garbage lines); reasons CRUD.
- **API — `code-search`:** input classification (KM / SSCC 18 and 20 digit / HRI-formatted / garbage); derived code status for all three states; history assembly ordering; registry filters and pagination.
- **Admin (vitest + testing-library, pattern `apps/admin/test/boxes.test.tsx`):** document list render; draft document (add/remove lines, Apply disabled without reason / with invalid lines); apply confirm flow; code card and box card render with history; search input routing. i18n test picks up new keys automatically (RU + EN required).

## Out of scope

- Per-code (partial) disaggregation.
- Substring/serial search.
- CSV/XLSX structured import (plain text list of SSCCs only).
- Undo of an applied document.
- Chestny ZNAK (GIS MT) reporting of disaggregation — station/export flows unchanged.

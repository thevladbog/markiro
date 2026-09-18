# Warehouse pallet aggregation on the handheld — design spec

**Date:** 2026-09-17

**Status:** Approved 2026-09-17; server side implemented in PR #595 (plan 1 of
3); handheld and cabinet UI pending.

**Scope:** Building a pallet out of boxes that were already closed earlier —
in other shifts, by other terminals, or on pallets since disassembled — by
scanning their SSCC labels on the handheld (`apps/handheld`). Covers the
database, `POST /station/scans`, a device bootstrap endpoint, the box
registry, the handheld screen, the cabinet list/card/export and the employee
permission. The line station is explicitly a later slice; the server contract
is designed so it can join without another migration.

Builds on 06d (`2026-09-11-06d-pallets-design.md`), which made pallets a
production-only, per-terminal, per-shift automatic artefact and listed
«pallet building outside a shift» as deliberately absent.

## Outcome

An operator on the warehouse floor opens «Паллеты» on the handheld, scans the
SSCC of each box they stack, and the device refuses anything that must not go
on: an unknown box, a box that already stands on a live pallet, a box of
another product, a pallet label, a unit code. When the stack reaches the
product's pallet capacity — or the operator closes it early — the device burns
a serial from its own extension-1 pool, prints the pallet label, and later
syncs the memberships and the closure. The server re-checks every membership
and names each rejected box, so two offline handhelds that raced for the same
box end with one visible, recoverable conflict instead of one silently wrong
pallet. Nothing in this flow writes into the KM scan journal, so a box scan
can never be counted as an invalid or duplicate unit scan.

The cabinet lists warehouse pallets beside production ones, opens a card with
the boxes and their origin shifts, disassembles through the existing
document, and exports one pallet as a GIS MT aggregation of box SSCCs.

## Decisions

| Question                     | Decision                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Where the boxes come from    | Anywhere in the tenant: other shifts, other terminals, disassembled pallets      |
| Box already on a live pallet | Refused with the pallet's SSCC; move requires disassembling the old pallet first |
| Homogeneity                  | One product (GTIN) per pallet; the first box fixes it. Shifts and dates may mix  |
| Offline                      | Fully offline: local registry mirror decides, server re-validates at sync        |
| Devices in this slice        | Handheld only; station later                                                     |
| Server model                 | Same `pallets` table with `kind = 'warehouse'` (approach A below)                |
| Cabinet                      | Org-wide list, card, disassembly via existing document, per-pallet GIS MT export |
| Pallet issuer prefix         | Always the organisation's own GLN                                                |
| Membership history           | Not kept beyond `boxes.pallet_id`; the disassembly exception/document is the log |

### Why one table with a `kind`, not a second pallet model

Three shapes were considered.

- **A. `pallets.kind`** — one label model, one print-recovery path, one
  exceptions table, one card, one disaggregation line type, one export
  renderer. The cost is a nullable `shift_id` and a few `kind` branches.
  Chosen.
- **B. `warehouse_pallets` + `warehouse_pallet_boxes`** — clean isolation and
  free membership history, at the price of a second copy of everything above
  and two «which pallet am I on» fields on a box. This is the parallel model
  06d refused when it chose a sibling table over a level column.
- **C. A synthetic «warehouse shift»** — no model change, but a shift is a
  production object with a product, a date, a closure and an export whose
  codes belong to other shifts. The shift UX on the handheld is not this flow.

## 1. Database

Two migrations in `packages/db/migrations/`: `0162_warehouse_pallets` and
`0163_pallet_export_code_counts`.

### 1.1 `pallets`

| Change                                    | Notes                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `shift_id` → nullable                     | composite FK kept                                                                                                     |
| `kind text not null default 'production'` | CHECK `kind in ('production','warehouse')`                                                                            |
| `product_id uuid null`                    | composite FK `(tenant_id, product_id)` → `products`                                                                   |
| `device_id uuid null`                     | composite FK `(tenant_id, device_id)` → `station_devices`                                                             |
| CHECK `pallets_kind_shape`                | `production ⇒ shift_id not null`; `warehouse ⇒ shift_id is null and product_id is not null and device_id is not null` |
| `pallets_warehouse_device_pallet_uq`      | unique `(tenant_id, device_id, device_pallet_id) WHERE kind = 'warehouse'`                                            |
| index `pallets_tenant_kind_closed_idx`    | `(tenant_id, kind, closed_at)` for the org-wide list                                                                  |

`pallets_device_pallet_uq` stays for production pallets; with `shift_id` null
it cannot fire for warehouse rows, which is why the partial unique above
exists. A production pallet's product is still derived through its shift;
`product_id` is written only for warehouse pallets.

### 1.2 `boxes.pallet_id`

The column and its «never cleared» rule stay. One relaxation: the value may
be **overwritten** when the pallet it points at has `disassembled_at` set.
This is the only change to a 06d invariant. Which boxes stood on a
disassembled pallet is not reconstructible afterwards from `boxes` alone;
the `pallet_exceptions` row and the disaggregation document remain the
record. A membership history table was considered and left out.

### 1.3 `pallet_exceptions`

`shift_id` → nullable (today NOT NULL). The index
`pallet_exceptions_tenant_shift_recorded_idx` stays; the card reads through
the existing `pallet_exceptions_tenant_pallet_idx` (`tenant_id, pallet_id,
recorded_at`) — no new index is needed.

### 1.4 `pallet_membership_rejections`

New, append-only. Migration 0163 also scopes
`shift_exports_total_code_count_positive` to shift rows (`total_code_count
is null or ... > 0 or pallet_id is not null`) and relaxes the artifact
check to `shift_export_artifacts_code_count_nonnegative` (`code_count >=
0`), because a pallet export legitimately reports zero unit codes:

| Column                                    | Notes                                                        |
| ----------------------------------------- | ------------------------------------------------------------ |
| `id`, `tenant_id`                         |                                                              |
| `pallet_id uuid not null`                 | composite FK → `pallets`                                     |
| `box_sscc char(18) not null`              | the scanned value, whether or not a box exists for it        |
| `box_id uuid null`                        | composite FK → `boxes` when resolved                         |
| `reason text not null`                    | CHECK in the status list of §2.2 minus `accepted`/`replayed` |
| `winning_pallet_id uuid null`             | for `already_on_pallet`                                      |
| `added_at`, `recorded_at`                 | device clock / server `now()`                                |
| unique `(tenant_id, pallet_id, box_sscc)` | a replayed batch does not duplicate the rejection            |

The server must remember a refusal: a handheld that reboots after receiving
the batch response has nothing else to rebuild its conflict view from, and
the cabinet needs the count on the card.

### 1.5 `employees.can_build_pallets`

Boolean, default false, beside `can_writeoff`.

## 2. Server

### 2.1 Bootstrap — `GET /station/pallet-bootstrap`

`StationOnlyGuard`, `OPERATIONS_READ`, modelled on
`GET /station/writeoff-bootstrap`:

```ts
{
  generatedAt: string;
  products: { id; gtin14; name; printName; shelfLifeDays; palletBoxCapacity: number | null; chzProductGroupCode: number | null }[];
  operators: { employeeId; canBuildPallets: boolean }[];
  palletSscc: { issuerPrefix; extensionDigit: 1; fromSerial; toSerial; consumedThroughSerial } | null;
  palletSsccRevokedFrom: number[];
  palletLabelTemplates: {
    organisation: LabelTemplateSpec | null;
    byCategory: { chzProductGroupCode: number; template: LabelTemplateSpec }[];
  };
}
```

`palletSscc` comes from `SsccService.allocateForBundle(tenant, orgPrefix, 1,
deviceId, PALLET_BLOCK_SIZE)`. The issuer prefix is the organisation
profile's GLN, resolved by a new `resolveOrganisationIssuerPrefix(tenantId)`
split out of `resolveIssuerPrefix`. A missing GLN, a read-only subscription
or an exhausted capacity yields `palletSscc: null` — the device still gets
products and templates, as the shift bundle degrades.

Because blocks are keyed `(tenant, prefix, ext, device)`, this is the very
same block the shift bundle hands the device when a shift's issuer is the
organisation; the device burns from one local `sscc_ranges` table in both
modes and cannot double-issue a serial across them.

### 2.2 The sync batch — `POST /station/scans`

Three backward-compatible changes.

**`palletMemberships[]`** — new record kind:

```ts
{
  palletId: string; // device-local, max 64
  boxSscc: string; // 18 digits
  addedAt: string; // device clock
  operatorId: string | null;
}
```

capped by `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH` exported from
`@markiro/domain` and read by both sides, for the reason 06d wrote down about
the pallet-closure cap: a drain limit above the endpoint's ceiling wedges the
queue forever.

**`pallets[]`** (closures) gains `kind: 'production' | 'warehouse'`
(default `production`), `productId: uuid | null` and allows `shiftId: null`
when `kind = 'warehouse'`. Validation: `warehouse ⇒ shiftId null ∧ productId
set`; `production ⇒ shiftId set`. For a warehouse pallet, `pallets.terminal_id`
must equal `device_id::text` (DB CHECK `pallets_warehouse_terminal_check`);
the pre-pass writes both from the authenticated device, never from the wire
`terminalId`.

**Per-record response** — the batch response gains

```ts
memberships: {
  palletId: string;
  boxSscc: string;
  status: 'accepted' | 'replayed' | 'already_on_pallet' | 'not_found'
        | 'not_closed' | 'disassembled' | 'pallet_closed' | 'product_mismatch'
        | 'subscription_read_only';
  winningPalletSscc?: string;   // for already_on_pallet
}[];
```

The batch as a whole is still accepted; a refused membership is data, not an
HTTP error. Older devices ignore the field.

### 2.3 Ingest order and statements

Inside the existing single transaction: items → box closures → pallet
pre-pass → **memberships** → pallet closures → box exceptions → pallet
exceptions.

- **Pre-pass** (`upsertPallets`) now also reads `palletMemberships[]`.
  Warehouse rows are inserted `ON CONFLICT DO NOTHING` on
  `pallets_warehouse_device_pallet_uq` with `kind`, `device_id` (the
  authenticated device — the wire `terminalId` is discarded exactly as today)
  and `product_id`. `product_id` for a row first seen through a membership is
  resolved from the scanned box's shift product; a closure arriving later
  with a different `productId` is a logged no-op on that column.
- **Memberships** are sorted by `(palletId, boxSscc)` and applied one
  statement each:

  ```sql
  UPDATE boxes b
     SET pallet_id = :pallet, updated_at = now()
    FROM shifts s, products p, pallets tp
   WHERE b.tenant_id = :tenant AND b.sscc = :sscc
     AND s.id = b.shift_id AND p.id = s.product_id
     AND tp.id = :pallet AND tp.product_id = p.id
     AND tp.closed_at IS NULL AND tp.disassembled_at IS NULL
     AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL
     AND (b.pallet_id IS NULL
          OR b.pallet_id = :pallet
          OR EXISTS (SELECT 1 FROM pallets old WHERE old.id = b.pallet_id AND old.disassembled_at IS NOT NULL))
  RETURNING b.id
  ```

  One matched row means `accepted`, or `replayed` when `pallet_id` already equalled the target. `matched = 0` triggers a diagnostic SELECT that classifies the refusal in
  this order: `not_found` → `replayed` → `not_closed` → `disassembled` →
  `already_on_pallet` (with the winner's SSCC) → `pallet_closed` (the TARGET
  pallet is itself closed or disassembled) → `product_mismatch`, and
  writes `pallet_membership_rejections` (`ON CONFLICT DO NOTHING`).

- Accepted box ids are collected and passed to `advanceBoxRegistryVersion`
  once at the end of the transaction.
- **Closures** for `kind = 'warehouse'` resolve the pallet by
  `(tenant, device, devicePalletId)`; everything else — `sscc`, `closed_at`,
  `closure_received_at`, print outcomes, `recordConsumedSerial(ext 1)`,
  the `pallets_tenant_sscc_uq` 409 — is unchanged. A warehouse closure also
  calls `advanceBoxRegistryVersion` for its member boxes so the registry can
  carry `palletSscc`.
- **Disassembly** (`applyPalletExceptions` and the disaggregation document)
  gains one line: `advanceBoxRegistryVersion` for the member boxes. Without
  it every handheld keeps refusing those boxes as «on a pallet».

### 2.4 Box registry — `GET /station/box-registry`

Each `upsert` item on the station route gains:

```ts
palletId: string | null;
palletSscc: string | null; // null while the pallet is open
palletActive: boolean; // pallet exists and disassembled_at is null
closedAt: string;
productionDate: string | null; // shift's effective civil date, YYYY-MM-DD
```

The query joins `pallets` on `boxes.pallet_id`. The kiosk feed is unchanged
(its PWA parser has a strict field allowlist, so a widened item would wedge the
refresh of every deployed bundle); only `GET /station/box-registry` carries the
pallet fields, and the handheld's JSON ignores unknown keys. Eligibility rules
are **not** changed: a box the registry already omits (incomplete membership,
over `MAX_BOX_REGISTRY_MEMBERS`, a code not matching the product GTIN) stays
omitted and therefore cannot be palletised from the handheld. This is a
known limitation of this slice, surfaced on the device as «unknown box».

### 2.5 Cabinet API

- `GET /pallets`: `shiftId` becomes optional; new filters `kind`,
  `productId`, `closedFrom`, `closedTo`, `deviceId`; cursor pagination when
  `shiftId` is absent. Each row gains `kind`, `productId`, `productName`,
  `deviceName`, `rejectedMembershipCount`.
- The card is served by the existing `GET /code-search/pallets/:id` (no new
  route): pallet fields, boxes with `shiftId`, `shiftNumber`,
  `productionDate`, `unitCount`, exceptions, rejections.
- `POST /pallets/:id/exports` with `format: 'pallet_xml_gismt_aggregation'`,
  run by the existing durable report-job runner, file in object storage,
  audit `pallet_export.created` on submission and `pallet_export.completed`
  / `pallet_export.failed` on outcome, with actor, tenant, pallet id, format,
  result. Available for any closed, non-disassembled pallet of either kind.
- `PUT /employees/:id` accepts `canBuildPallets`.
- `PUT /org/profile` pallet defaults already exist; the admin picker ships
  here (06d's open debt).

All routes keep the existing guard set and tenant scoping; cross-tenant
denial is tested on every one.

### 2.6 Export renderer

`shift_xml_gismt_aggregation_pallets` already emits box `pack_content`
blocks followed by pallet `pack_content` blocks with `<sscc>` children. The
per-pallet format reuses the same renderer with a source of one pallet and
**no box blocks**: the boxes' own codes were reported by their shifts'
aggregation documents, and re-submitting them would be a second aggregation
of the same codes. `unpalletizedBoxes` is empty by construction.

## 3. Handheld

### 3.1 Storage (Room migration in `core/storage/Migrations.kt`)

- `PalletEntity` gains `kind`, `productId`, `deviceId`; `shiftId` becomes
  nullable. The DAO's `open(shiftId)` is joined by `openWarehouse()`.
- `pallet_memberships`: `(palletId, sscc) PK, addedAt, operatorId, status
(pending | sent | accepted | rejected), reason?, winningPalletSscc?,
ackedAt?`. Pure facts after `sent`; `status` is the only column updated.
- `writeoff_boxes` is renamed `box_registry` (the table is already the
  tenant-wide registry mirror, the name was an accident of the first
  consumer) and gains the five registry fields of §2.4 plus
  `localPalletId: String?` — the device's own claim, set on scan, cleared on
  local removal, so a second scan of the same box before the next registry
  refresh is still caught.
- `pallet_bootstrap` meta: products, operators' `canBuildPallets`, the
  template specs, `generatedAt`. The extension-1 range goes into the existing
  `sscc_ranges` table.

### 3.2 Screen — «Сборка паллеты»

Hub tile «Паллеты» beside «Списание»; route `Routes.PALLETS` with no
`shiftId`; visible only to an operator with `canBuildPallets`.

- **Scan gate.** The screen collects `ScanEvents.events` exclusively while
  resumed, exactly as the write-off screen does. Nothing scanned here reaches
  `ScanRecorder`, `scan_events` or the outbox. A KM shows «Это код единицы,
  нужен SSCC короба»; the error counter and the error sound of the work
  screen are not involved.
- **Classification** uses `ScanClassifier.classify` (check digit, `]C1`).
  `Sscc.parse` is not used here.
- **Checks**, in order, against `box_registry`:
  1. no row → «Короб неизвестен. Обновите реестр» (with a refresh action);
  2. already in the current pallet → «Уже на этой паллете» — soft, no error
     state, idempotent. Runs before checks 3-4: once this device's own
     membership is accepted and the registry refreshes, the box's row already
     reads `localPalletId`/`palletActive` as if it conflicted with itself, so
     the idempotent check must win over the hard refusals below;
  3. `localPalletId` set to another open local pallet → «Уже на паллете
     (эта же ТСД)»;
  4. `palletActive` → «Уже на паллете …{last 6 of palletSscc}» (or «на
     открытой паллете другого устройства» when `palletSscc` is null);
  5. `productId ≠ pallet.productId` → «Другой товар: {name}»;
  6. accept: insert `pallet_memberships(pending)`, set `localPalletId`,
     short vibration, count advances.
     An SSCC with extension digit 1, or one found in the local `pallets` table,
     is «Это паллета, не короб».
- **Opening.** The first accepted scan creates the `PalletEntity` with
  `kind = warehouse`, `productId` from the box, `deviceId` from the device
  record. No serial is burned and no server row exists until then.
- **Strip.** «Паллета · 7 / 12 коробов · {product}». Capacity is the
  product's `palletBoxCapacity`; null capacity means manual close only.
- **Close.** At capacity, automatically; earlier through «Закрыть паллету
  досрочно» with a confirmation naming the count. `ClosePallet` reuses the
  06d path: `burnSerial(ext 1)` → `buildSscc` → `PalletDao.close` → label
  through `core/print` with the existing deferred/failed queue and the rule
  that an `unknown` print is never resent automatically. Refusals mirror
  06d: `no-serials` leaves the pallet open over capacity with the attention
  strip; `no-template` is new and reads «Нет шаблона этикетки паллеты —
  задайте его в кабинете».
- **Label.** Template: the product's category default, else the organisation
  default. Values: `sscc`, `qty.boxes`, `qty` = Σ `bottleCount`, product
  fields from bootstrap. «Дата производства»/«Годен до» are bound only when
  every member's `productionDate` is equal; otherwise those fields render
  empty. `shelfLifeExpiryDate` from `@markiro/domain` is used when bound.
- **Removing a box** from the open pallet (long-press → «Убрать») is allowed
  while its membership is `pending`; the row is deleted and `localPalletId`
  cleared. A membership already `sent` cannot be removed on the device — the
  server may already hold it; the operator disassembles instead.
- **Conflict state.** When a batch response marks memberships `rejected`,
  the pallet card turns to the attention colour with «Снимите с паллеты:»
  and the list of SSCCs with reasons, «Перепечатать этикетку» (the
  `reprint` pallet exception, since `qty.boxes` changed) and «Принято»,
  which dismisses the banner but keeps the rejection rows. A new pallet can
  be started meanwhile; the line is never blocked.
- **Disassemble a pallet** (`kind` either) joins the handheld exceptions
  hub: scan the pallet label → reason → `pallet_exceptions(disassemble)`.
  06d left this undrawn; it is needed here because «move a box» is
  «disassemble, then rebuild».

### 3.3 Sync

- `SyncEngine` reads `pallet_memberships WHERE status = 'pending'` up to
  `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH`, marks them `sent` under the
  batch's pin, and folds their `(palletId, sscc)` set into the `batchId`
  signature beside boxes, pallets and label events (§4.2 of 06d explains why
  a record that joins a batch after its id was computed is lost).
- On response, each membership is set `accepted`/`rejected(reason,
winningPalletSscc)`; `replayed` counts as accepted.
- The registry mirror (`WriteoffMirror`, renamed `BoxRegistryMirror`)
  refreshes on entering the screen and after every accepted batch; applying
  an upsert clears `localPalletId` when the server's `palletId` matches the
  device's own accepted pallet.
- Bootstrap refresh on entering the screen and daily; a stale bootstrap
  (older than the configured horizon, same as write-off) shows «данные на
  10:42» and keeps working.

### 3.4 Strings

RU and EN together, as always.

## 4. Cabinet

- **«Паллеты»** — a new page under Operations: filters «Производственные /
  Складские», product, period, device; columns SSCC, kind, product, boxes,
  units, closed, disassembled, «состав изменён», rejections. Shift panels
  keep their shift-scoped pallet list.
- **Pallet card** — `PalletCard` from code search promoted to a routed
  page: header, boxes with origin shift (number, production date) and unit
  count, exceptions timeline, rejected memberships with reasons, actions
  «Экспорт агрегации», «Расформировать» (opens a prefilled disaggregation
  document).
- **Disaggregation** — unchanged UI; a warehouse pallet line validates like
  a production one.
- **Export dialog** — one format for now; the job appears in the existing
  exports list with its file.
- **Employee card** — checkbox «Сборка паллет на ТСД».
- **Organisation profile** — «Этикетка паллеты по умолчанию» picker and
  per-category pallet defaults, mirroring the box pickers.

## 5. Errors, races, compatibility

- **Older devices** send no `palletMemberships`, no `kind`; everything
  defaults to today's behaviour. New registry fields are ignored by the
  kiosk and by the write-off mirror on a not-yet-updated handheld.
- **Two handhelds race for one box.** First batch wins. The loser's pallet
  is already closed and printed; the server keeps it with its actual
  members, records the rejection, and the device shows the conflict. The
  cabinet card shows `rejectedMembershipCount` and the box list as the
  server holds it. The existing `contentsChangedAfterClose` flag is not
  reused for this — it describes disassembly after closure, a different
  fact.
- **Box not yet on the server** (closed offline on another line) is
  «unknown» on the device: an honest refusal, never a false accept.
- **Membership before closure** is the normal order; a membership naming a
  pallet the server has not seen creates the warehouse row in the pre-pass.
- **Replay** is `replayed` per membership, no-op per closure, `ON CONFLICT
DO NOTHING` per rejection.
- **Empty extension-1 pool** — pallet stays open over capacity, boxes keep
  joining, closes after the next bootstrap. 06d's rule, unchanged.
- **Archived or missing product** — the box is still accepted by GTIN from
  the registry; the label uses the bootstrap product row, and a product
  absent from bootstrap refuses the scan with «Товар неизвестен».
- **Clocks** — `addedAt` is device time and is never used to order events
  across devices; `recorded_at` and `closure_received_at` are server time.
- **Kiosk feed** — the kiosk's PWA parser rejects an upsert carrying any key
  outside its seven-field allowlist, so only `GET /station/box-registry`
  carries the pallet block (§2.4).

### Follow-ups

- Admin `PalletCard.tsx` links to `/shifts/${shiftId}` unconditionally; a
  warehouse pallet has no shift, so the link must guard a null `shiftId`
  (plan 3).
- Offline grant evidence (`grant-evidence-native.service.ts`) skips warehouse
  closures. Whether a warehouse closure belongs in the evidence chain is a
  product decision that is still pending.

## 6. Verification

Standard gates per area (root `AGENTS.md`): domain and db built before
consumers; API against a live database; admin and handheld on their own
gates; from `apps/handheld`, `./gradlew --no-daemon testDebugUnitTest
lintDebug assembleDebug`.

Tests that must exist:

- **API**: cross-tenant denial on bootstrap, memberships, `GET /pallets`
  (org-wide), the card, the export and the employee flag; exact audit
  assertions for the export and for warehouse-pallet disassembly; every
  membership status including `replayed`; the two-device race; a legacy
  batch with no new fields; `advanceBoxRegistryVersion` firing on
  membership, on warehouse closure and on disassembly (asserted through the
  registry delta, not the counter); registry items carrying the five new
  fields; `pallets_kind_shape` and the partial unique constraint; the
  per-pallet XML containing only `<sscc>` children and no box blocks;
  `pallet-bootstrap` degrading `palletSscc` to null without a GLN.
- **Domain**: `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH` exported and used by
  the DTO; the pallet label with mixed production dates binds no date and
  with equal dates binds `shelfLifeExpiryDate` (one-day, leap-year and
  timezone cases).
- **Handheld**: scan classification into KM / box SSCC / pallet SSCC /
  unknown; each refusal branch in §3.2 order; idempotent re-scan; opening on
  first scan only; close at capacity and early close; `no-serials` and
  `no-template`; removal allowed only while `pending`; the batch signature
  including memberships; rejection applied to the right rows and surviving
  a process restart; the registry rename migration preserving existing
  write-off rows.
- **Admin**: list filters, card rendering with mixed shifts, export dialog,
  employee checkbox, profile pickers.

Not proven by any of the above and reported as such: physical printing of
the pallet label, vendor scanner behaviour on a real terminal, and GIS MT
acceptance of a pallet-only aggregation document.

## Risks and open points

- **Registry eligibility** excludes some legitimate boxes (§2.4). If the
  floor hits this, the fix is a registry item flag rather than a relaxed
  filter, so the kiosk keeps its guarantees.
- **Label dates** on a mixed-date pallet render empty. Tenants whose
  templates put a date on every pallet label will see blank fields; a
  range field is a possible follow-up.
- **Membership history** is not kept. If regulators or 1C ask «which boxes
  were on pallet X before it was disassembled», the answer today is the
  disaggregation document's lines, which exist only when the cabinet did the
  disassembly.
- **Station** joins later; the contract has no station-specific gap, but
  the station lacks a registry mirror and a no-shift mode, both of which are
  real work.

# Handheld (ТСД) Write-off — Design Spec

**Date:** 2026-09-14

**Status:** Approved in brainstorming 2026-09-14. The database and API half is
implemented on `claude/handheld-writeoff`
([plan 1](../plans/2026-09-14-handheld-writeoff-1-db-api.md)); the cabinet and
the handheld app are not.

**Scope:** A write-off contour on the handheld terminal, producing the same
document the pickup kiosk already produces for `reason='writeoff'`. Units and
whole boxes, no prices, one reason per document chosen after scanning.

**Supersedes:** the "write-offs on the handheld" line in the _Out of v1_ section
of [design brief 10](../../design-briefs/10-tsd-handheld.md), updated alongside
this spec.

**Mockups:** drawn 2026-09-14 as the `12-writeoff/` row (10 frames) plus
`03-hub/writeoff` in `docs/design-briefs/markiro-tsd.pen`.

## Outcome

The handheld gains a fourth hub mode, **Списание**. An operator walking the floor
scans damaged units and boxes, picks one reason from the tenant's shared reason
dictionary, confirms, and the device files a `pickup_orders` row with
`reason='writeoff'` — the same document, the same act, the same 1С export the
kiosk already produces.

The single structural change that makes this possible: `pickup_orders` stops
assuming its source device is a kiosk.

Prices are absent from every handheld screen. On the kiosk a write-off is one of
two operations and the cart must show what the goods are worth; on the handheld
write-off is the _only_ operation in the mode, and a price would be noise at
best and a wrong number at worst.

## Decisions

| Question           | Decision                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document identity  | The same `pickup_orders` document as a kiosk write-off. One list, one act, one export, one reason dictionary.                                                                                                                                        |
| Attribution        | The signed-in operator. `employees` is already the single people registry (see the comment on `operator_credentials` in `packages/db/src/schema/pickup.ts`), so the handheld operator and the kiosk employee are the same row. No second badge scan. |
| Scannable input    | Loose marking codes **and** whole boxes by SSCC.                                                                                                                                                                                                     |
| Reason granularity | One reason per document, chosen after the list is complete. Different reasons mean different documents.                                                                                                                                              |
| Reason dictionary  | The existing shared `pickup_order_reasons`, managed in the cabinet. No handheld-specific dictionary.                                                                                                                                                 |
| Catalog scope      | The whole tenant catalog, mirrored on the device. Floor damage is not scoped to a line.                                                                                                                                                              |
| Day limits         | A write-off never spends an employee's daily allowance — on the handheld **and** on the kiosk.                                                                                                                                                       |
| After confirmation | A result screen, plus an in-mode history of recent write-offs with their sync state.                                                                                                                                                                 |

## Data model

### `pickup_orders` becomes device-agnostic

Today `kiosk_id` is `NOT NULL` with a composite FK to `kiosks`, and idempotency
is `unique (tenant_id, kiosk_id, device_seq)`
(`packages/db/src/schema/pickup.ts`). A handheld does not fit.

**As built (migrations 0149 and 0150).** The repository had already solved this
exact shape for the `device_grant_*` tables, so the implementation copies that
precedent rather than inventing a second convention — this supersedes the
`num_nonnulls` sketch this spec originally carried:

1. `kiosk_id` becomes nullable.
2. New `source_kind text NOT NULL DEFAULT 'kiosk'` discriminator and
   `station_device_id uuid`.
3. `CHECK` that `source_kind='kiosk'` implies a kiosk id and a null device, and
   `source_kind='handheld'` the reverse — a document always names exactly one
   source device.
4. Composite FK `(tenant_id, station_device_id, source_kind) → station_devices
(tenant_id, id, kind)`. Including `source_kind` is the point: a row claiming
   `handheld` cannot reference a device of kind `station`. This is what
   `station_devices_tenant_id_kind_uq` (migration 0146) exists to make
   referenceable.
5. Drop `pickup_orders_kiosk_device_seq_uq`; replace with two partial unique
   indexes:
   - `(tenant_id, kiosk_id, device_seq) WHERE kiosk_id IS NOT NULL AND device_seq IS NOT NULL`
   - `(tenant_id, station_device_id, device_seq) WHERE station_device_id IS NOT NULL AND device_seq IS NOT NULL`

   The `device_seq IS NOT NULL` half preserves today's exemption for
   admin-created rows, which the old constraint got from `MATCH SIMPLE` NULL
   semantics.

Existing rows are unaffected: every one of them has a `kiosk_id` and takes
`source_kind='kiosk'` from the default with a NULL `station_device_id`, which
satisfies the check. No backfill.

**`pickup_scan_rejections` needs the same treatment**, discovered during
implementation and not anticipated here originally. Early rejections — unknown
badge, write-off forbidden, archived reason — live in that table, whose
`kiosk_id` was also `NOT NULL` with its own `(tenant, kiosk, device_seq)`
unique. Migration 0150 mirrors 0149 onto it. The reason those rows exist — an
offline document syncing hours late against state that has since changed,
leaving the scanned codes with no trace — applies to a queued handheld write-off
word for word, so the handheld gets the same audit rather than a thinner path.

`pickup_order_items`, `pickup_order_boxes` and `pickup_order_reasons` are
untouched. Reusing the reason dictionary unchanged is the point of choosing one
document over two.

### `total_price` on a handheld write-off

Stays `NULL`. The column is already nullable and the 1С export already types it
`string | null` (`ExportCandidatesResult` in
`apps/api/src/modules/pickup-orders/pickup-orders.service.ts`), so a price-less
document needs no contract change downstream.

## Server

### `PickupDocumentSource`

`PickupOrdersService` threads `kioskId: string` through roughly seventy call
sites. Replace it with

```ts
type PickupDocumentSource =
  { kind: "kiosk"; kioskId: string } | { kind: "handheld"; stationDeviceId: string };
```

The refactor is wide, and it is the main cost of keeping one document. It is
also **not** purely mechanical, which this spec originally assumed: the
concurrency control that serializes a device sequence was a row lock on the
`kiosks` table, and it is what stops an order and a rejection both winning one
`deviceSeq`. A handheld has no kiosk row to lock, so the lock now takes the row
that OWNS the sequence — `kiosks` for a kiosk, `station_devices` for a handheld —
keeping the guarantee per-device instead of letting it become accidentally
global.

Branch on `kind` only where behaviour genuinely differs: the idempotency lookup,
the owner lock, the admission-token path (kiosk only), and the product
allowlist.

### Product resolution

`resolveItems` currently calls `kioskAllowlist(tenantId, kioskId)` and reports
`not_allowed` for a product that exists but is not listed for that kiosk. It
takes an allowlist resolver instead. For a handheld the allowlist is the tenant
catalog.

**Correction, 2026-09-14 (review of PR 568):** this spec originally claimed
`not_allowed` was then structurally unreachable for a handheld. It is not.
`existingProductGtins` does not filter archived products while the handheld
allowlist does, so an **archived** tenant product scanned on a handheld is
"exists but not allowed" and reports exactly `not_allowed`. The cabinet's
wording for that reason is therefore device-neutral rather than naming a kiosk.

### Endpoints

All under `StationOnlyGuard` + `TenantGuard`, the contour the handheld already
uses for shifts, inventory and the operator roster.

- `POST /station/writeoffs` —
  `{ deviceSeq, operatorId, writeoffReasonId, items[], boxes[], createdAt }`.
  The device asserts `operatorId`, exactly as `station-scans` does, so the
  server re-checks `employee_pickup_policies.can_writeoff` for that operator.
  **A client-side permission check is a UI affordance, not the gate.**
  `reason` is fixed server-side to `writeoff`; the endpoint cannot create a
  purchase.
- `GET /station/writeoff-bootstrap` — reason dictionary, tenant catalog
  (GTIN → product name), per-operator `can_writeoff`.
- `GET /station/box-registry` — the existing `BoxRegistryService` behind station
  auth. It is already revision-bounded and cursor-paged; only the guard and the
  route are new.

### Day limits

`applyOrderLineLimit` is not called when `reason='writeoff'`, and
`countTakenToday` / `takenTodayElsewhereByEmployee` stop counting write-off
orders. Both halves are required: skipping enforcement while still counting
history would let yesterday's write-offs eat today's allowance.

This changes existing kiosk behaviour. Write-offs already recorded stop
consuming allowance retroactively, so an employee may find their limit freed the
day this ships.

**Prerequisite, tracked separately:** limits are being switched off by default
tenant-wide (defaults flipped, existing tenants switched off, the cabinet toggle
`pickupLimitsEnabled` retained). That is its own task and its own branch. The
carve-out above is still specified and still implemented, so that re-enabling the
toggle later cannot silently make write-offs spend allowance again.

## Handheld

### Hub

A fourth tile, **Списание**, beside Смена / Инвентаризация / Настройки. Its
status line reads «нет прав» when the operator lacks `can_writeoff`, or «2 не
отправлены» when documents are queued. The mode is self-contained: it neither
requires a shift nor disturbs an active one.

### Flow

1. **Приём сканов.** `hh/AppBar` «Списание» over `hh/StatusStrip`; the body reads
   «Отсканируйте код или короб». Hardware trigger only; the phone variant adds
   `hh/ScanButton`.
2. **Список.** `hh/ScanResultCompact` carries the one-line verdict of the last
   scan (принят / дубль / нет в каталоге / короб не найден). `hh/CounterRow`
   below it: «Всего 24 шт · Коробов 1». Rows are `hh/ListRow` 56 dp — product
   name, code tail or SSCC, «20 шт» for a box — removable by swipe. Footer:
   `hh/Button/Primary` «Далее».
3. **Причина.** Tiles from `pickup_order_reasons` ordered by `sort_order`,
   2 × 3 per page with paging, as on the kiosk. «Подтвердить» stays disabled
   until one is chosen.
4. **Подтверждение.** Reason, unit count, box count, operator.
   `hh/Button/Destructive` «Списать 24 шт» — the action cannot be undone from
   the device and the control says so.
5. **Результат.** Online: the act number. Offline: «В очереди, отправим при
   связи».

**История** lives inside the mode (icon in `hh/AppBar`): the last 20 documents
filed from this device with their sync state, opening one shows contents and
reason, read-only. Offline this is the only way to see what has already been
filed. It is a _display_ of what this device sent; it is explicitly not consulted
when deciding whether a fresh scan is a duplicate (see below).

### Signals

Full-screen `hh/SignalOverlay` is deliberately **not** used here. In a shift the
overlays exist because the operator's eyes are on the conveyor; during a
write-off the operator is reading the list, and a full-screen flash per scan
would be noise. The compact verdict plus vibration is the whole signal channel.

### States

No permission; empty reason dictionary («Причины не заданы — добавьте в
кабинете»); offline banner; catalog never synced. A box whose unit is already in
the list as a loose line is caught locally through `contentKeys`, as the kiosk
does.

## Offline, queue and conflicts

**Its own outbox, the shared engine.** `OutboxEntity` is shift-scoped
(`apps/handheld/.../storage/ShiftEntities.kt`), so write-offs need
`writeoff_outbox`, modelled on `shift_close_outbox`. It joins the existing
`SyncEngine` drain: one drain at a time, shared backoff, and `SyncState.pending`
summed across sources — otherwise the queue indicator in `hh/StatusStrip` and
the hub tile's «2 не отправлены» would disagree.

**`deviceSeq` is assigned at confirmation, before the network.** A monotonic
counter in `MetaStore`. The whole document — lines, reason, operator,
`createdAt` — is persisted to the outbox first. A retry therefore resends the
same sequence, and the server returns the existing document's outcome instead of
creating a second act (the handheld twin of `findKioskOrderOutcome`). Because
idempotency covers it, a blind retry is safe and no separate outcome-polling
protocol is needed.

**Partial acceptance.** The server may reject some lines (`duplicate`,
`unknown_product`, a box already disassembled). The result screen and history
show «Списано 22 из 24 · 2 отклонено», expandable to which lines and why.
Rejected lines are **not** returned to the working list — an operator who does
not notice would write them off twice.

**What is checked locally, and what is not.** Locally: repetition within the
current list only (`kmKey`, plus a box's `contentKeys`). The device does not
check a scan against previously filed documents — not even the ones in its own
history screen. It is not the authority on what has already been written off
tenant-wide, and a device that refuses a code because _it_ filed one earlier
would still miss every code another terminal filed, while inventing refusals
offline. Cross-document conflicts are the server's call and surface as partial
acceptance in the result.

**Mirrors.** The catalog (GTIN → name) and the box registry sync in the
background like the operator roster, each carrying a «данные на 10:42» stamp.
With a catalog that has never synced, the mode shows `hh/State` «Нужна первая
синхронизация» rather than letting someone write off blind.

**Device recovery.** `DeviceRecovery` enumerates outbox tables by name when it
counts unsent work (`apps/handheld/.../storage/DeviceRecovery.kt`).
`writeoff_outbox` must be registered there, or the recovery screen under-reports
and an operator wipes production data believing nothing is pending.

## Cabinet

`PickupOrderListItem.kioskName: string` and the detail's
`device: { kioskId, kioskName, place }` become

```ts
device: {
  kind: "kiosk" | "handheld";
  id: string;
  name: string;
  place: string | null;
}
```

Formally a breaking OpenAPI change, but the blast radius is closed: the 1С
export carries no device field at all (`ExportCandidatesResult`), and pickup
orders are not exposed through the public API. The change lands in the API DTO,
`apps/admin/src/pages/pickup/*` and their tests.

The orders list gains a source filter: Все / Киоски / ТСД.

Reasons management (`ReasonsPage.tsx`) is unchanged. Permissions are unchanged —
`can_writeoff` is already edited in `EmployeePickupPolicySection.tsx`; only its
help text needs to say the right now also applies to handhelds.

## Testing

Per the minimum-checks table in the root `AGENTS.md`:

- **`packages/db`** — the `CHECK` rejects a document naming two devices and one
  naming none; each partial unique index catches a repeated `device_seq` for its
  own device kind; existing kiosk rows survive the migration.
- **`apps/api`** — e2e on `/station/writeoffs`: idempotency on
  `(station_device_id, device_seq)`; refusal when `can_writeoff` is false,
  asserted **server-side** with the device claiming an operator it should not;
  cross-tenant denial; partial acceptance; and, with limits explicitly enabled,
  that a write-off neither spends nor counts against the daily allowance.
- **`apps/kiosk`** — regression: a kiosk write-off no longer spends the limit, a
  purchase still does.
- **`apps/handheld`** — Kotlin: `writeoff_outbox` survives restart; a retry
  resends the same `deviceSeq`; `DeviceRecovery` counts queued write-offs; the
  view model refuses to confirm without a reason.

If the request body is shared across the TypeScript/Kotlin boundary, update the
contract fixtures described in `apps/handheld/AGENTS.md`. TypeScript tests alone
do not prove parity.

## Sequencing

Four branches, each independently green:

0. Limits off by default (separate task, already agreed).
1. DB + API: migration, `PickupDocumentSource`, `/station/writeoffs`,
   write-off bootstrap, `station/box-registry`.
2. Cabinet: device descriptor, source filter.
3. Handheld: mode, outbox, screens, and mockups in
   `docs/design-briefs/markiro-tsd.pen`.

## Out of v1

- Printing the act from the device. The handheld drives label printers
  (ZPL/TSPL); an act is an A4 document generated in the cabinet.
- Reporting withdrawal to Chestny ZNAK. Markiro currently only _reads_ code
  statuses (`withdrawReason` in `chz-exports/true-api.types.ts`); 1С owns the
  outbound side.
- Cancelling or correcting a write-off from the device.
- Pallets. The kiosk document has no pallet line type and this spec does not add
  one.
- An admission-token equivalent of `kiosk_order_admissions`, i.e. filing
  write-offs while the subscription is expired. The handheld follows the
  station's ordinary subscription policy.

## Open questions

- Whether the mode should eventually allow «Отменить последний документ» within
  some short window, or stay cabinet-only for corrections as specified here.

## References

- [Design brief 10 — Handheld (ТСД)](../../design-briefs/10-tsd-handheld.md)
- `packages/db/src/schema/pickup.ts` — `pickup_orders`, `pickup_order_reasons`,
  `employee_pickup_policies`, `operator_credentials`
- `packages/db/src/schema/platform.ts` — `station_devices`
- `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- `apps/kiosk/src/screens/WriteoffReason.tsx`, `apps/kiosk/src/session/flow.ts`
- `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/sync/SyncEngine.kt`

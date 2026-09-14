# Handheld Write-off — Plan 2 of 4: Cabinet

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a handheld write-off legible in the cabinet — name the device that
produced it, and let an admin filter the list by source.

**Architecture:** `kioskName` / `device: {kioskId, kioskName, place}` become one
device descriptor carrying the kind. The orders and rejections queries gain a
second left join on `station_devices`, and the list gains a `source` filter.

**Tech Stack:** NestJS, Drizzle, Zod DTOs, React/Vite admin, Vitest.

**Source spec:** [`2026-09-14-handheld-writeoff-design.md`](../specs/2026-09-14-handheld-writeoff-design.md)

**Depends on:** plan 1, merged as `ba0a6f6c0` (#567).

## Why now

Plan 1 shipped a defect on purpose and documented it. A handheld write-off
currently renders in the cabinet as a row with an **empty device name**, because
`kioskName` comes from a left join that finds nothing, and
`pickup_rejections`' row DTO admits a `null` kioskId with a comment pointing
here. Until this lands, the cabinet under-reports where a document came from.

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. No `any`, no non-null assertions.
- Tenant-scoped queries throughout; the new `station_devices` join carries the
  tenant predicate like every other one.
- Admin text goes through the existing i18n files — both `ru.json` and
  `en.json`. Do not hard-code a language.
- `@markiro/db` and `@markiro/api` ship compiled `dist`; build dependencies
  before consumer tests in a fresh worktree.
- The API DTO change is breaking, and that is accepted: the 1С export carries no
  device field (`ExportCandidatesResult`) and pickup orders have no public API
  surface. The blast radius is the admin app and its tests.

## File Structure

**Modified**

| File                                                                  | Change                                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/api/src/modules/pickup-orders/dto.ts`                           | `device` descriptor on row + detail; `source` filter on the list query |
| `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`         | Join `station_devices`; map the descriptor; apply the filter           |
| `apps/api/src/modules/pickup-rejections/dto.ts`                       | Same descriptor, replacing the nullable `kioskId` / `kioskName` pair   |
| `apps/api/src/modules/pickup-rejections/pickup-rejections.service.ts` | Join and map                                                           |
| `apps/admin/src/pages/pickup/api.ts`                                  | Mirror the row type                                                    |
| `apps/admin/src/pages/pickup/index.tsx`                               | Device column + source filter                                          |
| `apps/admin/src/pages/pickup/OrderDetail.tsx`                         | Device field                                                           |
| `apps/admin/src/pages/pickup/Rejections.tsx`                          | Device column; the kiosk filter becomes a device filter                |
| `apps/admin/src/pages/pickup/rejections-api.ts`                       | Mirror                                                                 |
| `apps/admin/src/i18n/{ru,en}.json`                                    | Labels for the column, the filter and the two kinds                    |

**Tests:** `apps/api/test/pickup-orders.e2e.test.ts`,
`apps/api/test/pickup-rejections.e2e.test.ts`,
`apps/admin/test/pickup-detail.test.tsx`, plus a new admin test for the filter.

## The descriptor

One shape, used by both the order row and the rejection row:

```ts
/**
 * Which device produced a document. `kind` is what the cabinet renders as a
 * badge; `name` is the device's own name in either table. `place` is the
 * kiosk's location and is null for a handheld, which has a line rather than a
 * place — plan 3 may surface the line separately.
 */
export interface PickupDeviceDto {
  kind: "kiosk" | "handheld";
  id: string;
  name: string;
  place: string | null;
}
```

`kind` comes from `pickup_orders.source_kind`, so it is authoritative rather than
inferred from which join matched.

---

### Task 1: The orders list and detail name their device

**Files:**

- Modify: `apps/api/src/modules/pickup-orders/dto.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Test: `apps/api/test/pickup-orders.e2e.test.ts`

**Interfaces:**

- Produces: `PickupDeviceDto`; `PickupOrderRowDto.device` replacing `kioskName`;
  `PickupOrderDetailDto.device` widened from the kiosk-only triple.

- [ ] **Step 1: Write the failing test**

In `apps/api/test/pickup-orders.e2e.test.ts`, seed a handheld device and a
write-off filed against it (the existing fixtures already give a tenant, an
employee and a product; add a `schema.stationDevices` row with
`kind: "handheld"` and a `pickupOrders` row with `sourceKind: "handheld"`).

```ts
it("names a handheld as the source device of its write-off", async () => {
  const list = await pickupOrdersService.list(tenantId, {});
  const row = list.items.find((item) => item.orderNo === handheldOrderNo);
  expect(row?.device).toEqual({
    kind: "handheld",
    id: handheldDeviceId,
    name: "ТСД-1",
    place: null,
  });
});

it("still names the kiosk as the source device of a kiosk order", async () => {
  const list = await pickupOrdersService.list(tenantId, {});
  const row = list.items.find((item) => item.orderNo === kioskOrderNo);
  expect(row?.device).toEqual({
    kind: "kiosk",
    id: kioskId,
    name: "Киоск А",
    place: null,
  });
});
```

Check `list`'s real signature before writing this and match it; the file already
calls the service directly elsewhere.

- [ ] **Step 2: Run it to verify it fails**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/pickup-orders.e2e.test.ts -t "source device"
```

Expected: FAIL — `device` is not a property of the row.

- [ ] **Step 3: Add the descriptor to the DTO**

In `pickup-orders/dto.ts`, add `PickupDeviceDto` as above. Replace
`PickupOrderRowDto.kioskName: string` with `device: PickupDeviceDto`, and the
detail's `device: { kioskId: string; kioskName: string; place: string | null }`
with `device: PickupDeviceDto`. Update `pickupOrderRowOpenApiSchema`: drop
`kioskName` from `required` and `properties`, add `device` with its own object
schema (`required: ["kind", "id", "name", "place"]`).

- [ ] **Step 4: Join the device in the service**

`joinedSelection()` currently selects `kioskName: schema.kiosks.name`. Select the
source columns and both names instead:

```ts
      sourceKind: schema.pickupOrders.sourceKind,
      kioskId: schema.pickupOrders.kioskId,
      kioskName: schema.kiosks.name,
      kioskPlace: schema.kiosks.location,
      stationDeviceId: schema.pickupOrders.stationDeviceId,
      stationDeviceName: schema.stationDevices.name,
```

Add the join beside the existing kiosk one at all three query sites
(`queryJoinedRows` and the two inline queries):

```ts
      .leftJoin(
        schema.stationDevices,
        and(
          eq(schema.stationDevices.tenantId, schema.pickupOrders.tenantId),
          eq(schema.stationDevices.id, schema.pickupOrders.stationDeviceId),
        ),
      )
```

Then map in `mapRowDto`:

```ts
    device:
      row.sourceKind === "handheld"
        ? {
            kind: "handheld" as const,
            id: row.stationDeviceId ?? "",
            name: row.stationDeviceName ?? "",
            place: null,
          }
        : {
            kind: "kiosk" as const,
            id: row.kioskId ?? "",
            name: row.kioskName ?? "",
            place: row.kioskPlace,
          },
```

The `?? ""` fallbacks are unreachable given the check constraint, but the row
type is nullable because the join is a left join; do not reach for a non-null
assertion.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @markiro/api exec vitest run test/pickup-orders.e2e.test.ts test/pickup-export.e2e.test.ts test/pickup-slip.e2e.test.ts test/openapi-docs.test.ts
```

Expected: PASS. The export and slip suites are included because both read joined
order rows.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/pickup-orders apps/api/test/pickup-orders.e2e.test.ts
git commit -m "feat(api): name the source device on pickup order rows"
```

---

### Task 2: Filter the orders list by source

**Files:**

- Modify: `apps/api/src/modules/pickup-orders/dto.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Test: `apps/api/test/pickup-orders.e2e.test.ts`

**Interfaces:**

- Consumes: Task 1's `sourceKind` selection.
- Produces: `listPickupOrdersQuerySchema.source: "kiosk" | "handheld"` (optional).

- [ ] **Step 1: Write the failing test**

```ts
it("filters the list to one source kind", async () => {
  const handhelds = await pickupOrdersService.list(tenantId, { source: "handheld" });
  expect(handhelds.items.map((i) => i.orderNo)).toContain(handheldOrderNo);
  expect(handhelds.items.map((i) => i.orderNo)).not.toContain(kioskOrderNo);

  const kiosks = await pickupOrdersService.list(tenantId, { source: "kiosk" });
  expect(kiosks.items.map((i) => i.orderNo)).toContain(kioskOrderNo);
  expect(kiosks.items.map((i) => i.orderNo)).not.toContain(handheldOrderNo);

  const all = await pickupOrdersService.list(tenantId, {});
  expect(all.items.map((i) => i.orderNo)).toEqual(
    expect.arrayContaining([kioskOrderNo, handheldOrderNo]),
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @markiro/api exec vitest run test/pickup-orders.e2e.test.ts -t "one source kind"
```

Expected: FAIL — the filter is ignored, so both orders come back each time.

- [ ] **Step 3: Add the filter**

```ts
  source: z.enum(["kiosk", "handheld"]).optional(),
```

to `listPickupOrdersQuerySchema`, and in the service's condition builder:

```ts
if (query.source) conditions.push(eq(schema.pickupOrders.sourceKind, query.source));
```

Add the `source` query parameter to the controller's `@ApiQuery` set so the
OpenAPI document keeps describing every filter.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @markiro/api exec vitest run test/pickup-orders.e2e.test.ts test/openapi-docs.test.ts test/openapi-coverage.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/pickup-orders
git commit -m "feat(api): filter pickup orders by source device kind"
```

---

### Task 3: Rejections name their device too

Plan 1 left `PickupScanRejectionRowDto.kioskId` nullable with a comment naming
this plan. Close it.

**Files:**

- Modify: `apps/api/src/modules/pickup-rejections/dto.ts`
- Modify: `apps/api/src/modules/pickup-rejections/pickup-rejections.service.ts`
- Test: `apps/api/test/pickup-rejections.e2e.test.ts`

**Interfaces:**

- Consumes: `PickupDeviceDto` from Task 1 (import it; do not declare a second
  copy).
- Produces: `PickupScanRejectionRowDto.device`, replacing `kioskId`/`kioskName`.
  The list's `kioskId` query parameter becomes `deviceId`.

- [ ] **Step 1: Write the failing test**

```ts
it("names a handheld as the source device of its rejection", async () => {
  const list = await service.list(tenantId, { state: "all" });
  const row = list.items.find((item) => item.deviceSeq === handheldRejectionSeq);
  expect(row?.device).toEqual({
    kind: "handheld",
    id: handheldDeviceId,
    name: "ТСД-1",
    place: null,
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @markiro/api exec vitest run test/pickup-rejections.e2e.test.ts -t "source device"
```

Expected: FAIL — no `device` property.

- [ ] **Step 3: Mirror Task 1's change**

Same join, same mapping, same OpenAPI edit, against `pickupScanRejections`.
Rename the query parameter `kioskId` to `deviceId` and match it against whichever
column the row's `source_kind` names:

```ts
if (query.deviceId) {
  conditions.push(
    or(
      eq(schema.pickupScanRejections.kioskId, query.deviceId),
      eq(schema.pickupScanRejections.stationDeviceId, query.deviceId),
    )!,
  );
}
```

A device id is a UUID from one table or the other, so matching either column is
unambiguous and avoids making the caller say which kind it holds.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @markiro/api exec vitest run test/pickup-rejections.e2e.test.ts test/openapi-docs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/pickup-rejections apps/api/test/pickup-rejections.e2e.test.ts
git commit -m "feat(api): name the source device on scan rejection rows"
```

---

### Task 4: The cabinet renders and filters by device

**Files:**

- Modify: `apps/admin/src/pages/pickup/api.ts`
- Modify: `apps/admin/src/pages/pickup/index.tsx`
- Modify: `apps/admin/src/pages/pickup/OrderDetail.tsx`
- Modify: `apps/admin/src/pages/pickup/Rejections.tsx`
- Modify: `apps/admin/src/pages/pickup/rejections-api.ts`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/pickup-detail.test.tsx`, and a new
  `apps/admin/test/pickup-source-filter.test.tsx`

**Interfaces:**

- Consumes: the API `device` descriptor and the `source` query parameter.

- [ ] **Step 1: Write the failing tests**

In a new `apps/admin/test/pickup-source-filter.test.tsx`, following the existing
admin test harness (see `pickup-detail.test.tsx` for how it mounts the page and
stubs `fetch`): the suite drives controls with `fireEvent`, not `userEvent`.

```tsx
it("shows the device name and kind for a handheld order", async () => {
  renderPickupList([
    orderRow({
      orderNo: "ORD-26-0002",
      device: { kind: "handheld", id: "d-1", name: "ТСД-1", place: null },
    }),
  ]);
  expect(await screen.findByText("ТСД-1")).toBeInTheDocument();
  expect(screen.getByText("ТСД")).toBeInTheDocument();
});

it("asks the API for one source when the filter changes", async () => {
  const { fetchSpy } = renderPickupList([]);
  fireEvent.change(screen.getByLabelText("Источник"), { target: { value: "handheld" } });
  await waitFor(() => {
    expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toContain("source=handheld");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @markiro/admin exec vitest run test/pickup-source-filter.test.tsx
```

Expected: FAIL — no such filter, and the row renders no device name.

- [ ] **Step 3: Mirror the type and render the device**

In `api.ts`, replace `kioskName: string` with
`device: { kind: "kiosk" | "handheld"; id: string; name: string; place: string | null }`
and add `source?: "kiosk" | "handheld"` to the list params, threading it into
the query string beside the existing filters.

In `index.tsx`, the `kioskName` column becomes a device column rendering the name
with the kind as a small badge; keep the column key stable for the table's own
sorting if it has any. In `OrderDetail.tsx`, `order.kioskName` becomes
`order.device.name`, with the kind beside it.

- [ ] **Step 4: Add the source filter control**

A select beside the existing status and reason filters, with options Все /
Киоски / ТСД bound to `undefined | "kiosk" | "handheld"`. Give it an accessible
label — the test selects it by label, and the cabinet's own accessibility rules
require one.

- [ ] **Step 5: Mirror the rejections page**

`rejections-api.ts` gets the same descriptor and renames `kioskId` to
`deviceId`. In `Rejections.tsx`, the kiosk column becomes a device column and
the kiosk filter becomes a device filter. `useOpenRejectionSummary` returns
`deviceNames` rather than `kioskNames`; update the banner in `index.tsx` that
reads it.

- [ ] **Step 6: Add the i18n strings**

Both `ru.json` and `en.json`: the device column title, the source filter label
and its three options, and the two kind labels («Киоск» / «ТСД», "Kiosk" /
"Handheld"). Follow the existing key layout under `pages.pickup`.

- [ ] **Step 7: Run the admin gates**

```bash
pnpm turbo run build --filter='@markiro/admin^...'
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
```

Expected: PASS. `pickup-detail.test.tsx` and any other suite asserting on
`kioskName` will need updating — that is a rename following the API, not a
weakened assertion.

- [ ] **Step 8: Commit**

```bash
git add apps/admin
git commit -m "feat(admin): show and filter pickup documents by source device"
```

---

## Done when

- A handheld write-off shows its device name and a ТСД badge in the orders list,
  the order detail and the rejections list.
- The orders list filters to Все / Киоски / ТСД.
- No cabinet surface reads `kioskName` for a document that has no kiosk.
- `apps/api` and `apps/admin` gates pass.

## Not in this plan

The handheld app itself (plan 3) and limits-off-by-default (plan 0). Surfacing a
handheld's **line** where a kiosk shows its place is deliberately left out: the
descriptor carries `place: null` for a handheld, and whether a line belongs there
is a product question plan 3 is better placed to answer.

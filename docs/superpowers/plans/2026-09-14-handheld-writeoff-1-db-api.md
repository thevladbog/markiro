# Handheld Write-off — Plan 1 of 4: Database and API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a paired handheld file a write-off as the same `pickup_orders`
document the kiosk already produces, and stop write-offs from consuming an
employee's daily allowance anywhere.

**Architecture:** `pickup_orders` gains the repository's established device-owner
shape (`source_kind` discriminator beside nullable `kiosk_id` /
`station_device_id`, copied from `device_grants.ts`). `PickupOrdersService` stops
taking a bare `kioskId` and takes a `PickupDocumentSource` instead. Three new
station-authenticated routes let the device submit and bootstrap.

**Tech Stack:** NestJS, Drizzle ORM, Postgres, Zod DTOs, Vitest.

**Source spec:** [`2026-09-14-handheld-writeoff-design.md`](../specs/2026-09-14-handheld-writeoff-design.md)

## Plan set

This is plan 1 of 4. The others are written separately, each shippable on its own:

| # | Scope | Depends on |
| --- | --- | --- |
| 0 | Limits off by default tenant-wide (defaults flipped, existing tenants switched off, cabinet toggle retained) | none |
| **1** | **Database + API (this plan)** | none |
| 2 | Cabinet: device descriptor on the orders list/detail, source filter | 1 |
| 3 | Handheld: write-off mode, `writeoff_outbox`, screens | 1 |

Plan 0 is independent of this one. The write-off limit carve-out in Task 4 below
is specified and implemented regardless of plan 0, so that re-enabling the
cabinet toggle later cannot silently make write-offs spend allowance again.

## Global Constraints

Every task's requirements implicitly include this section.

- Node 24+, pnpm through Corepack. Run `set -a; source .env; set +a` before any
  database-backed command.
- TypeScript is strict with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. No `any`, no non-null assertions, no broad casts.
- Every business query and write is tenant-scoped. Preserve composite tenant
  foreign keys. Test cross-tenant denial, not only happy paths.
- Add a NEW migration file. Never rewrite an applied one to make a fresh database
  look green.
- `@markiro/db` ships compiled `dist`. After changing DB sources run
  `pnpm --filter @markiro/db build` before any API test, or the API runs against
  stale output.
- The device asserts `operatorId` in the request body, exactly as `station-scans`
  does. It is never trusted: `employee_pickup_policies.can_writeoff` is
  re-checked server-side on every submit.
- A write-off never spends and never counts against an employee's daily
  allowance — handheld and kiosk alike.
- Reasons come from the existing shared `pickup_order_reasons`. Do not add a
  handheld-specific dictionary.
- A handheld write-off carries no prices: `pickup_orders.total_price` stays
  `NULL`.
- `reason` is fixed server-side to `writeoff` on the station route. That route
  must not be able to create a purchase.

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `packages/db/migrations/0149_pickup_order_device_source.sql` | Migration: owner columns, check, FK, two partial unique indexes |
| `apps/api/src/modules/pickup-orders/document-source.ts` | `PickupDocumentSource` type and its narrow helpers |
| `apps/api/src/modules/station-writeoffs/station-writeoffs.controller.ts` | `POST /station/writeoffs`, `GET /station/writeoff-bootstrap` |
| `apps/api/src/modules/station-writeoffs/station-writeoffs.service.ts` | Operator permission check, bootstrap assembly |
| `apps/api/src/modules/station-writeoffs/dto.ts` | Zod request schema + OpenAPI response schemas |
| `apps/api/src/modules/station-writeoffs/station-writeoffs.module.ts` | Nest module wiring |
| `apps/api/test/station-writeoffs.e2e.test.ts` | Endpoint e2e: idempotency, permission, tenancy, partial acceptance |
| `apps/api/test/pickup-writeoff-limit.test.ts` | Write-off does not spend or count allowance |

**Modified**

| File | Change |
| --- | --- |
| `packages/db/src/schema/pickup.ts` | `pickupOrders` owner columns, check, FK, indexes |
| `packages/db/test/pickup-schema.test.ts` | Constraint coverage |
| `apps/api/src/modules/pickup-orders/pickup-orders.service.ts` | `PickupDocumentSource` threading, allowlist resolver, limit carve-out |
| `apps/api/src/modules/pickup-orders/dto.ts` | Station write-off content shape reuse |
| `apps/api/src/modules/kiosk/kiosk.controller.ts` | Pass a `kiosk` source |
| `apps/api/src/modules/kiosk/pairing.service.ts` | `pickupOrders.kioskId` reads |
| `apps/api/src/modules/kiosk/box-registry.service.ts` | Reused unchanged by the station route |
| `apps/api/src/app.module.ts` | Register `StationWriteoffsModule` |

---

### Task 1: `pickup_orders` learns about devices that are not kiosks

Today `kiosk_id` is `NOT NULL` with a composite FK to `kiosks`, and idempotency
is one `unique (tenant_id, kiosk_id, device_seq)`. A handheld cannot be
expressed. The repository already solved this exact shape for device grants —
copy it rather than inventing a second convention.

**Files:**
- Modify: `packages/db/src/schema/pickup.ts` (the `pickupOrders` table)
- Create: `packages/db/migrations/0149_pickup_order_device_source.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Test: `packages/db/test/pickup-schema.test.ts`

**Interfaces:**
- Consumes: `stationDevices` from `./platform.js`; it already carries
  `station_devices_tenant_id_kind_uq UNIQUE (tenant_id, id, kind)` from
  migration 0146, which is what lets the FK below pin the device *kind*.
- Produces: `pickupOrders.sourceKind`, `pickupOrders.stationDeviceId`, and a now
  nullable `pickupOrders.kioskId`, consumed by every later task.

- [ ] **Step 1: Write the failing schema test**

Append to `packages/db/test/pickup-schema.test.ts`. Follow the file's existing
harness for obtaining `db` and a seeded tenant; the assertions below are the new
part.

```ts
it("rejects a pickup order naming two source devices", async () => {
  await expect(
    db.insert(schema.pickupOrders).values({
      tenantId,
      orderNo: "ORD-26-9001",
      sourceKind: "kiosk",
      kioskId,
      stationDeviceId: handheldId,
      employeeId,
      reason: "writeoff",
      itemCount: 1,
    }),
  ).rejects.toThrow(/pickup_orders_source_check/);
});

it("rejects a pickup order naming no source device", async () => {
  await expect(
    db.insert(schema.pickupOrders).values({
      tenantId,
      orderNo: "ORD-26-9002",
      sourceKind: "kiosk",
      employeeId,
      reason: "writeoff",
      itemCount: 1,
    }),
  ).rejects.toThrow(/pickup_orders_source_check/);
});

it("rejects a handheld order pointing at a station device of the wrong kind", async () => {
  await expect(
    db.insert(schema.pickupOrders).values({
      tenantId,
      orderNo: "ORD-26-9003",
      sourceKind: "handheld",
      stationDeviceId: stationKindDeviceId,
      employeeId,
      reason: "writeoff",
      itemCount: 1,
    }),
  ).rejects.toThrow(/pickup_orders_tenant_station_device_fk/);
});

it("keeps device_seq idempotency per device kind", async () => {
  const row = {
    tenantId,
    sourceKind: "handheld" as const,
    stationDeviceId: handheldId,
    employeeId,
    reason: "writeoff" as const,
    itemCount: 1,
    deviceSeq: 7,
  };
  await db.insert(schema.pickupOrders).values({ ...row, orderNo: "ORD-26-9004" });
  await expect(
    db.insert(schema.pickupOrders).values({ ...row, orderNo: "ORD-26-9005" }),
  ).rejects.toThrow(/pickup_orders_handheld_device_seq_uq/);
});

it("exempts a null device_seq from idempotency", async () => {
  const row = {
    tenantId,
    sourceKind: "handheld" as const,
    stationDeviceId: handheldId,
    employeeId,
    reason: "writeoff" as const,
    itemCount: 1,
    deviceSeq: null,
  };
  await db.insert(schema.pickupOrders).values({ ...row, orderNo: "ORD-26-9006" });
  await expect(
    db.insert(schema.pickupOrders).values({ ...row, orderNo: "ORD-26-9007" }),
  ).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db exec vitest run test/pickup-schema.test.ts
```

Expected: FAIL. `sourceKind` / `stationDeviceId` are not columns, so Drizzle
rejects the insert objects and the constraint names never appear.

- [ ] **Step 3: Add the columns and constraints to the schema**

In `packages/db/src/schema/pickup.ts`, add `stationDevices` to the existing
`./platform.js` import (the file already imports `boxes, products` from there),
then change `pickupOrders`:

```ts
    kioskId: uuid("kiosk_id"),
    sourceKind: text("source_kind").$type<"kiosk" | "handheld">().notNull().default("kiosk"),
    stationDeviceId: uuid("station_device_id"),
```

and in its constraint array replace `unique("pickup_orders_kiosk_device_seq_uq")`
with:

```ts
    check(
      "pickup_orders_source_check",
      sql`(${t.sourceKind}='kiosk' and ${t.kioskId} is not null and ${t.stationDeviceId} is null) or (${t.sourceKind}='handheld' and ${t.stationDeviceId} is not null and ${t.kioskId} is null)`,
    ),
    foreignKey({
      name: "pickup_orders_tenant_station_device_fk",
      columns: [t.tenantId, t.stationDeviceId, t.sourceKind],
      foreignColumns: [stationDevices.tenantId, stationDevices.id, stationDevices.kind],
    }),
    uniqueIndex("pickup_orders_kiosk_device_seq_uq")
      .on(t.tenantId, t.kioskId, t.deviceSeq)
      .where(sql`kiosk_id is not null and device_seq is not null`),
    uniqueIndex("pickup_orders_handheld_device_seq_uq")
      .on(t.tenantId, t.stationDeviceId, t.deviceSeq)
      .where(sql`station_device_id is not null and device_seq is not null`),
```

Two things are load-bearing and easy to get wrong. The station FK includes
`sourceKind` against `stationDevices.kind`, so a row claiming `handheld` cannot
point at a `station` device — that is why migration 0146's
`(tenant_id, id, kind)` unique exists. And `device_seq is not null` in both
index predicates preserves today's exemption for admin-created rows, which the
old `UNIQUE` constraint got for free from `MATCH SIMPLE` NULL semantics.

**If the build reports a circular-import failure** between `pickup.ts` and
`platform.ts`: the cycle already exists (`platform.ts` imports `employees` from
`pickup.js`) and `device-grants.ts` proves this exact FK works across both
modules, so the import is expected to be fine. If it is not, drop only the
`foreignKey(...)` entry from the Drizzle table and keep it in the migration SQL
of Step 4, leaving a comment that says why.

- [ ] **Step 4: Write the migration**

Create `packages/db/migrations/0149_pickup_order_device_source.sql`:

```sql
ALTER TABLE "pickup_orders" ALTER COLUMN "kiosk_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pickup_orders" ADD COLUMN "source_kind" text DEFAULT 'kiosk' NOT NULL;--> statement-breakpoint
ALTER TABLE "pickup_orders" ADD COLUMN "station_device_id" uuid;--> statement-breakpoint
ALTER TABLE "pickup_orders" DROP CONSTRAINT "pickup_orders_kiosk_device_seq_uq";--> statement-breakpoint
ALTER TABLE "pickup_orders" ADD CONSTRAINT "pickup_orders_source_check" CHECK ((source_kind='kiosk' AND kiosk_id IS NOT NULL AND station_device_id IS NULL) OR (source_kind='handheld' AND station_device_id IS NOT NULL AND kiosk_id IS NULL));--> statement-breakpoint
ALTER TABLE "pickup_orders" ADD CONSTRAINT "pickup_orders_tenant_station_device_fk" FOREIGN KEY ("tenant_id","station_device_id","source_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_orders_kiosk_device_seq_uq" ON "pickup_orders" ("tenant_id","kiosk_id","device_seq") WHERE kiosk_id IS NOT NULL AND device_seq IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_orders_handheld_device_seq_uq" ON "pickup_orders" ("tenant_id","station_device_id","device_seq") WHERE station_device_id IS NOT NULL AND device_seq IS NOT NULL;
```

Every existing row has a `kiosk_id` and gets `source_kind='kiosk'` from the
default with `station_device_id` NULL, which satisfies the check — so no data
backfill is needed. Append the matching entry to
`packages/db/migrations/meta/_journal.json` with `"idx": 149`, `"version": "7"`,
a `when` timestamp, `"tag": "0149_pickup_order_device_source"`,
`"breakpoints": true`.

- [ ] **Step 5: Apply the migration and run the tests**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db db:migrate
pnpm --filter @markiro/db exec vitest run test/pickup-schema.test.ts
```

Expected: PASS, all five new cases.

- [ ] **Step 6: Verify nothing else regressed, then build**

```bash
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
```

Expected: PASS. The build is required before any API work in later tasks.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/pickup.ts packages/db/migrations/0149_pickup_order_device_source.sql packages/db/migrations/meta/_journal.json packages/db/test/pickup-schema.test.ts
git commit -m "feat(db): let a pickup order name a handheld instead of a kiosk"
```

---

### Task 2: `PickupDocumentSource` replaces the bare `kioskId`

`PickupOrdersService` threads `kioskId: string` through roughly seventy call
sites. This task is a pure refactor: no behaviour changes and every existing
test must stay green. Doing it on its own is what makes the next three tasks
reviewable.

**Files:**
- Create: `apps/api/src/modules/pickup-orders/document-source.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Modify: `apps/api/src/modules/kiosk/kiosk.controller.ts`
- Test: `apps/api/test/kiosk-orders.e2e.test.ts` (existing; must stay green)

**Interfaces:**
- Produces:
  - `type PickupDocumentSource = { kind: "kiosk"; kioskId: string } | { kind: "handheld"; stationDeviceId: string }`
  - `kioskSource(kioskId: string): PickupDocumentSource`
  - `handheldSource(stationDeviceId: string): PickupDocumentSource`
  - `sourceColumns(source: PickupDocumentSource): { sourceKind: "kiosk" | "handheld"; kioskId: string | null; stationDeviceId: string | null }`
  - `sourceLabel(source: PickupDocumentSource): string` — for log lines that used to interpolate a kiosk id
  - `PickupOrdersService.createForDevice(tenantId, source, dto, evidence?)`, replacing `createFromKiosk`
- Consumes: Task 1's columns.

- [ ] **Step 1: Write the source-helper test**

Create `apps/api/test/pickup-document-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  handheldSource,
  kioskSource,
  sourceColumns,
} from "../src/modules/pickup-orders/document-source";

describe("pickup document source", () => {
  it("maps a kiosk source onto the kiosk column only", () => {
    expect(sourceColumns(kioskSource("k-1"))).toEqual({
      sourceKind: "kiosk",
      kioskId: "k-1",
      stationDeviceId: null,
    });
  });

  it("maps a handheld source onto the station-device column only", () => {
    expect(sourceColumns(handheldSource("d-1"))).toEqual({
      sourceKind: "handheld",
      kioskId: null,
      stationDeviceId: "d-1",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @markiro/api exec vitest run test/pickup-document-source.test.ts
```

Expected: FAIL, `Cannot find module '../src/modules/pickup-orders/document-source'`.

- [ ] **Step 3: Write the helper**

Create `apps/api/src/modules/pickup-orders/document-source.ts`:

```ts
/**
 * Which device produced a pickup document. `pickup_orders` used to assume a
 * kiosk; a handheld files the same document, so the source became data rather
 * than an assumption baked into a parameter name.
 */
export type PickupDocumentSource =
  | { kind: "kiosk"; kioskId: string }
  | { kind: "handheld"; stationDeviceId: string };

export function kioskSource(kioskId: string): PickupDocumentSource {
  return { kind: "kiosk", kioskId };
}

export function handheldSource(stationDeviceId: string): PickupDocumentSource {
  return { kind: "handheld", stationDeviceId };
}

/** The exact `pickup_orders` owner columns for a source. */
export function sourceColumns(source: PickupDocumentSource): {
  sourceKind: "kiosk" | "handheld";
  kioskId: string | null;
  stationDeviceId: string | null;
} {
  return source.kind === "kiosk"
    ? { sourceKind: "kiosk", kioskId: source.kioskId, stationDeviceId: null }
    : { sourceKind: "handheld", kioskId: null, stationDeviceId: source.stationDeviceId };
}

/** Stable identifier for log lines. Never used as a query key. */
export function sourceLabel(source: PickupDocumentSource): string {
  return source.kind === "kiosk" ? `kiosk ${source.kioskId}` : `handheld ${source.stationDeviceId}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter @markiro/api exec vitest run test/pickup-document-source.test.ts
```

Expected: PASS.

- [ ] **Step 5: Thread the source through the service**

In `pickup-orders.service.ts`, rename `createFromKiosk` to `createForDevice` and
change its second parameter from `kioskId: string` to
`source: PickupDocumentSource`. Then follow the type errors — the compiler
enumerates every call site, which is the point of doing this as its own task.
Apply one of exactly three shapes at each:

1. **Idempotency and admission lookups keyed by device.** `findKioskOrderOutcome`
   becomes `findOrderOutcome(tenantId, source, deviceSeq, tx?)` and selects on
   the column the source names:

```ts
const ownerEq =
  source.kind === "kiosk"
    ? eq(schema.pickupOrders.kioskId, source.kioskId)
    : eq(schema.pickupOrders.stationDeviceId, source.stationDeviceId);
```

2. **Kiosk-only behaviour.** `consumeKioskAdmission`, `findKioskRejectionOutcome`
   and everything reading `kioskOrderAdmissions` or `kiosks` stay kiosk-only.
   Guard them with `if (source.kind === "kiosk")` and make them no-ops for a
   handheld. Subscription-expiry admission proofs are explicitly out of v1 for
   the handheld.
3. **Insert.** Spread `sourceColumns(source)` into the `pickup_orders` insert
   instead of setting `kioskId`.

`resolveScanTime(createdAt, kioskId, now)` takes a `string` only to name the
device in a warning: change the parameter to `source: PickupDocumentSource` and
log `sourceLabel(source)`.

In `kiosk.controller.ts`, the single call becomes:

```ts
return this.pickupOrdersService.createForDevice(req.tenantId!, kioskSource(req.kioskId!), body);
```

Leave `apps/api/src/modules/kiosk/pairing.service.ts` reading
`pickupOrders.kioskId` as it is — it counts a kiosk's own orders and that is
still correct.

- [ ] **Step 6: Verify the refactor changed no behaviour**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/kiosk-orders.e2e.test.ts test/pickup-orders.e2e.test.ts test/pickup-conflicts.e2e.test.ts test/subscription-expiry.e2e.test.ts
pnpm --filter @markiro/api typecheck
```

Expected: PASS, with no test edits. If a test needed changing, the refactor
changed behaviour — find out why before continuing.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/pickup-orders/document-source.ts apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/api/src/modules/kiosk/kiosk.controller.ts apps/api/test/pickup-document-source.test.ts
git commit -m "refactor(api): thread a pickup document source instead of a kiosk id"
```

---

### Task 3: The allowlist becomes a resolver

`resolveItems` calls `kioskAllowlist(tenantId, kioskId)` and reports
`not_allowed` for a product that exists but is not listed for that kiosk. A
handheld writes off whatever it finds on the floor, so its allowlist is the
tenant catalog and `not_allowed` becomes unreachable.

**Files:**
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Test: `apps/api/test/pickup-orders.e2e.test.ts`

**Interfaces:**
- Consumes: `PickupDocumentSource` from Task 2.
- Produces: `private async allowlistFor(tenantId: string, source: PickupDocumentSource): Promise<Map<string, { productId: string; unitPrice: string | null }>>` — same map shape `kioskAllowlist` already returns, so `resolveItems` is otherwise untouched.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/pickup-orders.e2e.test.ts`, using the file's existing
tenant/product fixtures:

```ts
it("accepts a catalogue product that no kiosk lists, when the source is a handheld", async () => {
  const result = await service.createForDevice(tenantId, handheldSource(handheldId), {
    deviceSeq: 1,
    operatorId: employeeId,
    reason: "writeoff",
    writeoffReasonId: reasonId,
    items: [{ rawKm: unlistedProductKm }],
    createdAt: new Date().toISOString(),
  });
  expect(result.conflicts).toEqual([]);
  expect(result.itemCount).toBe(1);
});

it("still refuses an unlisted product for a kiosk source", async () => {
  const result = await service.createForDevice(tenantId, kioskSource(kioskId), {
    deviceSeq: 2,
    badgeDigest,
    reason: "buy",
    items: [{ rawKm: unlistedProductKm }],
    createdAt: new Date().toISOString(),
  });
  expect(result.conflicts).toEqual([{ rawKm: unlistedProductKm, reason: "not_allowed" }]);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/pickup-orders.e2e.test.ts -t "no kiosk lists"
```

Expected: FAIL — the handheld case reports `not_allowed`.

- [ ] **Step 3: Add the resolver**

In `pickup-orders.service.ts`:

```ts
  /**
   * Which products this source may put in a document. A kiosk is limited to its
   * own `kiosk_products` listing; a handheld writes off whatever is in the
   * tenant catalogue, because damage on the floor is not scoped to a device.
   */
  private async allowlistFor(tenantId: string, source: PickupDocumentSource) {
    if (source.kind === "kiosk") return this.kioskAllowlist(tenantId, source.kioskId);
    const rows = await this.db
      .select({ gtin14: schema.products.gtin14, productId: schema.products.id })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.archived, false)));
    return new Map(rows.map((r) => [r.gtin14, { productId: r.productId, unitPrice: null }]));
  }
```

The return type is exactly `kioskAllowlist`'s
`Map<string, { productId: string; unitPrice: string | null }>`, so `resolveItems`
needs no other change. Two details are not incidental. `archived: false` mirrors
the join `kioskAllowlist` already makes — an archived product must stop being
admitted into documents on both devices, or the handheld quietly becomes the way
round the rule. And `unitPrice: null` is the price decision: a handheld write-off
carries no prices, so `total_price` stays `NULL`.

Change `resolveItems(tenantId, kioskId, items)` to
`resolveItems(tenantId, source, items)` and have it call
`await this.allowlistFor(tenantId, source)`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @markiro/api exec vitest run test/pickup-orders.e2e.test.ts
```

Expected: PASS, both new cases and every pre-existing one.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/api/test/pickup-orders.e2e.test.ts
git commit -m "feat(api): resolve the pickup allowlist from the document source"
```

---

### Task 4: A write-off stops spending the daily allowance

`applyOrderLineLimit` runs before `reason` is considered, so a kiosk write-off
spends the employee's allowance today. Both halves must change together:
skipping enforcement while still *counting* history would let yesterday's
write-offs eat today's allowance.

**Files:**
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Test: `apps/api/test/pickup-writeoff-limit.test.ts` (create)

**Interfaces:**
- Consumes: `createForDevice` from Task 2.
- Produces: no new exports. Behaviour: when `dto.reason === "writeoff"`,
  `applyOrderLineLimit` is not called and the order is excluded from
  `countTakenToday` and `takenTodayElsewhereByEmployee`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/pickup-writeoff-limit.test.ts`. Seed a tenant with
`limitsEnabled: true` and an employee on `limitMode: "limited", dayLimit: 2`.

```ts
it("does not refuse a write-off that exceeds the daily allowance", async () => {
  const result = await service.createForDevice(tenantId, kioskSource(kioskId), {
    deviceSeq: 1,
    badgeDigest,
    reason: "writeoff",
    writeoffReasonId: reasonId,
    items: [{ rawKm: km1 }, { rawKm: km2 }, { rawKm: km3 }],
    createdAt: new Date().toISOString(),
  });
  expect(result.conflicts).toEqual([]);
  expect(result.itemCount).toBe(3);
});

it("does not let an earlier write-off consume the allowance for a purchase", async () => {
  await service.createForDevice(tenantId, kioskSource(kioskId), {
    deviceSeq: 2,
    badgeDigest,
    reason: "writeoff",
    writeoffReasonId: reasonId,
    items: [{ rawKm: km4 }, { rawKm: km5 }],
    createdAt: new Date().toISOString(),
  });
  const buy = await service.createForDevice(tenantId, kioskSource(kioskId), {
    deviceSeq: 3,
    badgeDigest,
    reason: "buy",
    items: [{ rawKm: km6 }, { rawKm: km7 }],
    createdAt: new Date().toISOString(),
  });
  expect(buy.conflicts).toEqual([]);
  expect(buy.itemCount).toBe(2);
});

it("still enforces the allowance for a purchase", async () => {
  const result = await service.createForDevice(tenantId, kioskSource(kioskId), {
    deviceSeq: 4,
    badgeDigest,
    reason: "buy",
    items: [{ rawKm: km8 }, { rawKm: km9 }, { rawKm: km10 }],
    createdAt: new Date().toISOString(),
  });
  expect(result.conflicts).toContainEqual({ rawKm: km10, reason: "over_limit" });
  expect(result.itemCount).toBe(2);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/pickup-writeoff-limit.test.ts
```

Expected: FAIL on the first two cases with `over_limit` conflicts.

- [ ] **Step 3: Skip enforcement for a write-off**

At the `applyOrderLineLimit` call site, make the limit conditional. The
`limited: false` shape keeps one code path rather than branching the whole
block:

```ts
          const isWriteoff = dto.reason === "writeoff";
          const existingCount = isWriteoff
            ? 0
            : await this.countTakenToday(tx, tenantId, employeeId, when);
          const limited = applyOrderLineLimit({
            existingCount,
            dayLimit: policy.dayLimit,
            limited: policy.limited && !isWriteoff,
            loose: uniqueLoose,
            boxes: boxDedup.accepted,
            looseConflict: (item) => ({ rawKm: item.rawKm, reason: "over_limit" }),
          });
```

- [ ] **Step 4: Stop counting write-offs as spent allowance**

In `countTakenToday` and `takenTodayElsewhereByEmployee`, add the same predicate
to each `where`, beside the existing non-voided / non-cancelled / UTC-day ones:

```ts
ne(schema.pickupOrders.reason, "writeoff"),
```

Import `ne` from `drizzle-orm` if it is not already imported. The two predicate
sets are deliberately identical — the file's own comment on
`takenTodayElsewhereByEmployee` says so, and letting them drift is how a device
plans against one rule while the server enforces another.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @markiro/api exec vitest run test/pickup-writeoff-limit.test.ts test/kiosk-bootstrap-day-count.e2e.test.ts test/kiosk-orders.e2e.test.ts
```

Expected: PASS. `kiosk-bootstrap-day-count.e2e.test.ts` is included because the
bootstrap's `takenTodayElsewhere` field is computed by the second function you
just changed; if it fails, its fixture assumed write-offs counted.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/api/test/pickup-writeoff-limit.test.ts
git commit -m "fix(api): a write-off no longer spends an employee's daily allowance"
```

---

### Task 5: `POST /station/writeoffs`

**Files:**
- Create: `apps/api/src/modules/station-writeoffs/dto.ts`
- Create: `apps/api/src/modules/station-writeoffs/station-writeoffs.service.ts`
- Create: `apps/api/src/modules/station-writeoffs/station-writeoffs.controller.ts`
- Create: `apps/api/src/modules/station-writeoffs/station-writeoffs.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/station-writeoffs.e2e.test.ts`

**Interfaces:**
- Consumes: `createForDevice`, `handheldSource`, the allowlist resolver, the
  limit carve-out.
- Produces:
  - `POST /station/writeoffs` returning the existing `CreateOrderResultDto`, so
    the device reuses the kiosk's outcome shape.
  - `PickupActor` and `CreatePickupDocumentInput` (Step 4b), which change
    `createForDevice`'s fourth-parameter shape from `CreateOrderDto` to
    `CreatePickupDocumentInput`. Task 2 introduced that signature; this task is
    where its `dto` widens. Any later plan calling `createForDevice` must pass
    an `actor`.

- [ ] **Step 1: Write the failing e2e test**

Create `apps/api/test/station-writeoffs.e2e.test.ts`. Use
`apps/api/test/support/auth.ts` for a paired station device of kind `handheld`,
following `station-shift-close`'s e2e file for the request harness.

```ts
it("files a write-off and is idempotent on a replayed device sequence", async () => {
  const body = {
    deviceSeq: 1,
    operatorId: employeeId,
    writeoffReasonId: reasonId,
    items: [{ rawKm: km1 }],
    createdAt: new Date().toISOString(),
  };
  const first = await post("/station/writeoffs", body, handheldToken);
  expect(first.status).toBe(201);
  expect(first.body.itemCount).toBe(1);

  const replay = await post("/station/writeoffs", body, handheldToken);
  expect(replay.status).toBe(201);
  expect(replay.body.orderNo).toBe(first.body.orderNo);

  const rows = await db
    .select()
    .from(schema.pickupOrders)
    .where(eq(schema.pickupOrders.tenantId, tenantId));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.sourceKind).toBe("handheld");
  expect(rows[0]?.kioskId).toBeNull();
  expect(rows[0]?.totalPrice).toBeNull();
  expect(rows[0]?.reason).toBe("writeoff");
});

it("refuses an operator without can_writeoff, even though the device asserted them", async () => {
  const res = await post(
    "/station/writeoffs",
    {
      deviceSeq: 2,
      operatorId: employeeWithoutWriteoffId,
      writeoffReasonId: reasonId,
      items: [{ rawKm: km2 }],
      createdAt: new Date().toISOString(),
    },
    handheldToken,
  );
  expect(res.status).toBe(403);
});

it("refuses an operator belonging to another tenant", async () => {
  const res = await post(
    "/station/writeoffs",
    {
      deviceSeq: 3,
      operatorId: otherTenantEmployeeId,
      writeoffReasonId: reasonId,
      items: [{ rawKm: km3 }],
      createdAt: new Date().toISOString(),
    },
    handheldToken,
  );
  expect(res.status).toBe(403);
});

it("refuses a reason belonging to another tenant", async () => {
  const res = await post(
    "/station/writeoffs",
    {
      deviceSeq: 4,
      operatorId: employeeId,
      writeoffReasonId: otherTenantReasonId,
      items: [{ rawKm: km4 }],
      createdAt: new Date().toISOString(),
    },
    handheldToken,
  );
  expect(res.status).toBe(422);
});

it("reports partial acceptance without failing the request", async () => {
  await post(
    "/station/writeoffs",
    { deviceSeq: 5, operatorId: employeeId, writeoffReasonId: reasonId, items: [{ rawKm: km5 }], createdAt: new Date().toISOString() },
    handheldToken,
  );
  const res = await post(
    "/station/writeoffs",
    { deviceSeq: 6, operatorId: employeeId, writeoffReasonId: reasonId, items: [{ rawKm: km5 }, { rawKm: km6 }], createdAt: new Date().toISOString() },
    handheldToken,
  );
  expect(res.status).toBe(201);
  expect(res.body.itemCount).toBe(1);
  expect(res.body.conflicts).toEqual([{ rawKm: km5, reason: "duplicate" }]);
});

it("rejects a kiosk token on the station route", async () => {
  const res = await post("/station/writeoffs", { deviceSeq: 7, operatorId: employeeId, writeoffReasonId: reasonId, items: [{ rawKm: km7 }], createdAt: new Date().toISOString() }, kioskToken);
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/station-writeoffs.e2e.test.ts
```

Expected: FAIL with 404 on every case — the route does not exist.

- [ ] **Step 3: Write the DTO**

Create `apps/api/src/modules/station-writeoffs/dto.ts`:

```ts
import type { SchemaObject } from "@nestjs/swagger";
import { z } from "zod";

/**
 * A handheld write-off. Deliberately NOT the kiosk's `createOrderSchema`: there
 * is no badge identity (the operator is asserted by the signed-in device), no
 * price, and no `reason` field at all — this route can only produce a write-off.
 */
export const stationWriteoffSchema = z
  .object({
    deviceSeq: z.number().int().nonnegative(),
    operatorId: z.string().uuid().toLowerCase(),
    writeoffReasonId: z.string().uuid().toLowerCase(),
    items: z.array(z.object({ rawKm: z.string().min(1) })).default([]),
    boxes: z.array(z.object({ sscc: z.string().length(18) })).default([]),
    createdAt: z.string().datetime(),
  })
  .refine((v) => v.items.length + v.boxes.length > 0, "At least one item or box is required")
  .refine(
    (v) => new Set(v.boxes.map((b) => b.sscc)).size === v.boxes.length,
    "Box SSCC values must be unique",
  );
export type StationWriteoffDto = z.infer<typeof stationWriteoffSchema>;

export const stationWriteoffOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["deviceSeq", "operatorId", "writeoffReasonId", "createdAt"],
  properties: {
    deviceSeq: { type: "integer", minimum: 0 },
    operatorId: { type: "string", format: "uuid" },
    writeoffReasonId: { type: "string", format: "uuid" },
    items: {
      type: "array",
      items: { type: "object", required: ["rawKm"], properties: { rawKm: { type: "string" } } },
    },
    boxes: {
      type: "array",
      items: { type: "object", required: ["sscc"], properties: { sscc: { type: "string" } } },
    },
    createdAt: { type: "string", format: "date-time" },
  },
};
```

- [ ] **Step 4: Write the service**

Create `apps/api/src/modules/station-writeoffs/station-writeoffs.service.ts`:

```ts
import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DB, schema, type Db } from "@markiro/db";
import { handheldSource } from "../pickup-orders/document-source";
import { PickupOrdersService } from "../pickup-orders/pickup-orders.service";
import type { CreateOrderResultDto } from "../pickup-orders/dto";
import type { StationWriteoffDto } from "./dto";

@Injectable()
export class StationWriteoffsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly pickupOrders: PickupOrdersService,
  ) {}

  /**
   * The device asserts `operatorId` the way `station-scans` does, so the
   * permission is re-decided here against live data. A client-side check is an
   * affordance; this is the gate.
   */
  private async assertCanWriteoff(tenantId: string, operatorId: string): Promise<void> {
    const rows = await this.db
      .select({ canWriteoff: schema.employeePickupPolicies.canWriteoff })
      .from(schema.employeePickupPolicies)
      .innerJoin(
        schema.employees,
        and(
          eq(schema.employees.tenantId, schema.employeePickupPolicies.tenantId),
          eq(schema.employees.id, schema.employeePickupPolicies.employeeId),
        ),
      )
      .where(
        and(
          eq(schema.employeePickupPolicies.tenantId, tenantId),
          eq(schema.employeePickupPolicies.employeeId, operatorId),
          eq(schema.employees.status, "active"),
        ),
      );
    if (rows[0]?.canWriteoff !== true) {
      throw new ForbiddenException("Operator may not write off");
    }
  }

  async create(
    tenantId: string,
    stationDeviceId: string,
    dto: StationWriteoffDto,
  ): Promise<CreateOrderResultDto> {
    await this.assertCanWriteoff(tenantId, dto.operatorId);
    return this.pickupOrders.createForDevice(tenantId, handheldSource(stationDeviceId), {
      deviceSeq: dto.deviceSeq,
      operatorId: dto.operatorId,
      reason: "writeoff",
      writeoffReasonId: dto.writeoffReasonId,
      items: dto.items,
      boxes: dto.boxes,
      createdAt: dto.createdAt,
    });
  }
}
```

The cross-tenant operator case returns 403 from `assertCanWriteoff` because the
policy row is selected with `tenantId` in the predicate: another tenant's
employee simply has no row here. A reason from another tenant is rejected deeper,
by the existing reason validation in `createForDevice`, which already answers 422.

- [ ] **Step 4b: Teach `createForDevice` a non-badge identity**

`createOrderSchema` refines with `hasExactlyOneBadgeIdentity`, so `CreateOrderDto`
cannot express "the signed-in operator". Do not relax that refine — it guards the
kiosk against persisting a plaintext badge beside its digest. Instead widen the
*service* input, which was never the wire DTO:

```ts
/** How a document names the person it belongs to. */
export type PickupActor =
  | { kind: "badge"; badgeDigest?: string; badgeCode?: string }
  | { kind: "operator"; operatorId: string };

export type CreatePickupDocumentInput = Omit<
  CreateOrderDto,
  "badgeDigest" | "badgeCode"
> & { actor: PickupActor };
```

In `createForDevice`, replace step 2 of its algorithm (badge → active employee)
with a branch that keeps the badge path byte-for-byte as it is and adds:

```ts
  private async resolveActor(tenantId: string, actor: PickupActor, tx: Tx): Promise<string> {
    if (actor.kind === "badge") return this.resolveBadgeEmployee(tenantId, actor, tx);
    const rows = await tx
      .select({ id: schema.employees.id })
      .from(schema.employees)
      .where(
        and(
          eq(schema.employees.tenantId, tenantId),
          eq(schema.employees.id, actor.operatorId),
          eq(schema.employees.status, "active"),
        ),
      );
    const id = rows[0]?.id;
    if (!id) throw new UnprocessableEntityException("Unknown operator");
    return id;
  }
```

`kiosk.controller.ts` now passes `actor: { kind: "badge", ... }` and the station
service passes `actor: { kind: "operator", operatorId: dto.operatorId }`. The
tenant predicate is what makes the cross-tenant operator unreachable here too,
so the 403 in `assertCanWriteoff` and this 422 are two independent gates on the
same claim — keep both.

Re-run the kiosk suites after this change; they must still pass untouched:

```bash
pnpm --filter @markiro/api exec vitest run test/kiosk-orders.e2e.test.ts test/pickup-orders.e2e.test.ts
```

- [ ] **Step 5: Write the controller and module**

Create `apps/api/src/modules/station-writeoffs/station-writeoffs.controller.ts`:

```ts
import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBody, ApiCreatedResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { ApiHttpErrors, ApiStationAuth, ApiZodValidationError } from "../../lib/openapi";
import { AllowStationOrPermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { createOrderResultOpenApiSchema } from "../pickup-orders/dto";
import type { CreateOrderResultDto } from "../pickup-orders/dto";
import { stationWriteoffOpenApiSchema, stationWriteoffSchema, type StationWriteoffDto } from "./dto";
import { StationWriteoffsService } from "./station-writeoffs.service";

@ApiTags("station-writeoffs")
@Controller()
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class StationWriteoffsController {
  constructor(private readonly service: StationWriteoffsService) {}

  @Post("station/writeoffs")
  @UseGuards(StationOnlyGuard)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "File a write-off from a handheld",
    description:
      "Idempotent on (device, deviceSeq): a replayed sync returns the original document instead of filing a second act. The operator asserted in the body is re-checked against `can_writeoff` server-side.",
  })
  @ApiStationAuth()
  @ApiBody({ schema: stationWriteoffOpenApiSchema })
  @ApiCreatedResponse({ schema: createOrderResultOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 422, 429)
  create(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(stationWriteoffSchema)) body: StationWriteoffDto,
  ): Promise<CreateOrderResultDto> {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.service.create(req.tenantId!, req.deviceId, body);
  }
}
```

The station device id is `req.deviceId` — not `stationDeviceId` — and it is
typed optional, so the explicit throw above matches what
`station-shift-close.controller.ts` does rather than reaching for a non-null
assertion the lint rules forbid.

Create `station-writeoffs.module.ts` importing the module that provides
`PickupOrdersService`, and register it in `app.module.ts` beside the other
`Station*` modules.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @markiro/api exec vitest run test/station-writeoffs.e2e.test.ts
pnpm --filter @markiro/api exec vitest run test/openapi-docs.test.ts test/authorization.e2e.test.ts
```

Expected: PASS. The latter two guard the OpenAPI document and the route access
matrix, both of which a new route changes.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/station-writeoffs apps/api/src/app.module.ts apps/api/test/station-writeoffs.e2e.test.ts
git commit -m "feat(api): add POST /station/writeoffs for the handheld"
```

---

### Task 6: `GET /station/writeoff-bootstrap`

Everything the device needs to run the mode offline: the reason dictionary, the
tenant catalogue as GTIN → name, and which operators may write off.

**Files:**
- Modify: `apps/api/src/modules/station-writeoffs/dto.ts`
- Modify: `apps/api/src/modules/station-writeoffs/station-writeoffs.service.ts`
- Modify: `apps/api/src/modules/station-writeoffs/station-writeoffs.controller.ts`
- Test: `apps/api/test/station-writeoffs.e2e.test.ts`

**Interfaces:**
- Produces:

```ts
interface StationWriteoffBootstrapDto {
  generatedAt: string;
  reasons: { id: string; name: string; sortOrder: number }[];
  products: { gtin14: string; name: string }[];
  operators: { employeeId: string; canWriteoff: boolean }[];
}
```

`generatedAt` is server time and feeds the device's «данные на 10:42» stamp, the
same contract the kiosk bootstrap already sets.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/station-writeoffs.e2e.test.ts`:

```ts
it("returns reasons, catalogue and operator permissions for this tenant only", async () => {
  const res = await get("/station/writeoff-bootstrap", handheldToken);
  expect(res.status).toBe(200);
  expect(typeof res.body.generatedAt).toBe("string");
  expect(res.body.reasons.map((r: { id: string }) => r.id)).toContain(reasonId);
  expect(res.body.reasons.map((r: { id: string }) => r.id)).not.toContain(otherTenantReasonId);
  expect(res.body.products.map((p: { gtin14: string }) => p.gtin14)).toContain(productGtin);
  expect(res.body.operators).toContainEqual({ employeeId, canWriteoff: true });
  expect(res.body.operators).toContainEqual({
    employeeId: employeeWithoutWriteoffId,
    canWriteoff: false,
  });
});

it("omits archived reasons", async () => {
  const res = await get("/station/writeoff-bootstrap", handheldToken);
  expect(res.body.reasons.map((r: { id: string }) => r.id)).not.toContain(archivedReasonId);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/station-writeoffs.e2e.test.ts -t "bootstrap"
```

Expected: FAIL with 404.

- [ ] **Step 3: Implement the bootstrap**

Add to `StationWriteoffsService`:

```ts
  async bootstrap(tenantId: string): Promise<StationWriteoffBootstrapDto> {
    const [reasons, products, operators] = await Promise.all([
      this.db
        .select({
          id: schema.pickupOrderReasons.id,
          name: schema.pickupOrderReasons.name,
          sortOrder: schema.pickupOrderReasons.sortOrder,
        })
        .from(schema.pickupOrderReasons)
        .where(
          and(
            eq(schema.pickupOrderReasons.tenantId, tenantId),
            eq(schema.pickupOrderReasons.archived, false),
          ),
        )
        .orderBy(schema.pickupOrderReasons.sortOrder),
      this.db
        .select({ gtin14: schema.products.gtin14, name: schema.products.name })
        .from(schema.products)
        .where(eq(schema.products.tenantId, tenantId)),
      this.db
        .select({
          employeeId: schema.employeePickupPolicies.employeeId,
          canWriteoff: schema.employeePickupPolicies.canWriteoff,
        })
        .from(schema.employeePickupPolicies)
        .where(eq(schema.employeePickupPolicies.tenantId, tenantId)),
    ]);
    return { generatedAt: new Date().toISOString(), reasons, products, operators };
  }
```

Add the matching `@Get("station/writeoff-bootstrap")` handler to the controller
with the same guard stack as Task 5 but `@AllowSubscriptionReadOnly("read")` and
no `@RequireSubscriptionWrite()` — reading the dictionary must keep working while
a subscription is read-only.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @markiro/api exec vitest run test/station-writeoffs.e2e.test.ts test/openapi-docs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/station-writeoffs apps/api/test/station-writeoffs.e2e.test.ts
git commit -m "feat(api): add the handheld write-off bootstrap"
```

---

### Task 7: `GET /station/box-registry`

The device writes off whole boxes, so it needs the closed-box registry the kiosk
already mirrors. `BoxRegistryService` is already revision-bounded and
cursor-paged; only the route and its guard are new.

**Files:**
- Modify: `apps/api/src/modules/station-writeoffs/station-writeoffs.controller.ts`
- Test: `apps/api/test/station-writeoffs.e2e.test.ts`

**Interfaces:**
- Consumes: `BoxRegistryService`, `boxRegistryQuerySchema`,
  `KioskBoxRegistryPage` from `apps/api/src/modules/kiosk/box-registry.*`.
- Produces: `GET /station/box-registry` with the same query contract and page
  shape the kiosk route serves.

- [ ] **Step 1: Write the failing test**

```ts
it("serves the box registry to a handheld with the kiosk's page shape", async () => {
  const res = await get("/station/box-registry", handheldToken);
  expect(res.status).toBe(200);
  expect(res.body.revision).toEqual(expect.any(String));
  expect(res.body.items.map((b: { sscc: string }) => b.sscc)).toContain(closedBoxSscc);
});

it("does not serve another tenant's boxes", async () => {
  const res = await get("/station/box-registry", handheldToken);
  expect(res.body.items.map((b: { sscc: string }) => b.sscc)).not.toContain(otherTenantBoxSscc);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/station-writeoffs.e2e.test.ts -t "box registry"
```

Expected: FAIL with 404.

- [ ] **Step 3: Add the route**

Read `kiosk.controller.ts`'s `box-registry` handler and mirror its `@ApiQuery`
decorators exactly — `since`, `until`, `cursor` — so the two routes cannot drift.
The handler body delegates unchanged:

```ts
  @Get("station/box-registry")
  @UseGuards(StationOnlyGuard)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Sync the handheld box registry",
    description:
      "Revision-bounded, cursor-paged snapshot or delta of the tenant's closed-box registry. Same contract as the kiosk route.",
  })
  @ApiStationAuth()
  @ApiHttpErrors(401, 403, 429)
  boxRegistry(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(boxRegistryQuerySchema)) query: BoxRegistryQueryDto,
  ): Promise<KioskBoxRegistryPage> {
    return this.boxRegistryService.list(req.tenantId!, query);
  }
```

The method is `BoxRegistryService.list(tenantId, query)` and it takes no kiosk
id at all — the registry was already tenant-scoped rather than kiosk-scoped, so
nothing about it needs changing to serve a handheld. Provide `BoxRegistryService`
to `StationWriteoffsModule`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @markiro/api exec vitest run test/station-writeoffs.e2e.test.ts test/kiosk-box-registry.e2e.test.ts test/openapi-docs.test.ts
```

Expected: PASS, including the kiosk's own registry suite — the shared service
must not have changed behaviour.

- [ ] **Step 5: Run the full API gates**

```bash
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
pnpm format:check
```

Expected: PASS. Report any suite that skipped for want of `DATABASE_URL` rather
than counting it as covered.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/station-writeoffs apps/api/test/station-writeoffs.e2e.test.ts
git commit -m "feat(api): serve the box registry to handhelds"
```

---

## Done when

- A paired handheld can file a write-off that lands as one `pickup_orders` row
  with `source_kind='handheld'`, `kiosk_id IS NULL`, `total_price IS NULL` and
  `reason='writeoff'`.
- Replaying the same `deviceSeq` returns the original document rather than
  filing a second act.
- An operator without `can_writeoff` is refused by the server even when the
  device claims otherwise.
- A write-off neither spends nor counts against a daily allowance, on either
  device.
- Every pre-existing kiosk suite passes unchanged.

## Not in this plan

Cabinet display of the new source (plan 2), the handheld app itself (plan 3),
limits-off-by-default (plan 0). Also out of scope per the spec: an admission-proof
equivalent for expired subscriptions, Chestny ZNAK withdrawal reporting,
cancelling a write-off from the device, and pallets.

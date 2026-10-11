import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import type { PlatformReportInput } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformReportSourceService } from "../src/platform-reports/report-source.service";
import { USAGE_COLUMNS } from "../src/platform-reports/usage-report-source";
import {
  cleanupEvidence,
  seedEvidenceBase,
  type EvidenceBase,
} from "./support/platform-report-evidence-base";
import { seedReportInventory } from "./support/platform-report-inventory-fixture";

const url = process.env.DATABASE_URL;
const local = url ? ["localhost", "127.0.0.1"].includes(new URL(url).hostname) : false;

describe.skipIf(!local)("usage report projection on real Postgres", () => {
  const { db, pool } = createDb(url ?? "postgres://localhost:55439/unavailable");
  const service = new PlatformReportSourceService(db);
  let base: EvidenceBase;
  let input: PlatformReportInput;

  beforeAll(async () => {
    base = await seedEvidenceBase(db);
    input = {
      reportType: "usage",
      tenantIds: [base.tenant],
      fromDate: "2026-09-01",
      toDate: "2026-09-02",
      timezone: "Europe/Moscow",
      periodBasis: "events",
      privacy: "identified",
    };
    const scan = (
      shiftId: string,
      at: string,
      options: {
        verdict?: string;
        terminal?: string;
        operator?: string;
        tenant?: string;
      } = {},
    ) => ({
      tenantId: options.tenant ?? base.tenant,
      shiftId,
      terminalId: options.terminal ?? null,
      operatorId: options.operator ?? null,
      raw: "raw-scan-secret",
      verdict: options.verdict ?? "ok",
      scannedAt: new Date(at),
    });
    // Moscow day 2026-09-01 is [2026-08-31T21:00Z, 2026-09-01T21:00Z).
    await db.insert(schema.scanEvents).values([
      scan(base.shiftOne, "2026-09-01T09:00:00Z", { terminal: "t-1", operator: base.operatorOne }),
      scan(base.shiftOne, "2026-09-01T09:05:00Z", { terminal: "t-1", operator: base.operatorOne }),
      scan(base.shiftOne, "2026-09-01T10:00:00Z", {
        verdict: "duplicate",
        terminal: "t-9",
        operator: base.operatorOne,
      }),
      scan(base.shiftTwo, "2026-09-01T12:00:00Z", { terminal: "t-2", operator: base.operatorTwo }),
      // One second before the window opens: local day 2026-08-31, not selected.
      scan(base.shiftOne, "2026-08-31T20:59:59Z", { terminal: "t-1", operator: base.operatorOne }),
      // Exactly local midnight of 2026-09-02.
      scan(base.shiftOne, "2026-09-01T21:00:00Z", { terminal: "t-1", operator: base.operatorOne }),
      scan(base.otherShift, "2026-09-01T10:00:00Z", { tenant: base.other, terminal: "b-1" }),
    ]);
    let boxNumber = 0;
    const box = (
      values: Partial<typeof schema.boxes.$inferInsert> & { shiftId: string },
    ): typeof schema.boxes.$inferInsert => ({
      tenantId: base.tenant,
      deviceBoxId: `box-${++boxNumber}`,
      openedAt: new Date("2026-08-20T00:00:00Z"),
      ...values,
    });
    await db.insert(schema.boxes).values([
      box({
        shiftId: base.shiftOne,
        terminalId: "t-1",
        operatorId: base.operatorOne,
        closedAt: new Date("2026-09-01T08:00:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:30:00Z"),
        sscc: "000000000000000001",
        printVerifiedAt: new Date("2026-09-01T09:00:00Z"),
      }),
      box({
        shiftId: base.shiftOne,
        terminalId: "t-3",
        operatorId: null,
        closedAt: new Date("2026-09-01T10:30:00Z"),
        closureReceivedAt: new Date("2026-09-01T11:00:00Z"),
      }),
      // Closed on the device on day one, received by the server on day two: counts on day two.
      box({
        shiftId: base.shiftTwo,
        terminalId: "t-2",
        operatorId: base.operatorTwo,
        closedAt: new Date("2026-09-01T20:00:00Z"),
        closureReceivedAt: new Date("2026-09-02T05:00:00Z"),
        printVerifiedAt: new Date("2026-09-02T22:00:00Z"),
      }),
    ]);
    await db.insert(schema.pallets).values([
      {
        tenantId: base.tenant,
        shiftId: base.shiftOne,
        kind: "production",
        devicePalletId: "pp-1",
        terminalId: "t-1",
        closedAt: new Date("2026-09-01T12:50:00Z"),
        closureReceivedAt: new Date("2026-09-01T13:00:00Z"),
      },
      // Still open: no closure yet.
      {
        tenantId: base.tenant,
        shiftId: base.shiftOne,
        kind: "production",
        devicePalletId: "pp-2",
        terminalId: "t-1",
      },
      {
        tenantId: base.tenant,
        shiftId: null,
        kind: "warehouse",
        productId: base.product,
        deviceId: base.stationDevice,
        terminalId: base.stationDevice,
        devicePalletId: "wp-1",
        closedAt: new Date("2026-09-02T09:50:00Z"),
        closureReceivedAt: new Date("2026-09-02T10:00:00Z"),
      },
    ]);
    await db.insert(schema.pickupOrders).values([
      {
        tenantId: base.tenant,
        orderNo: "ord-1",
        sourceKind: "kiosk",
        kioskId: base.kiosk,
        employeeId: base.operatorOne,
        reason: "buy",
        status: "pending",
        itemCount: 2,
        createdAt: new Date("2026-09-01T12:00:00Z"),
      },
      {
        tenantId: base.tenant,
        orderNo: "ord-2",
        sourceKind: "kiosk",
        kioskId: base.kiosk,
        employeeId: base.operatorOne,
        reason: "buy",
        status: "punched",
        itemCount: 3,
        createdAt: new Date("2026-09-01T13:00:00Z"),
      },
      {
        tenantId: base.tenant,
        orderNo: "ord-3",
        sourceKind: "handheld",
        stationDeviceId: base.handheldDevice,
        employeeId: base.operatorOne,
        reason: "writeoff",
        status: "writtenoff",
        itemCount: 4,
        createdAt: new Date("2026-09-01T14:00:00Z"),
      },
      {
        tenantId: base.tenant,
        orderNo: "ord-4",
        sourceKind: "kiosk",
        kioskId: base.kiosk,
        employeeId: base.operatorOne,
        reason: "buy",
        status: "cancelled",
        itemCount: 9,
        createdAt: new Date("2026-09-01T15:00:00Z"),
      },
      {
        tenantId: base.tenant,
        orderNo: "ord-5",
        sourceKind: "handheld",
        stationDeviceId: base.handheldDevice,
        employeeId: base.operatorOne,
        reason: "writeoff",
        status: "pending",
        itemCount: 1,
        createdAt: new Date("2026-09-02T10:00:00Z"),
      },
    ]);
    await db.insert(schema.products).values({
      id: randomUUID(),
      tenantId: base.tenant,
      name: "Added product",
      gtin14: "00012345678902",
      createdAt: new Date("2026-09-01T07:00:00Z"),
    });
    // Completed on 2026-09-01T10:00Z.
    await seedReportInventory(db, {
      tenant: base.tenant,
      product: base.product,
      line: base.lineOne,
      operator: base.operatorOne,
      user: base.user,
    });
  });

  afterAll(async () => {
    await cleanupEvidence(db, [base.tenant, base.other], { users: [base.user] });
    await pool.end();
  });

  it("aggregates each tenant-day from independent fact families without multiplication", async () => {
    const result = await service.load(input);
    expect(result.columns).toEqual([...USAGE_COLUMNS]);
    expect(result.rows).toEqual([
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-09-01",
        shifts_active: 2,
        active_lines: 2,
        active_devices: 3,
        active_operators: 2,
        accepted_units: 3,
        boxes_closed: 2,
        sscc_boxes: 1,
        print_confirmed_boxes: 1,
        production_pallets_closed: 1,
        warehouse_pallets_closed: 0,
        pickup_orders_buy: 2,
        pickup_orders_writeoff: 1,
        pickup_orders_kiosk: 2,
        pickup_orders_handheld: 1,
        pickup_items_buy: 5,
        pickup_items_writeoff: 4,
        inventories_completed: 1,
        gtins_added: 1,
      },
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-09-02",
        shifts_active: 2,
        active_lines: 2,
        active_devices: 2,
        active_operators: 2,
        accepted_units: 1,
        boxes_closed: 1,
        sscc_boxes: 0,
        print_confirmed_boxes: 0,
        production_pallets_closed: 0,
        warehouse_pallets_closed: 1,
        pickup_orders_buy: 0,
        pickup_orders_writeoff: 1,
        pickup_orders_kiosk: 0,
        pickup_orders_handheld: 1,
        pickup_items_buy: 0,
        pickup_items_writeoff: 1,
        inventories_completed: 0,
        gtins_added: 0,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("raw-scan-secret");
  });

  it("never mixes tenants and reports a selected foreign tenant by its own name", async () => {
    const both = await service.load({ ...input, tenantIds: [base.tenant, base.other] });
    expect(both.rows.filter((row) => row.tenant_id === base.tenant)).toHaveLength(2);
    expect(both.rows.filter((row) => row.tenant_id === base.other)).toEqual([
      expect.objectContaining({
        tenant_name: "Evidence fixture B",
        day: "2026-09-01",
        shifts_active: 1,
        active_lines: 1,
        active_devices: 1,
        active_operators: 0,
        accepted_units: 1,
        boxes_closed: 0,
      }),
    ]);
    const only = await service.load(input);
    expect(only.rows.every((row) => row.tenant_id === base.tenant)).toBe(true);
  });

  it("follows the local day of a DST-observing timezone", async () => {
    // America/New_York leaves DST on 2026-11-01, so that local day lasts 25 hours:
    // [2026-11-01T04:00Z, 2026-11-02T05:00Z).
    const scan = (at: string) => ({
      tenantId: base.tenant,
      shiftId: base.shiftOne,
      terminalId: "ny-1",
      operatorId: null,
      raw: "raw-scan-secret",
      verdict: "ok",
      scannedAt: new Date(at),
    });
    await db
      .insert(schema.scanEvents)
      .values([
        scan("2026-11-01T03:59:00Z"),
        scan("2026-11-01T04:00:00Z"),
        scan("2026-11-02T04:59:00Z"),
        scan("2026-11-02T05:00:00Z"),
      ]);
    const result = await service.load({
      ...input,
      fromDate: "2026-11-01",
      toDate: "2026-11-01",
      timezone: "America/New_York",
    });
    expect(result.rows).toEqual([
      expect.objectContaining({ day: "2026-11-01", accepted_units: 2, active_devices: 1 }),
    ]);
  });

  it("pseudonymous output carries labels and aggregate output is the manual sum over tenants", async () => {
    const both = { ...input, tenantIds: [base.tenant, base.other] };
    const pseudonymous = await service.load({ ...both, privacy: "pseudonymous" });
    expect(new Set(pseudonymous.rows.map((row) => row.tenant_id))).toEqual(
      new Set(["tenant-01", "tenant-02"]),
    );
    expect(JSON.stringify(pseudonymous)).not.toContain(base.tenant);
    expect(JSON.stringify(pseudonymous)).not.toContain("Evidence fixture");

    const aggregate = await service.load({ ...both, privacy: "aggregate" });
    expect(aggregate.columns).not.toContain("tenant_id");
    expect(aggregate.columns).not.toContain("tenant_name");
    expect(aggregate.rows[0]).toMatchObject({
      day: "2026-09-01",
      accepted_units: 4,
      shifts_active: 3,
      active_lines: 3,
      active_devices: 4,
      active_operators: 2,
      boxes_closed: 2,
    });
    expect(JSON.stringify(aggregate)).not.toContain(base.other);
  });
});

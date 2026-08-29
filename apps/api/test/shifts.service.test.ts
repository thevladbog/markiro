import { ConflictException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@markiro/db";
import { ShiftsService } from "../src/modules/shifts/shifts.service";
import type { OperatorsService } from "../src/modules/operators/operators.service";
import type { SsccService } from "../src/modules/sscc/sscc.service";
import type { EntitlementsService } from "../src/subscriptions/entitlements.service";

/**
 * A chainable stub covering both shapes `ShiftsService.getBundle` needs:
 * `select().from(table).leftJoin(...).leftJoin(...).where()` (getShift's
 * joined query) and the plain `select().from(table).where()` (findProductRow,
 * and the label-template/counterparty lookups this test never reaches).
 * `leftJoin`/`where`'s arguments are real drizzle `eq`/`and` SQL fragments --
 * ignored here, since which row comes back depends only on which TABLE
 * `.from()` was called with, not on the condition.
 */
function chain(rows: unknown[], table: unknown, lockedTables: unknown[]) {
  const result = Promise.resolve(rows);
  const node: {
    innerJoin: () => typeof node;
    leftJoin: () => typeof node;
    where: () => typeof node;
    limit: () => Promise<unknown[]>;
    for: (mode: string) => Promise<unknown[]>;
    then: typeof result.then;
  } = {
    innerJoin: () => node,
    leftJoin: () => node,
    where: () => node,
    limit: async () => rows,
    for: async (mode) => {
      if (mode === "update") lockedTables.push(table);
      return rows;
    },
    then: result.then.bind(result),
  };
  return node;
}

function fakeDb(rowsByTable: Map<unknown, unknown[]>): { db: Db; lockedTables: unknown[] } {
  const lockedTables: unknown[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => chain(rowsByTable.get(table) ?? [], table, lockedTables),
    }),
    transaction: async (run: (tx: Db) => Promise<unknown>) => run(db as unknown as Db),
  } as unknown as Db;
  return { db, lockedTables };
}

function fakeOperatorsService(): OperatorsService {
  return { buildRoster: async () => [] } as unknown as OperatorsService;
}

const SHIFT_ROW: typeof schema.shifts.$inferSelect = {
  id: "shift-1",
  tenantId: "tenant-1",
  status: "active",
  mode: "aggregation",
  productId: "product-1",
  lineId: null,
  counterpartyId: null,
  labelTemplateId: null,
  ssccIssuerCounterpartyId: null,
  boxLabelTemplateId: null,
  plannedQty: null,
  plannedDate: null,
  productionDate: null,
  firstBoxClosureAt: null,
  boxCapacity: 10,
  palletCapacity: null,
  palletsEnabled: false,
  createdFrom: "admin",
  numberMonthKey: "AUG26",
  numberSeq: 1,
  stationClosePolicy: "single_device",
  stationCloseOwnerDeviceId: null,
  openedAt: null,
  closedAt: null,
  closeReason: null,
  lateDataAt: null,
  createdAt: new Date(),
};

const PRODUCT_ROW = {
  id: "product-1",
  tenantId: "tenant-1",
  gtin14: "00000000000000",
  name: "Widget",
  chzProductGroupCode: null,
  productGroupName: null,
  boxCapacity: 10,
  palletCapacity: null,
  status: "active",
  defaultCounterpartyId: null,
  defaultLabelTemplateId: null,
  unitPrice: null,
  egaisCode: null,
  externalRef: null,
  createdAt: new Date(),
};

describe("ShiftsService.getBundle's bundleSscc degrade path (Task 7 correction)", () => {
  it("propagates a non-BadRequestException error from resolveIssuerPrefix instead of degrading to sscc: null", async () => {
    const { db, lockedTables } = fakeDb(
      new Map<unknown, unknown[]>([
        [schema.shifts, [SHIFT_ROW]],
        [schema.products, [PRODUCT_ROW]],
      ]),
    );
    // A plain Error, deliberately NOT a BadRequestException: the bundle's
    // degrade path (apps/api/src/modules/shifts/shifts.service.ts's
    // `bundleSscc`) exists to swallow the ONE expected case (a tenant with
    // no org GLN) without silently swallowing everything else too. A real
    // outage here (SsccService/DB down, a bug) must come out of getBundle
    // as a genuine error, not disguise itself as "this tenant just hasn't
    // configured GLNs yet" (sscc: null).
    const boom = new Error("boom -- not a BadRequestException");
    const sscc = {
      resolveIssuerPrefix: async () => {
        throw boom;
      },
      allocateForBundle: async () => {
        throw new Error("allocateForBundle must not be called when resolveIssuerPrefix throws");
      },
    } as unknown as SsccService;

    const entitlements = {
      resolveRecovery: async () => ({ access: "managed", subscription: null }),
    } as unknown as EntitlementsService;
    const service = new ShiftsService(db, fakeOperatorsService(), sscc, entitlements);

    await expect(service.getBundle("tenant-1", "shift-1", "device-1")).rejects.toBe(boom);
    expect(lockedTables).toEqual([schema.shifts]);
  });
});

describe("ShiftsService.getReferenceBundle product-group mapping", () => {
  it("maps a product with no dictionary group to a null productGroup, not undefined", async () => {
    const { db } = fakeDb(
      new Map<unknown, unknown[]>([
        [schema.shifts, [SHIFT_ROW]],
        [schema.products, [PRODUCT_ROW]],
      ]),
    );
    const service = new ShiftsService(
      db,
      fakeOperatorsService(),
      {} as SsccService,
      {} as EntitlementsService,
    );

    const bundle = await service.getReferenceBundle("tenant-1", "shift-1");

    expect(bundle.product.productGroup).toBeNull();
  });
});

describe("ShiftsService box-template snapshot boundary", () => {
  it("rejects a foreign organisation default through the shift composite FK and inserts no shift", async () => {
    const tenantId = "tenant-1";
    const productId = "10000000-0000-4000-8000-000000000001";
    const foreignTemplateId = "20000000-0000-4000-8000-000000000002";
    const insertedShifts: Record<string, unknown>[] = [];

    const product = {
      ...PRODUCT_ROW,
      id: productId,
      tenantId,
      status: "active",
    };
    const db = {
      select: () => ({
        from: (table: unknown) => {
          const rows =
            table === schema.products
              ? [product]
              : table === schema.orgProfiles
                ? [{ defaultBoxLabelTemplateId: foreignTemplateId }]
                : insertedShifts;
          return chain(rows, table, []);
        },
      }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) =>
          table === schema.shiftNumberCounters
            ? {
                onConflictDoUpdate: () => ({
                  returning: async () => [{ lastSeq: 1 }],
                }),
              }
            : {
                returning: async () => {
                  if (table === schema.shifts && values.boxLabelTemplateId === foreignTemplateId) {
                    throw {
                      code: "23503",
                      constraint: "shifts_tenant_box_label_template_fk",
                    };
                  }
                  insertedShifts.push(values);
                  return [{ ...SHIFT_ROW, ...values }];
                },
              },
      }),
      transaction: async (run: (tx: Db) => Promise<unknown>) => run(db),
    } as unknown as Db;
    const entitlements = {
      assertFeatureAccess: async () => undefined,
    } as unknown as EntitlementsService;
    const service = new ShiftsService(db, fakeOperatorsService(), {} as SsccService, entitlements);

    await expect(
      service.createShift(tenantId, { productId, mode: "aggregation" }),
    ).rejects.toMatchObject({
      response: { message: "Unknown box label template for this organization" },
    });
    expect(insertedShifts).toEqual([]);
  });
});

function updateDb(current: typeof SHIFT_ROW) {
  let stored = { ...current };
  const set = vi.fn((values: Partial<typeof SHIFT_ROW>) => {
    stored = { ...stored, ...values };
    return {
      where: () => ({
        returning: async () => [stored],
      }),
    };
  });
  const db = {
    select: () => ({
      from: () => chain([stored], schema.shifts, []),
    }),
    update: () => ({ set }),
    transaction: async (run: (tx: Db) => Promise<unknown>) => run(db as unknown as Db),
  } as unknown as Db;
  return { db, set };
}

function serviceForUpdate(db: Db) {
  return new ShiftsService(
    db,
    fakeOperatorsService(),
    {} as SsccService,
    {} as EntitlementsService,
  );
}

const UPDATE_TENANT_ID = "tenant-1";
const UPDATE_ACTOR_USER_ID = "user-1";
const UPDATE_SHIFT_ID = "shift-1";

type ProductionDateAuditFixture = {
  organizationId: string;
  actorUserId: string;
  action: string;
  outcome: string;
  targetType: string;
  targetId: string;
  before: { productionDate: string | null };
  after: { productionDate: string | null; reason: string };
};

type ClosedBoxFixture = {
  id: string;
  tenantId: string;
  shiftId: string;
  closedAt: Date | null;
  disassembledAt?: Date | null;
};

function productionDateUpdateDb(
  current: typeof SHIFT_ROW,
  options: {
    closedBoxes?: ClosedBoxFixture[];
    guardedUpdateSucceeds?: boolean;
    failSuccessAudit?: boolean;
  } = {},
) {
  const dialect = new PgDialect();
  let stored = { ...current };
  const audits: ProductionDateAuditFixture[] = [];
  const boxQueries: { sql: string; params: unknown[] }[] = [];
  const shiftLockQueries: { sql: string; params: unknown[]; mode: string }[] = [];
  const lockEvents: string[] = [];

  const makeWriter = (transactionState?: {
    stored: typeof SHIFT_ROW;
    audits: ProductionDateAuditFixture[];
  }) => ({
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.shifts && transactionState) {
          return {
            where: (condition: SQL) => ({
              for: async (mode: string) => {
                const query = dialect.sqlToQuery(condition);
                shiftLockQueries.push({ sql: query.sql, params: query.params, mode });
                lockEvents.push("shift-lock");
                return [transactionState.stored];
              },
            }),
          };
        }
        if (table !== schema.boxes) {
          return chain([transactionState?.stored ?? stored], table, []);
        }
        return {
          where: (condition: SQL) => {
            const query = dialect.sqlToQuery(condition);
            boxQueries.push({ sql: query.sql, params: query.params });
            lockEvents.push("box-check");
            const [tenantId, shiftId] = query.params;
            const rows = (options.closedBoxes ?? []).filter(
              (box) =>
                box.tenantId === tenantId && box.shiftId === shiftId && box.closedAt !== null,
            );
            return { limit: async () => rows.slice(0, 1) };
          },
        };
      },
    }),
    update: () => ({
      set: (values: Partial<typeof SHIFT_ROW>) => ({
        where: () => ({
          returning: async () => {
            if (options.guardedUpdateSucceeds === false) return [];
            if (transactionState) {
              transactionState.stored = { ...transactionState.stored, ...values };
              return [transactionState.stored];
            }
            stored = { ...stored, ...values };
            return [stored];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: ProductionDateAuditFixture) => {
        if (table !== schema.tenantAuditEvents) {
          throw new Error("Unexpected insert table");
        }
        if (options.failSuccessAudit && values.outcome === "success") {
          throw new Error("audit insert failed");
        }
        (transactionState?.audits ?? audits).push(values);
      },
    }),
  });

  const db = makeWriter() as unknown as Db;
  const transaction = vi.fn(async (run: (tx: Db) => Promise<unknown>) => {
    const transactionState = { stored: { ...stored }, audits: [] as ProductionDateAuditFixture[] };
    const result = await run(makeWriter(transactionState) as unknown as Db);
    stored = transactionState.stored;
    audits.push(...transactionState.audits);
    return result;
  });
  Object.assign(db, { transaction });

  return {
    db,
    audits,
    boxQueries,
    shiftLockQueries,
    lockEvents,
    transaction,
    stored: () => stored,
  };
}

function callProductionDateUpdate(service: ShiftsService, data: { productionDate: string | null }) {
  return service.updateShift(UPDATE_TENANT_ID, UPDATE_ACTOR_USER_ID, UPDATE_SHIFT_ID, data);
}

function productionDateAudit(
  outcome: "success" | "failure",
  before: string | null,
  after: string | null,
  reason: "changed" | "box_already_closed" | "shift_closed" | "status_changed",
): ProductionDateAuditFixture {
  return {
    organizationId: UPDATE_TENANT_ID,
    actorUserId: UPDATE_ACTOR_USER_ID,
    action: "shift.production_date.changed",
    outcome,
    targetType: "shift",
    targetId: UPDATE_SHIFT_ID,
    before: { productionDate: before },
    after: { productionDate: after, reason },
  };
}

describe("ShiftsService.updateShift active-shift safety", () => {
  it("updates only active-shift administrative metadata and the box label template", async () => {
    const { db, set } = updateDb(SHIFT_ROW);
    const service = serviceForUpdate(db);

    const updated = await service.updateShift("tenant-1", "user-1", "shift-1", {
      lineId: "line-2",
      plannedDate: "2026-08-14",
      plannedQty: 750,
      boxLabelTemplateId: "box-template-2",
    });

    expect(set).toHaveBeenCalledWith({
      lineId: "line-2",
      plannedDate: "2026-08-14",
      plannedQty: 750,
      boxLabelTemplateId: "box-template-2",
    });
    expect(updated).toMatchObject({
      status: "active",
      lineId: "line-2",
      plannedDate: "2026-08-14",
      plannedQty: 750,
      boxLabelTemplateId: "box-template-2",
    });
  });

  it("rejects operational changes while a shift is active", async () => {
    const { db, set } = updateDb(SHIFT_ROW);
    const service = serviceForUpdate(db);

    await expect(
      service.updateShift("tenant-1", "user-1", "shift-1", { mode: "validation" }),
    ).rejects.toThrow(ConflictException);
    expect(set).not.toHaveBeenCalled();
  });
});

describe("ShiftsService.updateShift production-date lock and audit", () => {
  it.each([
    { status: "planned" as const, before: null, after: "2026-08-21" },
    { status: "planned" as const, before: "2026-08-20", after: null },
    { status: "active" as const, before: null, after: "2026-08-21" },
    { status: "active" as const, before: "2026-08-20", after: null },
  ])("lets a $status shift change production date before any box closes", async (fixture) => {
    const harness = productionDateUpdateDb({
      ...SHIFT_ROW,
      status: fixture.status,
      mode: fixture.status === "planned" ? "validation" : SHIFT_ROW.mode,
      productionDate: fixture.before,
    });
    const service = serviceForUpdate(harness.db);

    const updated = await callProductionDateUpdate(service, {
      productionDate: fixture.after,
    });

    expect(updated.productionDate).toBe(fixture.after);
    expect(harness.stored().productionDate).toBe(fixture.after);
    expect(harness.audits).toEqual([
      productionDateAudit("success", fixture.before, fixture.after, "changed"),
    ]);
  });

  it.each(["planned", "active"] as const)(
    "treats an identical production date on a %s shift as a no-op",
    async (status) => {
      const harness = productionDateUpdateDb({
        ...SHIFT_ROW,
        status,
        mode: status === "planned" ? "validation" : SHIFT_ROW.mode,
        productionDate: "2026-08-21",
      });
      const service = serviceForUpdate(harness.db);

      const updated = await callProductionDateUpdate(service, {
        productionDate: "2026-08-21",
      });

      expect(updated.productionDate).toBe("2026-08-21");
      expect(harness.boxQueries).toEqual([]);
      expect(harness.shiftLockQueries).toEqual([]);
      expect(harness.audits).toEqual([]);
      expect(harness.transaction).not.toHaveBeenCalled();
    },
  );

  it("does not let another tenant's historical box lock this tenant's shift", async () => {
    const harness = productionDateUpdateDb(
      { ...SHIFT_ROW, status: "planned", mode: "validation", productionDate: null },
      {
        closedBoxes: [
          {
            id: "foreign-box",
            tenantId: "tenant-2",
            shiftId: "foreign-shift",
            closedAt: new Date("2026-08-20T10:00:00.000Z"),
          },
        ],
      },
    );
    const service = serviceForUpdate(harness.db);

    const updated = await callProductionDateUpdate(service, {
      productionDate: "2026-08-21",
    });

    expect(updated.productionDate).toBe("2026-08-21");
    expect(harness.shiftLockQueries).toEqual([
      {
        sql: '("shifts"."tenant_id" = $1 and "shifts"."id" = $2)',
        params: [UPDATE_TENANT_ID, UPDATE_SHIFT_ID],
        mode: "update",
      },
    ]);
    expect(harness.boxQueries).toEqual([
      {
        sql: '("boxes"."tenant_id" = $1 and "boxes"."shift_id" = $2 and "boxes"."closed_at" is not null)',
        params: [UPDATE_TENANT_ID, UPDATE_SHIFT_ID],
      },
    ]);
    expect(harness.lockEvents).toEqual(["shift-lock", "box-check"]);
  });

  it("rejects after any same-tenant box closure, even when that box was later disassembled", async () => {
    const before = "2026-08-20";
    const after = "2026-08-21";
    const harness = productionDateUpdateDb(
      { ...SHIFT_ROW, productionDate: before },
      {
        closedBoxes: [
          {
            id: "retired-box",
            tenantId: UPDATE_TENANT_ID,
            shiftId: UPDATE_SHIFT_ID,
            closedAt: new Date("2026-08-20T10:00:00.000Z"),
            disassembledAt: new Date("2026-08-20T11:00:00.000Z"),
          },
        ],
      },
    );
    const service = serviceForUpdate(harness.db);

    await expect(
      callProductionDateUpdate(service, { productionDate: after }),
    ).rejects.toMatchObject({
      response: {
        code: "PRODUCTION_DATE_LOCKED",
        message: "Production date cannot change after the first box closure",
      },
    });
    expect(harness.stored().productionDate).toBe(before);
    expect(harness.audits).toEqual([
      productionDateAudit("failure", before, after, "box_already_closed"),
    ]);
  });

  it("rejects from the durable closure marker without requiring a historical box row", async () => {
    const before = "2026-08-20";
    const after = "2026-08-21";
    const harness = productionDateUpdateDb({
      ...SHIFT_ROW,
      productionDate: before,
      firstBoxClosureAt: new Date("2026-08-20T10:00:00.000Z"),
    });
    const service = serviceForUpdate(harness.db);

    await expect(
      callProductionDateUpdate(service, { productionDate: after }),
    ).rejects.toMatchObject({
      response: {
        code: "PRODUCTION_DATE_LOCKED",
        message: "Production date cannot change after the first box closure",
      },
    });
    expect(harness.boxQueries).toEqual([]);
    expect(harness.stored().productionDate).toBe(before);
    expect(harness.audits).toEqual([
      productionDateAudit("failure", before, after, "box_already_closed"),
    ]);
  });

  it("keeps the existing closed-shift conflict and records the attempted date", async () => {
    const before = "2026-08-20";
    const after = "2026-08-21";
    const harness = productionDateUpdateDb({
      ...SHIFT_ROW,
      status: "closed",
      productionDate: before,
    });
    const service = serviceForUpdate(harness.db);

    await expect(callProductionDateUpdate(service, { productionDate: after })).rejects.toThrow(
      "Closed shifts cannot be edited",
    );
    expect(harness.stored().productionDate).toBe(before);
    expect(harness.audits).toEqual([productionDateAudit("failure", before, after, "shift_closed")]);
  });

  it("does not audit an identical production date rejected by the closed-shift rule", async () => {
    const harness = productionDateUpdateDb({
      ...SHIFT_ROW,
      status: "closed",
      productionDate: "2026-08-21",
    });
    const service = serviceForUpdate(harness.db);

    await expect(
      callProductionDateUpdate(service, { productionDate: "2026-08-21" }),
    ).rejects.toThrow("Closed shifts cannot be edited");
    expect(harness.audits).toEqual([]);
  });

  it.each([
    {
      status: "planned" as const,
      message: "Shift can only be edited while planned",
    },
    {
      status: "active" as const,
      message: "Shift is no longer active",
    },
  ])("audits a guarded $status status race without changing its 409 message", async (fixture) => {
    const before = "2026-08-20";
    const after = "2026-08-21";
    const harness = productionDateUpdateDb(
      {
        ...SHIFT_ROW,
        status: fixture.status,
        mode: fixture.status === "planned" ? "validation" : SHIFT_ROW.mode,
        productionDate: before,
      },
      { guardedUpdateSucceeds: false },
    );
    const service = serviceForUpdate(harness.db);

    await expect(callProductionDateUpdate(service, { productionDate: after })).rejects.toThrow(
      fixture.message,
    );
    expect(harness.stored().productionDate).toBe(before);
    expect(harness.audits).toEqual([
      productionDateAudit("failure", before, after, "status_changed"),
    ]);
  });

  it("rolls back the production-date update when the success audit insert fails", async () => {
    const before = "2026-08-20";
    const harness = productionDateUpdateDb(
      { ...SHIFT_ROW, status: "planned", mode: "validation", productionDate: before },
      { failSuccessAudit: true },
    );
    const service = serviceForUpdate(harness.db);

    await expect(
      callProductionDateUpdate(service, { productionDate: "2026-08-21" }),
    ).rejects.toThrow("audit insert failed");
    expect(harness.stored().productionDate).toBe(before);
    expect(harness.audits).toEqual([]);
  });
});

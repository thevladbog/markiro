import { describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { ShiftsService } from "../src/modules/shifts/shifts.service";
import type { OperatorsService } from "../src/modules/operators/operators.service";
import type { SsccService } from "../src/modules/sscc/sscc.service";

/**
 * A chainable stub covering both shapes `ShiftsService.getBundle` needs:
 * `select().from(table).leftJoin(...).leftJoin(...).where()` (getShift's
 * joined query) and the plain `select().from(table).where()` (findProductRow,
 * and the label-template/counterparty lookups this test never reaches).
 * `leftJoin`/`where`'s arguments are real drizzle `eq`/`and` SQL fragments --
 * ignored here, since which row comes back depends only on which TABLE
 * `.from()` was called with, not on the condition.
 */
function chain(rows: unknown[]) {
  const node: { leftJoin: () => typeof node; where: () => Promise<unknown[]> } = {
    leftJoin: () => node,
    where: async () => rows,
  };
  return node;
}

function fakeDb(rowsByTable: Map<unknown, unknown[]>): Db {
  return {
    select: () => ({
      from: (table: unknown) => chain(rowsByTable.get(table) ?? []),
    }),
  } as unknown as Db;
}

function fakeOperatorsService(): OperatorsService {
  return { buildRoster: async () => [] } as unknown as OperatorsService;
}

const SHIFT_ROW = {
  id: "shift-1",
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
  boxCapacity: 10,
  palletCapacity: null,
  palletsEnabled: false,
  createdFrom: "admin",
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
  productGroup: null,
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
    const db = fakeDb(
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

    const service = new ShiftsService(db, fakeOperatorsService(), sscc);

    await expect(service.getBundle("tenant-1", "shift-1", "device-1")).rejects.toBe(boom);
  });
});

import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@markiro/db";
import { palletDataFromLegacySource } from "@markiro/domain";
import { a4PalletSource, thermalChoice } from "./support/pallet-reprint";
import { WarehouseUnifiedService } from "../src/modules/station-warehouse-reprint/unified.service";
import { WarehousePalletRenderingsService } from "../src/modules/station-warehouse-reprint/pallet-renderings.service";
import { describe, expect, it, vi } from "vitest";
import { StationWarehouseReprintController } from "../src/modules/station-warehouse-reprint/controller";
import type { RequestWithTenant } from "../src/tenancy/tenant.guard";

function controller() {
  const calls = {
    lookup: vi.fn(),
    handheldLookup: vi.fn(),
    handheldTemplates: vi.fn(),
    templates: vi.fn(),
    receive: vi.fn(),
    receiveRenderings: vi.fn(),
    events: vi.fn(),
  };
  type Args = ConstructorParameters<typeof StationWarehouseReprintController>;
  const instance = new StationWarehouseReprintController(
    ...(Array.from({ length: 8 }, () => calls) as unknown as Args),
  );
  return { instance, calls };
}
const request = (deviceKind: string, tenantId: string | undefined = "tenant") =>
  ({
    tenantId,
    deviceId: "device",
    deviceKind,
    get: () => undefined,
  }) as unknown as RequestWithTenant;

describe("handheld site reprint route boundary", () => {
  it("forwards only the authenticated scope and operator for unified lookup", () => {
    const { instance, calls } = controller();
    instance.handheldLookup(request("handheld"), {
      protocol: "warehouse-unified-reprint-v3",
      raw: "full-code",
      operatorId: "operator",
    });
    expect(calls.handheldLookup).toHaveBeenCalledExactlyOnceWith(
      "tenant",
      "device",
      "operator",
      "full-code",
    );
  });
  it("allows required catalogs and audit events but denies production source ingestion and legacy pallet routes", () => {
    const { instance, calls } = controller();
    instance.templates(request("handheld"), {});
    instance.handheldPalletTemplates(request("handheld"));
    instance.receive(request("handheld"), { protocol: "warehouse-label-reprint-v1", events: [] });
    instance.palletRenderingsV3(request("handheld"), {
      protocol: "warehouse-unified-reprint-v3",
      entries: [],
    });
    instance.palletEventsV3(request("handheld"), {
      protocol: "warehouse-unified-reprint-v3",
      entries: [],
    });
    expect(calls.templates).toHaveBeenCalledTimes(1);
    expect(calls.handheldTemplates).toHaveBeenCalledTimes(1);
    expect(calls.receiveRenderings).toHaveBeenCalledExactlyOnceWith("tenant", "device", {
      protocol: "warehouse-unified-reprint-v3",
      entries: [],
    });
    expect(() =>
      instance.palletDataV3(request("handheld"), {
        protocol: "warehouse-unified-reprint-v3",
        entries: [],
      }),
    ).toThrow("Forbidden");
    expect(() =>
      instance.palletSources(request("handheld"), {
        protocol: "warehouse-pallet-reprint-v1",
        entries: [],
      }),
    ).toThrow("Forbidden");
  });
  it("denies wrong kinds and incomplete tenant scope before service access", () => {
    for (const req of [request("office"), request("kiosk"), request("handheld", undefined)]) {
      if (req.deviceKind === "handheld") delete req.tenantId;
      const { instance, calls } = controller();
      expect(() =>
        instance.handheldLookup(req, {
          protocol: "warehouse-unified-reprint-v3",
          raw: "full-code",
          operatorId: "operator",
        }),
      ).toThrow("Forbidden");
      expect(calls.handheldLookup).not.toHaveBeenCalled();
    }
  });
});

describe("handheld metadata retains immutable station snapshots", () => {
  it("joins the pallet source shift product within the authenticated tenant without changing historical data", async () => {
    const tenantId = randomUUID(),
      productId = randomUUID();
    const data = palletDataFromLegacySource(a4PalletSource());
    const conditions: { sql: string; params: unknown[] }[] = [];
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: (condition: SQL) => {
              conditions.push(new PgDialect().sqlToQuery(condition));
              return { limit: async () => [{ productId, groupCode: 8 }] };
            },
          }),
        }),
      }),
    } as unknown as Db;
    const service = new WarehouseUnifiedService(
      db,
      {} as ConstructorParameters<typeof WarehouseUnifiedService>[1],
      {} as ConstructorParameters<typeof WarehouseUnifiedService>[2],
    );
    vi.spyOn(service, "lookup").mockResolvedValue({ status: "found", kind: "pallet", data });
    const result = await service.handheldLookup(tenantId, randomUUID(), randomUUID(), data.sscc);
    expect(result.result).toEqual({ status: "found", kind: "pallet", data });
    expect(result).toMatchObject({ productId, groupCode: 8 });
    expect(conditions[0]?.params).toEqual([tenantId, data.shiftId]);
    expect(conditions[0]?.sql).toContain('"shifts"."tenant_id"');
    expect(data.revision).toBe(palletDataFromLegacySource(a4PalletSource()).revision);
  });
  it("returns template group restrictions separately from strict station template choices and drops disappeared catalog entries", async () => {
    const choice = thermalChoice(),
      foreign = { ...choice, id: randomUUID() };
    const scopes: { sql: string; params: unknown[] }[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: (condition: SQL) => {
            scopes.push(new PgDialect().sqlToQuery(condition));
            return Promise.resolve([{ id: choice.id, groups: [8] }]);
          },
        }),
      }),
    } as unknown as Db;
    const service = new WarehousePalletRenderingsService(
      db,
      {} as ConstructorParameters<typeof WarehousePalletRenderingsService>[1],
    );
    vi.spyOn(service, "templates").mockResolvedValue({
      protocol: "warehouse-pallet-reprint-v2",
      templates: [choice, foreign],
    });
    const tenantId = randomUUID();
    expect(await service.handheldTemplates(tenantId, randomUUID())).toEqual({
      protocol: "warehouse-unified-reprint-v3",
      templates: [{ template: choice, groupCodes: [8] }],
    });
    expect(scopes[0]?.params).toEqual([tenantId, "pallet", true]);
  });
});

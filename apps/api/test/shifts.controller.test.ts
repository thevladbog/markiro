import { describe, expect, it, vi } from "vitest";

import { createShiftSchema, updateShiftSchema, type ShiftDto } from "../src/modules/shifts/dto";
import { ShiftsController } from "../src/modules/shifts/shifts.controller";
import type { ShiftsService } from "../src/modules/shifts/shifts.service";
import type { RequestWithTenant } from "../src/tenancy/tenant.guard";

const shiftFixture: ShiftDto = {
  id: "44444444-4444-4444-8444-444444444444",
  number: "AUG26-001/S",
  status: "planned",
  mode: "validation",
  productId: "22222222-2222-4222-8222-222222222222",
  productName: "Fixture product",
  image: null,
  lineId: "11111111-1111-4111-8111-111111111111",
  lineName: "Fixture line",
  counterpartyId: null,
  counterpartyName: null,
  ssccIssuerCounterpartyId: null,
  boxLabelTemplateId: null,
  plannedQty: null,
  plannedDate: "2026-08-14",
  productionDate: "2026-08-13",
  boxCapacity: 12,
  palletCapacity: 48,
  palletsEnabled: false,
  createdFrom: "station",
  openedAt: null,
  closedAt: null,
  closeReason: null,
  lateDataAt: null,
  createdAt: new Date("2026-08-13T09:00:00.000Z"),
};

describe("shift production date DTO boundary", () => {
  const productId = "22222222-2222-4222-8222-222222222222";

  it("preserves an explicit production date and null while retaining omission", () => {
    expect(
      createShiftSchema.parse({
        productId,
        mode: "aggregation",
        productionDate: "2026-08-21",
      }),
    ).toMatchObject({ productionDate: "2026-08-21" });
    expect(
      createShiftSchema.parse({ productId, mode: "aggregation", productionDate: null }),
    ).toMatchObject({ productionDate: null });
    expect(createShiftSchema.parse({ productId, mode: "aggregation" })).not.toHaveProperty(
      "productionDate",
    );
    expect(updateShiftSchema.parse({ productionDate: "2026-08-21" })).toEqual({
      productionDate: "2026-08-21",
    });
    expect(updateShiftSchema.parse({ productionDate: null })).toEqual({ productionDate: null });
  });

  it("rejects impossible and malformed production dates", () => {
    expect(() =>
      createShiftSchema.parse({
        productId,
        mode: "aggregation",
        productionDate: "2026-02-30",
      }),
    ).toThrow();
    expect(() =>
      createShiftSchema.parse({
        productId,
        mode: "aggregation",
        productionDate: "21.08.2026",
      }),
    ).toThrow();
  });
});

describe("ShiftsController.createShift", () => {
  it("uses the authenticated station line, station-provided local date, and station origin", async () => {
    const createShift = vi.fn(async () => shiftFixture);
    const controller = new ShiftsController({ createShift } as unknown as ShiftsService);
    const request = {
      tenantId: "tenant-1",
      authKind: "station",
      deviceLineId: "11111111-1111-4111-8111-111111111111",
    } as RequestWithTenant;

    const body = createShiftSchema.parse({
      productId: "22222222-2222-4222-8222-222222222222",
      mode: "validation",
      lineId: "33333333-3333-4333-8333-333333333333",
      plannedDate: "2026-08-14",
      productionDate: "2026-08-13",
    });

    await controller.createShift(request, body);

    expect(createShift).toHaveBeenCalledWith(
      "tenant-1",
      {
        productId: "22222222-2222-4222-8222-222222222222",
        mode: "validation",
        lineId: "11111111-1111-4111-8111-111111111111",
        plannedDate: "2026-08-14",
        productionDate: "2026-08-13",
      },
      "station",
    );
  });
});

describe("ShiftsController.enterShift", () => {
  it("passes the authenticated station device to the entry service", async () => {
    const enterShift = vi.fn(async () => ({
      ...shiftFixture,
      status: "active" as const,
      stationCloseAccess: { kind: "single_device", ownerDeviceId: "device-1" },
    }));
    const controller = new ShiftsController({ enterShift } as unknown as ShiftsService);
    const request = {
      tenantId: "tenant-1",
      authKind: "station",
      deviceId: "device-1",
    } as RequestWithTenant;

    await controller.enterShift(request, "shift-1");

    expect(enterShift).toHaveBeenCalledWith("tenant-1", "shift-1", "device-1");
  });
});

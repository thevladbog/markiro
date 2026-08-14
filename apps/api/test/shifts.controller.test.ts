import { describe, expect, it, vi } from "vitest";

import { ShiftsController } from "../src/modules/shifts/shifts.controller";
import type { ShiftsService } from "../src/modules/shifts/shifts.service";
import type { RequestWithTenant } from "../src/tenancy/tenant.guard";

describe("ShiftsController.createShift", () => {
  it("uses the authenticated station line, station-provided local date, and station origin", async () => {
    const createShift = vi.fn(async () => ({ id: "shift-1" }));
    const controller = new ShiftsController({ createShift } as unknown as ShiftsService);
    const request = {
      tenantId: "tenant-1",
      authKind: "station",
      deviceLineId: "11111111-1111-4111-8111-111111111111",
    } as RequestWithTenant;

    await controller.createShift(request, {
      productId: "22222222-2222-4222-8222-222222222222",
      mode: "validation",
      lineId: "33333333-3333-4333-8333-333333333333",
      plannedDate: "2026-08-14",
    });

    expect(createShift).toHaveBeenCalledWith(
      "tenant-1",
      {
        productId: "22222222-2222-4222-8222-222222222222",
        mode: "validation",
        lineId: "11111111-1111-4111-8111-111111111111",
        plannedDate: "2026-08-14",
      },
      "station",
    );
  });
});

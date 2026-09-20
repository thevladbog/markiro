import {
  buildDuplicateLabelTemplate,
  PRODUCT_LABEL_PROTOCOL,
  VALIDATION_REPROCESSING_PROTOCOL,
  productLabelValueDigest,
  validationPrintPolicySchema,
} from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";
import { request as expressRequest } from "express";

import {
  createShiftSchema,
  shiftEntrySchema,
  updateShiftSchema,
  type ShiftDto,
} from "../src/modules/shifts/dto";
import { ShiftsController } from "../src/modules/shifts/shifts.controller";
import type { ShiftsService } from "../src/modules/shifts/shifts.service";
import type { RequestWithTenant } from "../src/tenancy/tenant.guard";

const shiftFixture: ShiftDto = {
  id: "44444444-4444-4444-8444-444444444444",
  number: "AUG26-001/S",
  status: "planned",
  mode: "validation",
  validationPrint: {
    mode: "none",
    verification: "none",
    templateId: null,
    snapshot: null,
    policyRevision: null,
  },
  productId: "22222222-2222-4222-8222-222222222222",
  productName: "Fixture product",
  productPrintName: null,
  image: null,
  lineId: "11111111-1111-4111-8111-111111111111",
  lineName: "Fixture line",
  counterpartyId: null,
  counterpartyName: null,
  ssccIssuerCounterpartyId: null,
  boxLabelTemplateId: null,
  palletLabelTemplateId: null,
  plannedQty: null,
  plannedDate: "2026-08-14",
  productionDate: "2026-08-13",
  boxCapacity: 12,
  palletBoxCapacity: 48,
  palletsEnabled: false,
  createdFrom: "station",
  openedAt: null,
  closedAt: null,
  closeReason: null,
  lateDataAt: null,
  createdAt: new Date("2026-08-13T09:00:00.000Z"),
  output: { mode: "validation", acceptedUnits: 0 },
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
    expect(
      createShiftSchema.parse({
        productId,
        mode: "aggregation",
        productionDate: "2024-02-29",
      }),
    ).toMatchObject({ productionDate: "2024-02-29" });
    expect(updateShiftSchema.parse({ productionDate: "2024-02-29" })).toEqual({
      productionDate: "2024-02-29",
    });
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
    expect(() =>
      createShiftSchema.parse({
        productId,
        mode: "aggregation",
        productionDate: "0000-01-01",
      }),
    ).toThrow();
    expect(() => updateShiftSchema.parse({ productionDate: "0000-01-01" })).toThrow();
  });
});

describe("ShiftsController.createShift", () => {
  it("uses the authenticated station line, station-provided local date, and station origin", async () => {
    const createShift = vi.fn(async () => shiftFixture);
    const controller = new ShiftsController({ createShift } as unknown as ShiftsService);
    const request = {
      tenantId: "tenant-1",
      authKind: "station",
      deviceId: "device-1",
      deviceLineId: "11111111-1111-4111-8111-111111111111",
    } as RequestWithTenant;
    request.headers = { "x-station-capabilities": "validation-dm-duplicate-v1" };
    request.get = expressRequest.get;

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
      { domain: "station_device", id: "device-1" },
      "station",
      "validation-dm-duplicate-v1",
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
    request.headers = { "x-station-capabilities": "validation-dm-duplicate-v1" };
    request.get = expressRequest.get;

    await controller.enterShift(request, "shift-1", shiftEntrySchema.parse(undefined));

    expect(enterShift).toHaveBeenCalledWith(
      "tenant-1",
      "shift-1",
      "device-1",
      "validation-dm-duplicate-v1",
      "list",
    );
  });
});

describe("shift owner identity and device policy projection", () => {
  const template = {
    id: "40000000-0000-4000-8000-000000000004",
    name: "Saved duplicate",
    spec: buildDuplicateLabelTemplate(),
  };
  const policy = validationPrintPolicySchema.parse({
    mode: "duplicate_dm",
    verification: "required",
    allowPreviouslyAcceptedCodes: false,
    templateId: template.id,
    snapshot: { ...template, digest: productLabelValueDigest(template) },
    policyRevision: "40000000-0000-4000-8000-000000000005",
  });
  const saved: ShiftDto = {
    ...shiftFixture,
    validationPrint: policy,
    output: { mode: "validation", acceptedUnits: 1, firstAcceptedUnits: 1, reprocessedUnits: 0 },
  };

  for (const surface of ["legacy station", "capable station", "cabinet"] as const) {
    const station = surface !== "cabinet";
    const capabilities =
      surface === "capable station"
        ? `${PRODUCT_LABEL_PROTOCOL}, ${VALIDATION_REPROCESSING_PROTOCOL}`
        : PRODUCT_LABEL_PROTOCOL;
    const actor = station
      ? { domain: "station_device", id: "device-owner" }
      : { domain: "cabinet", id: "cabinet-owner" };
    const authenticatedRequest = () => {
      const request = {
        tenantId: "tenant-owner",
        authKind: station ? "station" : "session",
        userId: "cabinet-owner",
        ...(station
          ? { deviceId: "device-owner", deviceLineId: "11111111-1111-4111-8111-111111111111" }
          : {}),
      } as RequestWithTenant;
      request.headers = { "x-station-capabilities": capabilities };
      request.get = expressRequest.get;
      return request;
    };
    const expected =
      surface === "legacy station"
        ? {
            ...saved,
            validationPrint: {
              mode: policy.mode,
              verification: policy.verification,
              templateId: policy.templateId,
              snapshot: policy.snapshot,
              policyRevision: policy.policyRevision,
            },
            output: { mode: "validation", acceptedUnits: 1 },
          }
        : saved;

    it(`create forwards the authenticated owner and preserves the ${surface} response`, async () => {
      const createShift = vi.fn(async () => saved);
      const controller = new ShiftsController({ createShift } as unknown as ShiftsService);
      const body = createShiftSchema.parse({
        productId: shiftFixture.productId,
        mode: "validation",
        lineId: "33333333-3333-4333-8333-333333333333",
      });
      expect(await controller.createShift(authenticatedRequest(), body)).toEqual(expected);
      expect(createShift.mock.calls).toEqual([
        station
          ? [
              "tenant-owner",
              { ...body, lineId: shiftFixture.lineId },
              actor,
              "station",
              capabilities,
            ]
          : ["tenant-owner", body, actor, "admin"],
      ]);
      // Projection must not mutate the persisted policy, snapshot, or split count result.
      expect(saved.validationPrint).toEqual(policy);
      expect(saved.output).toEqual({
        mode: "validation",
        acceptedUnits: 1,
        firstAcceptedUnits: 1,
        reprocessedUnits: 0,
      });
    });

    it(`open forwards the authenticated owner and preserves the ${surface} response`, async () => {
      const openShift = vi.fn(async () => saved);
      const controller = new ShiftsController({ openShift } as unknown as ShiftsService);
      expect(
        await controller.openShift(
          authenticatedRequest(),
          saved.id,
          shiftEntrySchema.parse(undefined),
        ),
      ).toEqual(expected);
      expect(openShift.mock.calls).toEqual([
        [
          "tenant-owner",
          saved.id,
          actor,
          station ? "device-owner" : undefined,
          capabilities,
          "list",
        ],
      ]);
      expect(saved.validationPrint).toEqual(policy);
    });
  }
});

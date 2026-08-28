import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { BadRequestException, RequestMethod } from "@nestjs/common";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";

import { ROUTE_ACCESS_POLICY } from "../src/authorization/access-policy";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { DashboardController } from "../src/modules/dashboard/dashboard.controller";
import {
  dashboardOverviewQuerySchema,
  type DashboardOverviewDto,
} from "../src/modules/dashboard/dto";
import type { DashboardService } from "../src/modules/dashboard/dashboard.service";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { ROUTE_SUBSCRIPTION_ACCESS_POLICY } from "../src/subscriptions/subscription-access-policy";
import { TenantGuard } from "../src/tenancy/tenant.guard";
import { ZodValidationPipe } from "../src/zod.pipe";

describe("DashboardController", () => {
  it("defaults an omitted period through the query pipe and uses the authenticated tenant", async () => {
    const response: DashboardOverviewDto = {
      generatedAt: "2026-08-27T09:45:00.000Z",
      timeZone: "Europe/Moscow",
      metricVersion: "operations-dashboard-v1",
      setup: { productCount: 0, shiftCount: 0, hasRunShift: false },
      verdict: { status: "under_control", reasons: [] },
      today: {
        validationAcceptedUnits: 0,
        aggregationClosedBoxes: 0,
        aggregationContainedUnits: 0,
        activeShiftCount: 0,
        includedClosedShiftCount: 0,
      },
      dynamics: {
        period: "7d",
        grain: "day",
        currentWindow: {
          start: "2026-08-20T21:00:00.000Z",
          end: "2026-08-27T09:45:00.000Z",
          validation: { acceptedUnits: 0, shiftHours: 0, unitsPerShiftHour: null },
          aggregation: {
            closedBoxes: 0,
            containedUnits: 0,
            shiftHours: 0,
            boxesPerShiftHour: null,
            containedUnitsPerShiftHour: null,
          },
        },
        comparisonWindow: {
          start: "2026-08-14T09:45:00.000Z",
          end: "2026-08-20T21:00:00.000Z",
          validation: { acceptedUnits: 0, shiftHours: 0, unitsPerShiftHour: null },
          aggregation: {
            closedBoxes: 0,
            containedUnits: 0,
            shiftHours: 0,
            boxesPerShiftHour: null,
            containedUnitsPerShiftHour: null,
          },
        },
        buckets: [],
        quality: {
          status: "complete",
          reasons: [],
          activeShiftCount: 0,
          lateDataShiftCount: 0,
          sources: ["code_registry", "boxes", "box_items"],
        },
      },
      activeShifts: [],
    };
    const overview = vi.fn<DashboardService["overview"]>().mockResolvedValue(response);
    const dashboard: Pick<DashboardService, "overview"> = { overview };
    const controller = new DashboardController(dashboard);
    const request: Parameters<DashboardController["overview"]>[0] = {
      tenantId: "authenticated-tenant",
    };
    const pipe = new ZodValidationPipe(dashboardOverviewQuerySchema);
    const query = pipe.transform({}) as ReturnType<typeof dashboardOverviewQuerySchema.parse>;

    await controller.overview(request, query);

    expect(overview).toHaveBeenCalledOnce();
    expect(overview).toHaveBeenCalledWith("authenticated-tenant", "7d");
  });

  it("rejects unsupported periods and a client-supplied tenant at the query pipe", () => {
    const pipe = new ZodValidationPipe(dashboardOverviewQuerySchema);

    expect(() => pipe.transform({ period: "year" })).toThrow(BadRequestException);
    expect(() => pipe.transform({ period: "today", tenantId: "forged-tenant" })).toThrow(
      BadRequestException,
    );
  });

  it("registers one guarded cabinet read route with subscription read-only access", () => {
    expect(Reflect.getMetadata(PATH_METADATA, DashboardController)).toBe("dashboard");
    expect(Reflect.getMetadata(GUARDS_METADATA, DashboardController)).toEqual([
      TenantGuard,
      AuthorizationGuard,
      SubscriptionAccessGuard,
    ]);
    expect(Reflect.getMetadata(ROUTE_ACCESS_POLICY, DashboardController)).toEqual({
      mode: "cabinet",
      capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
    });
    expect(Reflect.getMetadata(ROUTE_SUBSCRIPTION_ACCESS_POLICY, DashboardController)).toEqual({
      mode: "read_only_allowed",
      reason: "read",
    });
    expect(Reflect.getMetadata(PATH_METADATA, DashboardController.prototype.overview)).toBe(
      "overview",
    );
    expect(Reflect.getMetadata(METHOD_METADATA, DashboardController.prototype.overview)).toBe(
      RequestMethod.GET,
    );
  });
});

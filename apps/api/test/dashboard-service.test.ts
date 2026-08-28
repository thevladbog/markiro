import { describe, expect, it, vi } from "vitest";

import type {
  DashboardOverviewFacts,
  DashboardRepository,
} from "../src/modules/dashboard/dashboard.repository";
import { DashboardService } from "../src/modules/dashboard/dashboard.service";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const TENANT_ID = "tenant-a";

const emptyWindow = {
  start: "2026-08-20T00:00:00.000Z",
  end: NOW.toISOString(),
  validation: { acceptedUnits: 0, shiftHours: 0, unitsPerShiftHour: null },
  aggregation: {
    closedBoxes: 0,
    containedUnits: 0,
    shiftHours: 0,
    boxesPerShiftHour: null,
    containedUnitsPerShiftHour: null,
  },
} as const;

function overviewFacts(overrides: Partial<DashboardOverviewFacts> = {}): DashboardOverviewFacts {
  return {
    generatedAt: NOW,
    timeZone: "Asia/Yekaterinburg",
    setup: {
      productCount: 2,
      shiftCount: 3,
      hasRunShift: true,
      activeShiftCount: 0,
    },
    today: {
      validationAcceptedUnits: 0,
      aggregationClosedBoxes: 0,
      aggregationContainedUnits: 0,
      activeShiftCount: 0,
      includedClosedShiftCount: 1,
    },
    currentWindow: emptyWindow,
    comparisonWindow: emptyWindow,
    buckets: [],
    activeShifts: [],
    unreviewedConflictCount: 0,
    todayLateDataShiftCount: 0,
    selectedWindowLateDataShiftCount: 0,
    missingDurationModes: [],
    ...overrides,
  };
}

function serviceFor(facts: DashboardOverviewFacts) {
  const load = vi.fn(async () => facts);
  const repository: DashboardRepository = { load };
  return { service: new DashboardService(repository, () => NOW), load };
}

describe("DashboardService.overview", () => {
  it("makes conflicts critical and keeps every lower-priority reason in a stable order", async () => {
    const { service, load } = serviceFor(
      overviewFacts({
        unreviewedConflictCount: 2,
        todayLateDataShiftCount: 1,
        selectedWindowLateDataShiftCount: 1,
        missingDurationModes: ["validation", "aggregation"],
      }),
    );

    const result = await service.overview(TENANT_ID, "7d");

    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(TENANT_ID, "7d", NOW);
    expect(result.verdict.status).toBe("critical");
    expect(result.verdict.reasons.map((reason) => reason.code)).toEqual([
      "unreviewed_conflicts",
      "late_data",
      "missing_shift_duration",
    ]);
    expect(result.verdict.reasons).toEqual([
      {
        code: "unreviewed_conflicts",
        severity: "critical",
        count: 2,
        route: "/conflicts",
      },
      { code: "late_data", severity: "needs_attention", count: 1, route: "/shifts" },
      {
        code: "missing_shift_duration",
        severity: "needs_attention",
        count: 2,
        route: "/shifts",
        affectedModes: ["validation", "aggregation"],
      },
    ]);
    expect(result.dynamics.quality).toEqual({
      status: "insufficient",
      reasons: ["late_data", "missing_shift_duration"],
      activeShiftCount: 0,
      lateDataShiftCount: 1,
      sources: ["code_registry", "boxes", "box_items"],
    });
  });

  it("marks otherwise healthy active data provisional without lowering the verdict", async () => {
    const facts = overviewFacts({
      setup: {
        productCount: 2,
        shiftCount: 3,
        hasRunShift: true,
        activeShiftCount: 1,
      },
      today: {
        validationAcceptedUnits: 4,
        aggregationClosedBoxes: 0,
        aggregationContainedUnits: 0,
        activeShiftCount: 1,
        includedClosedShiftCount: 0,
      },
    });
    const { service } = serviceFor(facts);

    const result = await service.overview(TENANT_ID, "today");

    expect(result.verdict).toEqual({ status: "under_control", reasons: [] });
    expect(result.dynamics.quality.status).toBe("provisional");
    expect(result.dynamics.quality.reasons).toEqual(["active_shifts"]);
  });

  it("marks closed, timely data with eligible duration complete", async () => {
    const { service } = serviceFor(overviewFacts());

    const result = await service.overview(TENANT_ID, "30d");

    expect(result.verdict).toEqual({ status: "under_control", reasons: [] });
    expect(result.dynamics.quality.status).toBe("complete");
    expect(result.dynamics.quality.reasons).toEqual([]);
  });

  it("makes late data need attention even when every rate has eligible duration", async () => {
    const { service } = serviceFor(
      overviewFacts({ todayLateDataShiftCount: 3, selectedWindowLateDataShiftCount: 3 }),
    );

    const result = await service.overview(TENANT_ID, "30d");

    expect(result.verdict).toEqual({
      status: "needs_attention",
      reasons: [{ code: "late_data", severity: "needs_attention", count: 3, route: "/shifts" }],
    });
    expect(result.dynamics.quality).toMatchObject({
      status: "provisional",
      reasons: ["late_data"],
      lateDataShiftCount: 3,
    });
  });

  it("keeps historical-window late data in quality without lowering today's verdict", async () => {
    const { service } = serviceFor(
      overviewFacts({ todayLateDataShiftCount: 0, selectedWindowLateDataShiftCount: 2 }),
    );

    const result = await service.overview(TENANT_ID, "7d");

    expect(result.verdict).toEqual({ status: "under_control", reasons: [] });
    expect(result.dynamics.quality).toEqual({
      status: "provisional",
      reasons: ["late_data"],
      activeShiftCount: 0,
      lateDataShiftCount: 2,
      sources: ["code_registry", "boxes", "box_items"],
    });
  });

  it("alerts only when a mode has output without eligible duration", async () => {
    const currentWindow = {
      ...emptyWindow,
      validation: { acceptedUnits: 8, shiftHours: 0, unitsPerShiftHour: null },
    };
    const { service } = serviceFor(
      overviewFacts({ currentWindow, missingDurationModes: ["validation"] }),
    );

    const result = await service.overview(TENANT_ID, "7d");

    expect(result.verdict).toEqual({
      status: "needs_attention",
      reasons: [
        {
          code: "missing_shift_duration",
          severity: "needs_attention",
          count: 1,
          route: "/shifts",
          affectedModes: ["validation"],
        },
      ],
    });
    expect(result.dynamics.quality.status).toBe("insufficient");

    const unusedMode = await serviceFor(overviewFacts()).service.overview(TENANT_ID, "7d");
    expect(unusedMode.verdict).toEqual({ status: "under_control", reasons: [] });
  });

  it.each([
    ["today", "hour"],
    ["7d", "day"],
    ["30d", "day"],
    ["12w", "week"],
  ] as const)("composes the %s period using %s grain", async (period, grain) => {
    const facts = overviewFacts();
    const { service } = serviceFor(facts);

    const result = await service.overview(TENANT_ID, period);

    expect(result).toMatchObject({
      generatedAt: NOW.toISOString(),
      timeZone: facts.timeZone,
      metricVersion: "operations-dashboard-v1",
      setup: { productCount: 2, shiftCount: 3, hasRunShift: true },
      today: facts.today,
      dynamics: {
        period,
        grain,
        currentWindow: facts.currentWindow,
        comparisonWindow: facts.comparisonWindow,
        buckets: facts.buckets,
      },
      activeShifts: facts.activeShifts,
    });
  });
});

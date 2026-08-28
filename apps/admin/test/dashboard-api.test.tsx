import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ZodError } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DASHBOARD_QUERY_KEY,
  type DashboardOverviewDto,
  type DashboardPeriod,
  useDashboardOverview,
} from "../src/pages/dashboard/api.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function dashboardFixture(period: DashboardPeriod = "7d"): DashboardOverviewDto {
  return {
    generatedAt: "2026-08-27T09:45:00.000Z",
    timeZone: "Europe/Moscow",
    metricVersion: "operations-dashboard-v1",
    setup: { productCount: 1, shiftCount: 1, hasRunShift: true },
    verdict: { status: "under_control", reasons: [] },
    today: {
      validationAcceptedUnits: 128489,
      aggregationClosedBoxes: 412,
      aggregationContainedUnits: 10712,
      activeShiftCount: 1,
      includedClosedShiftCount: 4,
    },
    dynamics: {
      period,
      grain: "day",
      currentWindow: {
        start: "2026-08-20T21:00:00.000Z",
        end: "2026-08-27T09:45:00.000Z",
        validation: { acceptedUnits: 128489, shiftHours: 28.5, unitsPerShiftHour: 4508.4 },
        aggregation: {
          closedBoxes: 412,
          containedUnits: 10712,
          shiftHours: 18.5,
          boxesPerShiftHour: 22.3,
          containedUnitsPerShiftHour: 579,
        },
      },
      comparisonWindow: {
        start: "2026-08-13T21:00:00.000Z",
        end: "2026-08-20T09:45:00.000Z",
        validation: { acceptedUnits: 102000, shiftHours: 25, unitsPerShiftHour: 4080 },
        aggregation: {
          closedBoxes: 380,
          containedUnits: 9880,
          shiftHours: 17.5,
          boxesPerShiftHour: 21.7,
          containedUnitsPerShiftHour: 564.6,
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
    activeShifts: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        number: "S-2026-08-27-001",
        productName: "Вода газированная 1,0 л",
        lineName: "Линия 2",
        openedAt: "2026-08-27T07:00:00.000Z",
        lateDataAt: null,
        output: { mode: "aggregation", closedBoxes: 412, containedUnits: 10712 },
      },
    ],
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

async function expectRejectedOverview(
  response: unknown,
  expectedPath: readonly (string | number)[],
) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(response)));
  const { wrapper } = createWrapper();
  const hook = renderHook(() => useDashboardOverview("7d"), { wrapper });

  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.result.current.error).toBeInstanceOf(ZodError);
  expect((hook.result.current.error as ZodError).issues[0]?.path).toEqual(expectedPath);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useDashboardOverview", () => {
  it("separates cached requests when its period changes", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("period=today"))
        return Promise.resolve(jsonResponse(dashboardFixture("today")));
      if (url.endsWith("period=12w")) return Promise.resolve(jsonResponse(dashboardFixture("12w")));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { queryClient, wrapper } = createWrapper();
    const hook = renderHook(
      ({ period }: { period: DashboardPeriod }) => useDashboardOverview(period),
      {
        initialProps: { period: "today" as DashboardPeriod },
        wrapper,
      },
    );

    await waitFor(() => expect(hook.result.current.data?.dynamics.period).toBe("today"));
    hook.rerender({ period: "12w" });
    await waitFor(() => expect(hook.result.current.data?.dynamics.period).toBe("12w"));

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/dashboard/overview?period=today",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/dashboard/overview?period=12w",
      expect.any(Object),
    );
    expect(queryClient.getQueryData([...DASHBOARD_QUERY_KEY, "today"])).toBeDefined();
    expect(queryClient.getQueryData([...DASHBOARD_QUERY_KEY, "12w"])).toBeDefined();
  });

  it("rejects an overview with an unknown top-level field", async () => {
    await expectRejectedOverview({ ...dashboardFixture(), untrusted: true }, []);
  });

  it("rejects an overview with an unknown nested field", async () => {
    await expectRejectedOverview(
      { ...dashboardFixture(), today: { ...dashboardFixture().today, untrusted: true } },
      ["today"],
    );
  });

  it("rejects duplicate provenance sources", async () => {
    await expectRejectedOverview(
      {
        ...dashboardFixture(),
        dynamics: {
          ...dashboardFixture().dynamics,
          quality: {
            ...dashboardFixture().dynamics.quality,
            sources: ["boxes", "boxes", "box_items"],
          },
        },
      },
      ["dynamics", "quality", "sources"],
    );
  });

  it("rejects active aggregation output with validation metrics", async () => {
    await expectRejectedOverview(
      {
        ...dashboardFixture(),
        activeShifts: [
          {
            ...dashboardFixture().activeShifts[0],
            output: {
              mode: "aggregation",
              closedBoxes: 412,
              containedUnits: 10712,
              acceptedUnits: 128489,
            },
          },
        ],
      },
      ["activeShifts", 0, "output"],
    );
  });

  it("rejects an active shift whose identifier is not a UUID", async () => {
    await expectRejectedOverview(
      {
        ...dashboardFixture(),
        activeShifts: [{ ...dashboardFixture().activeShifts[0], id: "shift-active" }],
      },
      ["activeShifts", 0, "id"],
    );
  });

  it.each([
    ["validation", ["dynamics", "currentWindow", "validation", "unitsPerShiftHour"]],
    ["boxes", ["dynamics", "currentWindow", "aggregation", "boxesPerShiftHour"]],
    ["containedUnits", ["dynamics", "currentWindow", "aggregation", "containedUnitsPerShiftHour"]],
  ] as const)("rejects a negative %s rate from the server", async (rate, expectedPath) => {
    const response = dashboardFixture();
    if (rate === "validation") {
      response.dynamics.currentWindow.validation.unitsPerShiftHour = -0.1;
    } else if (rate === "boxes") {
      response.dynamics.currentWindow.aggregation.boxesPerShiftHour = -0.1;
    } else {
      response.dynamics.currentWindow.aggregation.containedUnitsPerShiftHour = -0.1;
    }

    await expectRejectedOverview(response, expectedPath);
  });
});

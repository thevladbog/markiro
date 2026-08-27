import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { DashboardPage } from "../src/pages/dashboard/index.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Request failed",
    headers: { "Content-Type": "application/json" },
  });
}

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider
        value={{
          roles: ["manager"],
          capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
        }}
      >
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
}

function dashboardFixture(
  setup: Partial<{ productCount: number; shiftCount: number; hasRunShift: boolean }> = {},
) {
  return {
    generatedAt: "2026-08-27T09:45:00.000Z",
    timeZone: "Europe/Moscow",
    metricVersion: "operations-dashboard-v1",
    setup: { productCount: 0, shiftCount: 0, hasRunShift: false, ...setup },
    verdict: {
      status: "needs_attention",
      reasons: [
        {
          code: "unreviewed_conflicts",
          severity: "critical",
          count: 1,
          route: "/conflicts",
          affectedModes: ["validation", "aggregation"],
        },
      ],
    },
    today: {
      validationAcceptedUnits: 128489,
      aggregationClosedBoxes: 412,
      aggregationContainedUnits: 10712,
      activeShiftCount: 1,
      includedClosedShiftCount: 4,
    },
    dynamics: {
      period: "7d",
      grain: "day",
      currentWindow: {
        start: "2026-08-21T21:00:00.000Z",
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
        start: "2026-08-14T21:00:00.000Z",
        end: "2026-08-21T09:45:00.000Z",
        validation: { acceptedUnits: 102000, shiftHours: 25, unitsPerShiftHour: 4080 },
        aggregation: {
          closedBoxes: 380,
          containedUnits: 9880,
          shiftHours: 17.5,
          boxesPerShiftHour: 21.7,
          containedUnitsPerShiftHour: 564.6,
        },
      },
      buckets: [
        {
          label: "21 авг.",
          start: "2026-08-20T21:00:00.000Z",
          end: "2026-08-21T21:00:00.000Z",
          validation: { acceptedUnits: 18600, shiftHours: 4, unitsPerShiftHour: 4650 },
          aggregation: {
            closedBoxes: 58,
            containedUnits: 1508,
            shiftHours: 3.5,
            boxesPerShiftHour: 16.6,
            containedUnitsPerShiftHour: 430.9,
          },
        },
      ],
      quality: {
        status: "provisional",
        reasons: ["active_shifts", "late_data"],
        activeShiftCount: 1,
        lateDataShiftCount: 1,
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

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/dashboard/overview?period=7d")) {
        return jsonResponse(200, dashboardFixture());
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

describe("DashboardPage", () => {
  it("guides a writable organization through the first incomplete setup step", async () => {
    renderDashboard();

    expect(await screen.findByRole("heading", { name: "Подготовьте первую смену" })).toBeDefined();
    const action = screen.getByRole("link", { name: "Добавить продукт" });
    expect(action.getAttribute("href")).toBe("/catalog");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toMatch(
      /\/api\/dashboard\/overview\?period=7d$/,
    );
  });

  it("keeps the setup action on shift planning when the server reports products but no shifts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, dashboardFixture({ productCount: 1, shiftCount: 0 }))),
    );

    renderDashboard();

    expect(
      (await screen.findByRole("link", { name: "Запланировать смену" })).getAttribute("href"),
    ).toBe("/shifts");
  });

  it("labels the server-provided active shift value as output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, dashboardFixture({ hasRunShift: true }))),
    );

    renderDashboard();

    expect(await screen.findByRole("columnheader", { name: "Выпуск" })).toBeDefined();
  });

  it("renders a layout-shaped loading state while the dashboard overview is unresolved", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    renderDashboard();

    expect(screen.getByRole("status", { name: "Загрузка обзора" })).toBeDefined();
    expect(screen.getAllByTestId("dashboard-skeleton-block")).toHaveLength(6);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("shows one retry action and retries only the dashboard overview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/dashboard/overview?period=7d")) {
          return jsonResponse(500, { message: "dashboard unavailable" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderDashboard();

    expect((await screen.findByRole("alert")).textContent).toContain("Не удалось загрузить обзор");
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toEqual([
      "/api/dashboard/overview?period=7d",
      "/api/dashboard/overview?period=7d",
    ]);
  });
});

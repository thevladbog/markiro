import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function renderDashboard({ canWrite = true }: { canWrite?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider
        value={{
          roles: ["manager"],
          capabilities: [
            CABINET_CAPABILITY.OPERATIONS_READ,
            ...(canWrite ? [CABINET_CAPABILITY.OPERATIONS_WRITE] : []),
          ],
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
      status: "critical",
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

  it("answers whether production is under control with separate headline facts and reasons", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, dashboardFixture({ hasRunShift: true }))),
    );

    renderDashboard();

    expect(await screen.findByRole("heading", { name: "Производство сегодня" })).toBeDefined();
    expect(screen.getByText("Europe/Moscow")).toBeDefined();
    expect(document.querySelector('time[datetime="2026-08-27T09:45:00.000Z"]')).not.toBeNull();
    expect(screen.getByText("Критическое состояние")).toBeDefined();
    expect(screen.getByRole("link", { name: /1 конфликт без разбора/ }).getAttribute("href")).toBe(
      "/conflicts",
    );

    expect(screen.getByText("Проверено поштучно")).toBeDefined();
    expect(screen.getByLabelText(/128[\s\u00a0]?489 проверенных единиц/)).toBeDefined();
    expect(screen.getByLabelText(/412 закрытых коробов/)).toBeDefined();
    expect(screen.getByLabelText(/10[\s\u00a0]?712 единиц в коробах/)).toBeDefined();
    expect(screen.queryByText(/138[\s\u00a0]?789/)).toBeNull();
    expect(
      screen.getByRole("region", {
        name: "Активные смены и смены, завершённые сегодня",
      }),
    ).toBeDefined();

    expect(screen.getByText("Предварительные данные")).toBeDefined();
    expect(screen.getByText(/Поздние данные: 1 смена/)).toBeDefined();
    expect(screen.queryByText(/качество|план|цель|простой/i)).toBeNull();
  });

  it("keeps rate and output controls independent from the selected period", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, dashboardFixture({ hasRunShift: true }))),
    );

    renderDashboard();

    const rate = await screen.findByRole("button", { name: "Темп" });
    const output = screen.getByRole("button", { name: "Выпуск" });
    const sevenDays = screen.getByRole("button", { name: "7 дней" });
    expect(rate.getAttribute("aria-pressed")).toBe("true");
    expect(output.getAttribute("aria-pressed")).toBe("false");
    expect(sevenDays.getAttribute("aria-pressed")).toBe("true");

    const validationRate = screen.getByRole("region", { name: "Проверка — темп" });
    const aggregationRate = screen.getByRole("region", { name: "Агрегация — темп" });
    expect(
      within(validationRate).getByLabelText(/21 авг\.: 4[\s\u00a0]?650 шт\.\/час смены/),
    ).toBeDefined();
    expect(
      within(aggregationRate).getByLabelText(/21 авг\.: 16,6 коробов\/час смены/),
    ).toBeDefined();
    expect(within(aggregationRate).getByLabelText(/21 авг\.: 430,9 шт\.\/час смены/)).toBeDefined();

    fireEvent.click(output);

    expect(output.getAttribute("aria-pressed")).toBe("true");
    expect(rate.getAttribute("aria-pressed")).toBe("false");
    expect(sevenDays.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("region", { name: "Проверка — выпуск" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Агрегация — выпуск" })).toBeDefined();
    expect(screen.getByLabelText(/21 авг\.: 18[\s\u00a0]?600 шт\./)).toBeDefined();
    expect(screen.getByLabelText(/21 авг\.: 58 кор\./)).toBeDefined();
    expect(screen.getByLabelText(/21 авг\.: 1[\s\u00a0]?508 шт\./)).toBeDefined();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("requests a new coherent overview when the period changes", async () => {
    const thirtyDayFixture = dashboardFixture({ hasRunShift: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/dashboard/overview?period=7d")) {
          return jsonResponse(200, dashboardFixture({ hasRunShift: true }));
        }
        if (url.endsWith("/api/dashboard/overview?period=30d")) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return jsonResponse(200, {
            ...thirtyDayFixture,
            dynamics: { ...thirtyDayFixture.dynamics, period: "30d" },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderDashboard();
    const thirtyDays = await screen.findByRole("button", { name: "30 дней" });
    fireEvent.click(screen.getByRole("button", { name: "Выпуск" }));
    fireEvent.click(thirtyDays);

    expect(screen.getByRole("status", { name: "Обновление данных" })).toBeDefined();
    expect(screen.getByRole("button", { name: "30 дней" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Выпуск" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByText(/Показана предыдущая сводка/)).toBeDefined();
    expect(screen.getByRole("link", { name: /1 конфликт без разбора/ })).toBeDefined();

    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toContain(
        "/api/dashboard/overview?period=30d",
      ),
    );

    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Обновление данных" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "30 дней" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Выпуск" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("discloses fetching when returning to a cached period until fresh data swaps atomically", async () => {
    const initialFixture = dashboardFixture({ hasRunShift: true });
    const thirtyDayFixture = {
      ...initialFixture,
      generatedAt: "2026-08-27T10:00:00.000Z",
      today: { ...initialFixture.today, validationAcceptedUnits: 30000 },
      dynamics: { ...initialFixture.dynamics, period: "30d" },
    };
    const refreshedFixture = {
      ...initialFixture,
      generatedAt: "2026-08-27T10:15:00.000Z",
      today: { ...initialFixture.today, validationAcceptedUnits: 128490 },
    };
    let sevenDayRequestCount = 0;
    let resolveRevisit!: (response: Response) => void;
    const revisitResponse = new Promise<Response>((resolve) => {
      resolveRevisit = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/dashboard/overview?period=7d")) {
          sevenDayRequestCount += 1;
          return sevenDayRequestCount === 1 ? jsonResponse(200, initialFixture) : revisitResponse;
        }
        if (url.endsWith("/api/dashboard/overview?period=30d")) {
          return jsonResponse(200, thirtyDayFixture);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderDashboard();
    const sevenDays = await screen.findByRole("button", { name: "7 дней" });
    fireEvent.click(screen.getByRole("button", { name: "30 дней" }));
    expect(await screen.findByLabelText(/30[\s\u00a0]?000 проверенных единиц/)).toBeDefined();

    fireEvent.click(sevenDays);

    expect(screen.getByRole("status", { name: "Обновление данных" })).toBeDefined();
    expect(screen.getByLabelText(/128[\s\u00a0]?489 проверенных единиц/)).toBeDefined();
    expect(screen.queryByLabelText(/128[\s\u00a0]?490 проверенных единиц/)).toBeNull();

    resolveRevisit(jsonResponse(200, refreshedFixture));

    expect(await screen.findByLabelText(/128[\s\u00a0]?490 проверенных единиц/)).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Обновление данных" })).toBeNull(),
    );
    expect(screen.queryByLabelText(/128[\s\u00a0]?489 проверенных единиц/)).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("keeps ordinary empty production distinct from an insufficient rate", async () => {
    const fixture = dashboardFixture({ hasRunShift: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ...fixture,
          verdict: {
            status: "needs_attention",
            reasons: [
              {
                code: "missing_shift_duration",
                severity: "needs_attention",
                count: 1,
                affectedModes: ["aggregation"],
              },
            ],
          },
          dynamics: {
            ...fixture.dynamics,
            buckets: [
              {
                ...fixture.dynamics.buckets[0],
                validation: { acceptedUnits: 0, shiftHours: 0, unitsPerShiftHour: null },
                aggregation: {
                  closedBoxes: 12,
                  containedUnits: 300,
                  shiftHours: 0,
                  boxesPerShiftHour: null,
                  containedUnitsPerShiftHour: null,
                },
              },
            ],
            quality: {
              ...fixture.dynamics.quality,
              status: "insufficient",
              reasons: ["missing_shift_duration"],
              activeShiftCount: 0,
              lateDataShiftCount: 0,
            },
          },
        }),
      ),
    );

    renderDashboard();

    const validation = await screen.findByRole("region", { name: "Проверка — темп" });
    const aggregation = screen.getByRole("region", { name: "Агрегация — темп" });
    expect(
      within(validation).getByText("За выбранный период проверенных единиц нет."),
    ).toBeDefined();
    expect(within(aggregation).getAllByRole("img", { name: /—/ })).toHaveLength(2);
    expect(
      within(aggregation).getByText("Нет длительности смены — темп не рассчитан."),
    ).toBeDefined();
    expect(screen.getByText("Недостаточно данных для темпа")).toBeDefined();
  });

  it("renders eligible numeric zero rates safely when every chart value is zero", async () => {
    const fixture = dashboardFixture({ hasRunShift: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ...fixture,
          dynamics: {
            ...fixture.dynamics,
            currentWindow: {
              ...fixture.dynamics.currentWindow,
              validation: { acceptedUnits: 0, shiftHours: 4, unitsPerShiftHour: 0 },
              aggregation: {
                closedBoxes: 0,
                containedUnits: 0,
                shiftHours: 3.5,
                boxesPerShiftHour: 0,
                containedUnitsPerShiftHour: 0,
              },
            },
            buckets: [
              {
                ...fixture.dynamics.buckets[0],
                validation: { acceptedUnits: 0, shiftHours: 4, unitsPerShiftHour: 0 },
                aggregation: {
                  closedBoxes: 0,
                  containedUnits: 0,
                  shiftHours: 3.5,
                  boxesPerShiftHour: 0,
                  containedUnitsPerShiftHour: 0,
                },
              },
            ],
            quality: {
              ...fixture.dynamics.quality,
              status: "complete",
              reasons: [],
              activeShiftCount: 0,
              lateDataShiftCount: 0,
            },
          },
        }),
      ),
    );

    renderDashboard();

    const validation = await screen.findByRole("region", { name: "Проверка — темп" });
    const aggregation = screen.getByRole("region", { name: "Агрегация — темп" });
    const zeroValidationBar = within(validation).getByRole("img", {
      name: /21 авг\.: 0 шт\.\/час смены/,
    });
    expect(zeroValidationBar.className).not.toContain("track--missing");
    expect(
      zeroValidationBar
        .querySelector<HTMLElement>(".mk-dashboard-bars__bar")
        ?.style.getPropertyValue("--mk-dashboard-bar-scale"),
    ).toBe("0");
    expect(within(aggregation).getAllByRole("img", { name: /21 авг\.: 0/ })).toHaveLength(2);
    expect(screen.queryAllByRole("img", { name: /—/ })).toHaveLength(0);
    expect(screen.queryByText("Нет длительности смены — темп не рассчитан.")).toBeNull();
  });

  it("links active shifts by access level and formats mode-specific output", async () => {
    const fixture = dashboardFixture({ hasRunShift: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, fixture)),
    );

    renderDashboard();

    const shiftLink = await screen.findByRole("link", { name: "S-2026-08-27-001" });
    expect(shiftLink.getAttribute("href")).toBe(
      "/shifts/11111111-1111-4111-8111-111111111111/edit",
    );
    expect(screen.getByText(/412 кор\. · 10[\s\u00a0]?712 шт\./)).toBeDefined();
    const scrollRegion = screen.getByRole("region", { name: "Активные производственные смены" });
    expect(scrollRegion.getAttribute("tabindex")).toBe("0");

    cleanup();
    renderDashboard({ canWrite: false });
    expect(
      (await screen.findByRole("link", { name: "S-2026-08-27-001" })).getAttribute("href"),
    ).toBe("/shifts");
  });

  it("does not mark an empty active-shift section as provisional", async () => {
    const fixture = dashboardFixture({ hasRunShift: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ...fixture,
          today: { ...fixture.today, activeShiftCount: 0 },
          dynamics: {
            ...fixture.dynamics,
            quality: {
              ...fixture.dynamics.quality,
              status: "complete",
              reasons: [],
              activeShiftCount: 0,
              lateDataShiftCount: 0,
            },
          },
          activeShifts: [],
        }),
      ),
    );

    renderDashboard();

    expect(await screen.findByText("Сейчас нет активных смен.")).toBeDefined();
    expect(screen.getByText("Данные полные")).toBeDefined();
    expect(screen.queryByText("Предварительно")).toBeNull();
  });

  it("formats validation shift output in its own unit", async () => {
    const fixture = dashboardFixture({ hasRunShift: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ...fixture,
          activeShifts: [
            {
              ...fixture.activeShifts[0],
              output: { mode: "validation", acceptedUnits: 128489 },
            },
          ],
        }),
      ),
    );

    renderDashboard();

    expect(await screen.findByText(/128[\s\u00a0]?489 шт\./)).toBeDefined();
    expect(screen.queryByText(/128[\s\u00a0]?489 кор\./)).toBeNull();
  });

  it("provides the mode-separated production vocabulary in English", async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, dashboardFixture({ hasRunShift: true }))),
    );

    renderDashboard();

    expect(await screen.findByRole("heading", { name: "Production today" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Validation — rate" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Aggregation — rate" })).toBeDefined();
    expect(screen.getAllByLabelText(/units\/shift hour/).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText(/boxes\/shift hour/).length).toBeGreaterThan(0);
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

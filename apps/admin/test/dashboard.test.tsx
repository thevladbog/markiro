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
          label: "2026-08-21",
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
    const validationBar = within(validationRate).getByLabelText(
      /21\.08\.2026: 4[\s\u00a0]?650 шт\.\/час смены/,
    );
    expect(validationBar).toBeDefined();
    expect(validationBar.getAttribute("tabindex")).toBe("0");
    fireEvent.mouseEnter(validationBar);
    const hoverTooltip = screen.getByRole("tooltip");
    expect(hoverTooltip.textContent).toMatch(/21\.08\.2026: 4[\s\u00a0]?650 шт\.\/час смены/);
    fireEvent.mouseLeave(validationBar);
    fireEvent.mouseEnter(hoverTooltip);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.getByRole("tooltip")).toBe(hoverTooltip);
    const focusBeforeMouseEscape = document.activeElement;
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(document.activeElement).toBe(focusBeforeMouseEscape);

    fireEvent.mouseEnter(validationBar);
    const dismissibleHoverTooltip = screen.getByRole("tooltip");
    fireEvent.mouseLeave(validationBar);
    fireEvent.mouseEnter(dismissibleHoverTooltip);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.getByRole("tooltip")).toBe(dismissibleHoverTooltip);
    fireEvent.mouseLeave(dismissibleHoverTooltip);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    validationBar.blur();
    validationBar.focus();
    fireEvent.focus(validationBar);
    expect(screen.getByRole("tooltip").textContent).toMatch(
      /21\.08\.2026: 4[\s\u00a0]?650 шт\.\/час смены/,
    );
    expect(document.activeElement).toBe(validationBar);
    fireEvent.keyDown(validationBar, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(document.activeElement).toBe(validationBar);
    expect(
      within(aggregationRate).getByLabelText(/21\.08\.2026: 16,6 коробов\/час смены/),
    ).toBeDefined();
    expect(
      within(aggregationRate).getByLabelText(/21\.08\.2026: 430,9 шт\.\/час смены/),
    ).toBeDefined();

    expect(
      [...validationRate.querySelectorAll(".mk-dashboard-bars__label")].map(
        (label) => label.textContent,
      ),
    ).toEqual(["21"]);

    fireEvent.click(output);

    expect(output.getAttribute("aria-pressed")).toBe("true");
    expect(rate.getAttribute("aria-pressed")).toBe("false");
    expect(sevenDays.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("region", { name: "Проверка — выпуск" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Агрегация — выпуск" })).toBeDefined();
    expect(screen.getByLabelText(/21\.08\.2026: 18[\s\u00a0]?600 шт\./)).toBeDefined();
    expect(screen.getByLabelText(/21\.08\.2026: 58 кор\./)).toBeDefined();
    expect(screen.getByLabelText(/21\.08\.2026: 1[\s\u00a0]?508 шт\./)).toBeDefined();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("uses compact context-aware dates while keeping complete dates for chart accessibility", async () => {
    const fixture = dashboardFixture({ hasRunShift: true });
    const firstBucket = fixture.dynamics.buckets[0];
    const buckets = Array.from({ length: 30 }, (_, index) => {
      const start = new Date(Date.UTC(2026, 6, 30 + index));
      const end = new Date(Date.UTC(2026, 6, 31 + index));
      return {
        ...firstBucket,
        label: start.toISOString().slice(0, 10),
        start: start.toISOString(),
        end: end.toISOString(),
      };
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ...fixture,
          dynamics: { ...fixture.dynamics, period: "30d", buckets },
        }),
      ),
    );

    renderDashboard();

    const validation = await screen.findByRole("region", { name: "Проверка — темп" });
    const labels = [...validation.querySelectorAll(".mk-dashboard-bars__label")].map(
      (label) => label.textContent,
    );
    expect(labels[0]).toBe("30.07");
    expect(labels[2]).toBe("01.08");
    expect(labels).not.toContain("2026-07-30");
    expect(within(validation).getByLabelText(/30\.07\.2026:/)).toBeDefined();
    expect(within(validation).getByLabelText(/01\.08\.2026:/)).toBeDefined();
    expect(validation.querySelectorAll(".mk-dashboard-bars__value")).toHaveLength(0);
  });

  it("uses dense labels and one keyboard stop per series across twelve weeks", async () => {
    const fixture = dashboardFixture({ hasRunShift: true });
    const firstBucket = fixture.dynamics.buckets[0];
    if (!firstBucket) throw new Error("Expected a dashboard bucket fixture");
    const buckets = Array.from({ length: 12 }, (_, index) => {
      const start = new Date(Date.UTC(2026, 5, 1 + index * 7));
      const end = new Date(Date.UTC(2026, 5, 8 + index * 7));
      return {
        ...firstBucket,
        label: start.toISOString().slice(0, 10),
        start: start.toISOString(),
        end: end.toISOString(),
        validation: {
          ...firstBucket.validation,
          acceptedUnits: 18600 + index * 1000,
        },
      };
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ...fixture,
          dynamics: { ...fixture.dynamics, period: "12w", grain: "week", buckets },
        }),
      ),
    );

    renderDashboard();

    const validation = await screen.findByRole("region", { name: "Проверка — темп" });
    expect(validation.querySelectorAll(".mk-dashboard-bars__value")).toHaveLength(0);
    const visibleLabelIndexes = [
      ...validation.querySelectorAll(".mk-dashboard-bars__label"),
    ].flatMap((label, index) =>
      label.classList.contains("mk-dashboard-bars__label--hidden") ? [] : [index],
    );
    expect(
      visibleLabelIndexes.every(
        (index, position) =>
          position === 0 || index - (visibleLabelIndexes[position - 1] ?? 0) >= 2,
      ),
    ).toBe(true);
    const bars = within(validation).getAllByRole("img");
    expect(bars.filter((bar) => bar.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(bars.filter((bar) => bar.getAttribute("tabindex") === "-1")).toHaveLength(11);

    fireEvent.focus(bars[0] as HTMLElement);
    expect(screen.getByRole("tooltip").textContent).toContain("01.06.2026");
    fireEvent.keyDown(bars[0] as HTMLElement, { key: "ArrowRight" });
    expect(document.activeElement).toBe(bars[1]);
    expect(screen.getByRole("tooltip").textContent).toContain("08.06.2026");
  });

  it("adds the year to axis dates when the selected range crosses a year boundary", async () => {
    const fixture = dashboardFixture({ hasRunShift: true });
    const firstBucket = fixture.dynamics.buckets[0];
    const starts = ["2025-12-30T21:00:00.000Z", "2025-12-31T21:00:00.000Z"];
    const buckets = starts.map((start, index) => ({
      ...firstBucket,
      label: start.slice(0, 10),
      start,
      end: index === 0 ? starts[1] : "2026-01-01T21:00:00.000Z",
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ...fixture,
          dynamics: { ...fixture.dynamics, period: "30d", buckets },
        }),
      ),
    );

    renderDashboard();

    const validation = await screen.findByRole("region", { name: "Проверка — темп" });
    expect(
      [...validation.querySelectorAll(".mk-dashboard-bars__label")].map(
        (label) => label.textContent,
      ),
    ).toEqual(["31.12.2025", "01.01.2026"]);
  });

  it("shows only contextual year-boundary labels in a seven-day range", async () => {
    const fixture = dashboardFixture({ hasRunShift: true });
    const firstBucket = fixture.dynamics.buckets[0];
    const starts = Array.from(
      { length: 7 },
      (_, index) => new Date(Date.UTC(2025, 11, 28 + index, 21)),
    );
    const buckets = starts.map((start, index) => ({
      ...firstBucket,
      label: start.toISOString().slice(0, 10),
      start: start.toISOString(),
      end: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      validation: {
        ...firstBucket?.validation,
        acceptedUnits: 18600 + index * 1000,
      },
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ...fixture,
          dynamics: { ...fixture.dynamics, period: "7d", grain: "day", buckets },
        }),
      ),
    );

    renderDashboard();

    const validation = await screen.findByRole("region", { name: "Проверка — темп" });
    const visibleLabels = [
      ...validation.querySelectorAll(
        ".mk-dashboard-bars__label:not(.mk-dashboard-bars__label--hidden)",
      ),
    ].map((label) => label.textContent);
    expect(visibleLabels).toEqual(["29.12.2025", "01.01.2026", "04.01.2026"]);
    expect(within(validation).getByLabelText(/31\.12\.2025:/)).toBeDefined();
    expect(within(validation).getByLabelText(/01\.01\.2026:/)).toBeDefined();
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
    const refreshSlot = await waitFor(() => {
      const slot = document.querySelector(".mk-dashboard-dynamics__refresh-slot");
      expect(slot).not.toBeNull();
      return slot;
    });
    expect(within(refreshSlot as HTMLElement).queryByRole("status")).toBeNull();
    const thirtyDays = await screen.findByRole("button", { name: "30 дней" });
    fireEvent.click(screen.getByRole("button", { name: "Выпуск" }));
    fireEvent.click(thirtyDays);

    const refreshing = screen.getByRole("status", { name: "Обновление данных" });
    expect(refreshing.closest(".mk-dashboard-dynamics__refresh-slot")).toBe(refreshSlot);
    expect(refreshing.closest('[aria-busy="true"]')).toBeNull();
    expect(
      screen.getByRole("region", { name: "Проверка — выпуск" }).getAttribute("aria-busy"),
    ).toBe("true");
    expect(document.querySelector(".mk-dashboard-page > .mk-dashboard-refreshing")).toBeNull();
    expect(screen.getByRole("button", { name: "7 дней" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "30 дней" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByRole("button", { name: "Выпуск" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
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
    expect(document.querySelector(".mk-dashboard-dynamics__refresh-slot")).toBe(refreshSlot);
    expect(
      screen.getByRole("region", { name: "Проверка — выпуск" }).getAttribute("aria-busy"),
    ).toBe("false");
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

  it.each([
    {
      language: "ru",
      rateButton: "Темп",
      outputButton: "Выпуск",
      rateRegion: "Агрегация — темп",
      outputRegion: "Агрегация — выпуск",
      containedEmpty: "За выбранный период единиц в закрытых коробах нет.",
      boxesEmpty: "За выбранный период закрытых коробов нет.",
    },
    {
      language: "en",
      rateButton: "Rate",
      outputButton: "Output",
      rateRegion: "Aggregation — rate",
      outputRegion: "Aggregation — output",
      containedEmpty: "No units are contained in closed boxes for the selected period.",
      boxesEmpty: "No boxes were closed in the selected period.",
    },
  ])(
    "describes boxes-positive contained-unit zeroes accurately in $language rate and output views",
    async ({
      language,
      rateButton,
      outputButton,
      rateRegion,
      outputRegion,
      containedEmpty,
      boxesEmpty,
    }) => {
      await i18n.changeLanguage(language);
      const fixture = dashboardFixture({ hasRunShift: true });
      const aggregation = {
        closedBoxes: 12,
        containedUnits: 0,
        shiftHours: 4,
        boxesPerShiftHour: 3,
        containedUnitsPerShiftHour: 0,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(200, {
            ...fixture,
            dynamics: {
              ...fixture.dynamics,
              currentWindow: { ...fixture.dynamics.currentWindow, aggregation },
              comparisonWindow: { ...fixture.dynamics.comparisonWindow, aggregation },
              buckets: fixture.dynamics.buckets.map((bucket) => ({ ...bucket, aggregation })),
            },
          }),
        ),
      );

      renderDashboard();

      expect(await screen.findByRole("button", { name: rateButton })).toBeDefined();
      const rateAggregation = screen.getByRole("region", { name: rateRegion });
      expect(within(rateAggregation).getByText(containedEmpty)).toBeDefined();
      expect(within(rateAggregation).queryByText(boxesEmpty)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: outputButton }));

      const outputAggregation = screen.getByRole("region", { name: outputRegion });
      expect(within(outputAggregation).getByText(containedEmpty)).toBeDefined();
      expect(within(outputAggregation).queryByText(boxesEmpty)).toBeNull();
    },
  );

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
      name: /21\.08\.2026: 0 шт\.\/час смены/,
    });
    expect(zeroValidationBar.className).not.toContain("track--missing");
    expect(
      zeroValidationBar
        .querySelector<HTMLElement>(".mk-dashboard-bars__bar")
        ?.style.getPropertyValue("--mk-dashboard-bar-scale"),
    ).toBe("0");
    expect(within(aggregation).getAllByRole("img", { name: /21\.08\.2026: 0/ })).toHaveLength(2);
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

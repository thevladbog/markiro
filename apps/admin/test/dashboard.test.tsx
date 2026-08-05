import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { DashboardPage } from "../src/pages/dashboard/index.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Request failed",
    json: async () => body,
  } as Response;
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

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url.endsWith("/api/products") ||
        url.endsWith("/api/shifts") ||
        url.endsWith("/api/lines") ||
        url.endsWith("/api/conflicts?reviewed=false")
      ) {
        return jsonResponse(200, { items: [] });
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
    expect(screen.queryByText("Пока нет данных")).toBeNull();
  });

  it("renders a layout-shaped loading state while dashboard data is unresolved", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    renderDashboard();

    expect(screen.getByRole("status", { name: "Загрузка обзора" })).toBeDefined();
    expect(screen.getAllByTestId("dashboard-skeleton-block")).toHaveLength(6);
  });

  it("shows one retry action when any dashboard source fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/products")) {
          return jsonResponse(500, { message: "catalog unavailable" });
        }
        return jsonResponse(200, { items: [] });
      }),
    );

    renderDashboard();

    expect((await screen.findByRole("alert")).textContent).toContain("Не удалось загрузить обзор");
    expect(screen.getByRole("button", { name: "Повторить" })).toBeDefined();
  });

  it("prioritizes attention, live shifts, and upcoming work using real API records", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/products")) {
          return jsonResponse(200, {
            items: [
              {
                id: "product-ready",
                gtin14: "04650075195923",
                name: "Вода газированная 1,0 л",
                productGroup: "water",
                boxCapacity: 12,
                palletCapacity: 60,
                unitPrice: null,
                egaisCode: null,
                externalRef: null,
                status: "active",
                defaultCounterpartyId: null,
                defaultLabelTemplateId: null,
                createdAt: "2026-08-01T08:00:00.000Z",
              },
              {
                id: "product-draft",
                gtin14: "04650075196012",
                name: "Квас традиционный 1,5 л",
                productGroup: null,
                boxCapacity: null,
                palletCapacity: null,
                unitPrice: null,
                egaisCode: null,
                externalRef: null,
                status: "draft",
                defaultCounterpartyId: null,
                defaultLabelTemplateId: null,
                createdAt: "2026-08-02T08:00:00.000Z",
              },
            ],
          });
        }
        if (url.endsWith("/api/shifts")) {
          return jsonResponse(200, {
            items: [
              shiftFixture({
                id: "shift-active",
                status: "active",
                productId: "product-ready",
                productName: "Вода газированная 1,0 л",
                lineId: "line-2",
                lineName: null,
                plannedQty: 12400,
                openedAt: "2026-08-05T10:00:00.000Z",
              }),
              shiftFixture({
                id: "shift-planned",
                status: "planned",
                productId: "product-draft",
                productName: "Квас традиционный 1,5 л",
                lineId: "line-2",
                lineName: null,
                plannedQty: 8000,
                plannedDate: "2026-08-06",
              }),
            ],
          });
        }
        if (url.endsWith("/api/lines")) {
          return jsonResponse(200, {
            items: [{ id: "line-2", name: "Линия 2", createdAt: "2026-08-01T08:00:00.000Z" }],
          });
        }
        if (url.endsWith("/api/conflicts?reviewed=false")) {
          return jsonResponse(200, {
            items: [
              {
                id: "conflict-1",
                codeHash: "hash",
                losingShiftId: "shift-active",
                losingTerminalId: "terminal-1",
                losingScannedAt: "2026-08-05T10:30:00.000Z",
                winningShiftId: "shift-other",
                winningTerminalId: "terminal-2",
                winningScannedAt: "2026-08-05T10:29:00.000Z",
                detectedAt: "2026-08-05T10:31:00.000Z",
                reviewedAt: null,
              },
            ],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderDashboard();

    expect(await screen.findByRole("heading", { name: "Требует внимания" })).toBeDefined();
    expect(screen.getByRole("link", { name: "1 конфликт без разбора" }).getAttribute("href")).toBe(
      "/conflicts",
    );
    expect(screen.getByRole("link", { name: "1 черновик продукта" }).getAttribute("href")).toBe(
      "/catalog",
    );
    expect(screen.getByLabelText("Активные смены: 1")).toBeDefined();
    expect(screen.getByLabelText("Запланировано: 1")).toBeDefined();
    expect(screen.getByLabelText("Готовые продукты: 1")).toBeDefined();
    expect(screen.getByLabelText("Конфликты без разбора: 1")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Смены прямо сейчас" })).toBeDefined();
    expect(screen.getByText("Вода газированная 1,0 л")).toBeDefined();
    expect(screen.getAllByText("Линия 2").length).toBeGreaterThan(0);
    expect(screen.getByText(/12\s400/)).toBeDefined();
    expect(screen.getByRole("heading", { name: "Ближайшие смены" })).toBeDefined();
    expect(screen.getByText("Квас традиционный 1,5 л")).toBeDefined();
  });

  it("keeps full summary counts while limiting detailed work lists to five rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/shifts")) {
          return jsonResponse(200, {
            items: [
              ...Array.from({ length: 6 }, (_, index) =>
                shiftFixture({
                  id: `active-${index}`,
                  status: "active",
                  productName: `Активный продукт ${index}`,
                  openedAt: "2026-08-05T10:00:00.000Z",
                }),
              ),
              ...Array.from({ length: 6 }, (_, index) =>
                shiftFixture({
                  id: `planned-${index}`,
                  status: "planned",
                  productName: `Плановый продукт ${index}`,
                  plannedDate: "2026-08-06",
                }),
              ),
            ],
          });
        }
        if (
          url.endsWith("/api/products") ||
          url.endsWith("/api/lines") ||
          url.endsWith("/api/conflicts?reviewed=false")
        ) {
          return jsonResponse(200, { items: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderDashboard();

    expect(await screen.findByLabelText("Активные смены: 6")).toBeDefined();
    expect(screen.getByLabelText("Запланировано: 6")).toBeDefined();
    expect(screen.getAllByRole("row")).toHaveLength(6);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });
});

function shiftFixture(
  overrides: Partial<{
    id: string;
    status: "planned" | "active" | "closed";
    productId: string;
    productName: string | null;
    lineId: string | null;
    lineName: string | null;
    plannedQty: number | null;
    plannedDate: string | null;
    openedAt: string | null;
  }>,
) {
  return {
    id: "shift-1",
    status: "planned",
    mode: "aggregation",
    productId: "product-1",
    productName: "Продукт",
    lineId: null,
    lineName: null,
    counterpartyId: null,
    counterpartyName: null,
    labelTemplateId: null,
    labelTemplateName: null,
    ssccIssuerCounterpartyId: null,
    boxLabelTemplateId: null,
    plannedQty: null,
    plannedDate: null,
    boxCapacity: 12,
    palletCapacity: 60,
    palletsEnabled: true,
    createdFrom: "admin",
    openedAt: null,
    closedAt: null,
    lateDataAt: null,
    closeReason: null,
    createdAt: "2026-08-05T08:00:00.000Z",
    ...overrides,
  };
}

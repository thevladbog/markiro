import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import type { ShiftDto } from "../src/pages/shifts/api.js";
import { ShiftsPage } from "../src/pages/shifts/index.js";
import { ShiftPanelRoute } from "../src/pages/shifts/ShiftPanelRoute.js";

const ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const PRODUCT = {
  id: "p1",
  gtin14: "04006381333931",
  name: "Молоко 1л",
  productGroup: null,
  chzProductGroupCode: null,
  boxCapacity: 12,
  palletCapacity: 48,
  status: "active",
  defaultCounterpartyId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const SHIFT: ShiftDto = {
  id: "s1",
  number: "AUG26-001",
  status: "planned",
  mode: "validation",
  productId: "p1",
  productName: "Молоко 1л",
  lineId: null,
  lineName: null,
  counterpartyId: null,
  counterpartyName: null,
  ssccIssuerCounterpartyId: null,
  boxLabelTemplateId: null,
  plannedQty: 500,
  plannedDate: "2026-08-06",
  productionDate: null,
  boxCapacity: null,
  palletCapacity: null,
  palletsEnabled: false,
  createdFrom: "admin",
  openedAt: null,
  closedAt: null,
  lateDataAt: null,
  closeReason: null,
  createdAt: "2026-08-01T00:00:00.000Z",
};

const PLANNING_CONFIG = {
  defaultBoxLabelTemplateId: null,
};

const EXPORT_FORMAT = {
  id: "shift_txt_flat",
  version: 1,
  label: "[TXT][Без коробов] Отчет смены",
  extension: "txt",
  mimeType: "text/plain; charset=utf-8",
  boxMode: "flat",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubDependencies(shifts = [SHIFT], createError?: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST" && createError) {
        return jsonResponse(409, { message: createError });
      }
      if (path === "/api/shifts/planning-config") return jsonResponse(200, PLANNING_CONFIG);
      if (path === "/api/shifts/s1/summary") {
        return jsonResponse(200, {
          generatedAt: "2026-09-02T09:00:00.000Z",
          output: { mode: "validation", acceptedUnits: 128 },
          participants: [
            {
              employeeId: "10000000-0000-4000-8000-000000000001",
              fullName: "Анна Соколова",
              role: "Оператор линии",
              firstActivityAt: "2026-09-02T06:00:00.000Z",
              lastActivityAt: "2026-09-02T08:45:00.000Z",
              acceptedScans: 128,
              closedBoxes: 0,
            },
          ],
          unattributed: { eventCount: 2, acceptedScans: 2, closedBoxes: 0 },
        });
      }
      if (path === "/api/shift-exports/formats") return jsonResponse(200, [EXPORT_FORMAT]);
      if (path === "/api/shifts/s1/exports") return jsonResponse(200, []);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: shifts });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT] });
      return jsonResponse(200, { items: [] });
    }),
  );
}

function renderPanel(initialEntries: string[]) {
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route path="/shifts" element={<ShiftsPage />}>
        <Route path="new" element={<ShiftPanelRoute mode="create" />} />
        <Route path=":shiftId" element={<ShiftPanelRoute mode="details" />} />
        <Route path=":shiftId/edit" element={<ShiftPanelRoute mode="edit" />} />
      </Route>,
    ),
    { initialEntries, initialIndex: initialEntries.length - 1 },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <AccessProvider value={ACCESS}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { router, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps the shift list mounted behind a nested create route", async () => {
  stubDependencies();
  const { router, user } = renderPanel(["/shifts"]);

  await user.click(await screen.findByRole("button", { name: "Запланировать смену" }));

  expect(router.state.location.pathname).toBe("/shifts/new");
  expect(screen.getAllByText("Молоко 1л").length).toBeGreaterThan(0);
  expect(screen.getByRole("dialog", { name: "Новая смена" })).toBeDefined();
});

it("opens route-backed shift details with output, factual employees, and unattributed warning", async () => {
  stubDependencies();
  const { router, user } = renderPanel(["/shifts"]);

  await user.click(await screen.findByRole("button", { name: "Подробнее" }));

  expect(router.state.location.pathname).toBe("/shifts/s1");
  const panel = screen.getByRole("dialog", { name: "Смена AUG26-001" });
  expect(within(panel).getByText("Результат смены")).toBeDefined();
  expect(within(panel).getAllByText("128")).toHaveLength(2);
  expect(within(panel).getByText("Анна Соколова")).toBeDefined();
  expect(within(panel).getByText("Оператор линии")).toBeDefined();
  expect(within(panel).getByText(/2 операции без указанного сотрудника/)).toBeDefined();
  expect(within(panel).getByRole("button", { name: "Изменить" })).toBeDefined();
});

it("shows report ordering and history inside a closed shift drawer", async () => {
  stubDependencies([
    {
      ...SHIFT,
      status: "closed",
      openedAt: "2026-08-06T06:00:00.000Z",
      closedAt: "2026-08-06T14:00:00.000Z",
      closeReason: "Смена завершена",
    },
  ]);
  const { user } = renderPanel(["/shifts"]);

  await user.click(await screen.findByRole("button", { name: "Подробнее" }));

  const panel = screen.getByRole("dialog", { name: "Смена AUG26-001" });
  expect(await within(panel).findByRole("radio", { name: EXPORT_FORMAT.label })).toBeDefined();
  expect(within(panel).getByRole("button", { name: "Сформировать отчет" })).toBeDefined();
  expect(within(panel).getByText("Отчеты для этой смены еще не формировались.")).toBeDefined();
});

it("falls back to the shift list when a directly entered panel closes", async () => {
  stubDependencies([]);
  const { router } = renderPanel(["/shifts/new"]);

  fireEvent.click(await screen.findByRole("button", { name: "Закрыть" }));

  await waitFor(() => expect(router.state.location.pathname).toBe("/shifts"));
});

it("shows a not-found state instead of a blank edit form", async () => {
  stubDependencies();
  renderPanel(["/shifts/missing/edit"]);

  expect(await screen.findByText("Смена не найдена")).toBeDefined();
  expect(screen.queryByLabelText("Плановое количество, шт")).toBeNull();
});

it("keeps the create panel open and shows the server message after a conflict", async () => {
  stubDependencies([], "A shift already exists for this production slot");
  const { router, user } = renderPanel(["/shifts/new"]);

  const product = await screen.findByRole("combobox", { name: "Продукт" });
  fireEvent.click(product);
  fireEvent.click(await screen.findByRole("option", { name: "Молоко 1л" }));
  await user.click(screen.getByRole("button", { name: "Запланировать" }));

  const panel = screen.getByRole("dialog", { name: "Новая смена" });
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toContain("A shift already exists for this production slot");
  expect(router.state.location.pathname).toBe("/shifts/new");
});

it("keeps the panel loading until the planning configuration and templates resolve", async () => {
  let resolvePlanningConfig: ((response: Response) => void) | undefined;
  const planningConfigResponse = new Promise<Response>((resolve) => {
    resolvePlanningConfig = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/shifts/planning-config") return planningConfigResponse;
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT] });
      return jsonResponse(200, { items: [] });
    }),
  );
  renderPanel(["/shifts/new"]);

  expect(await screen.findByRole("status")).toBeDefined();
  expect(screen.queryByText("Использовать настройку организации — Не настроен")).toBeNull();

  resolvePlanningConfig?.(jsonResponse(200, PLANNING_CONFIG));
  expect(await screen.findByLabelText("Шаблон этикетки короба")).toBeDefined();
});

it("loads shift planning for a manager without requesting the protected organisation profile", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url);
      requests.push(path);
      if (path === "/api/shifts/planning-config") {
        return jsonResponse(200, PLANNING_CONFIG);
      }
      if (path === "/api/org/profile") {
        return jsonResponse(403, { message: "Forbidden resource" });
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT] });
      return jsonResponse(200, { items: [] });
    }),
  );

  renderPanel(["/shifts/new"]);

  expect(await screen.findByLabelText("Шаблон этикетки короба")).toBeDefined();
  expect(requests).toContain("/api/shifts/planning-config");
  expect(requests).not.toContain("/api/org/profile");
});

it("blocks Back after a planning field changes until discard", async () => {
  stubDependencies([]);
  const { router, user } = renderPanel(["/shifts", "/shifts/new"]);

  fireEvent.change(await screen.findByLabelText("Плановое количество, шт"), {
    target: { value: "100" },
  });
  await router.navigate(-1);

  expect(router.state.location.pathname).toBe("/shifts/new");
  await user.click(await screen.findByRole("button", { name: "Не сохранять" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/shifts"));
});

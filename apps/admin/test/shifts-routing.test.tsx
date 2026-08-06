import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
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
  boxCapacity: 12,
  palletCapacity: 48,
  status: "active",
  defaultCounterpartyId: null,
  defaultLabelTemplateId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const SHIFT = {
  id: "s1",
  status: "planned",
  mode: "validation",
  productId: "p1",
  productName: "Молоко 1л",
  lineId: null,
  lineName: null,
  counterpartyId: null,
  counterpartyName: null,
  labelTemplateId: null,
  ssccIssuerCounterpartyId: null,
  boxLabelTemplateId: null,
  plannedQty: 500,
  plannedDate: "2026-08-06",
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubDependencies(shifts = [SHIFT]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url);
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

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider, RequireCapability } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { DevicesPage } from "../src/pages/devices/index.js";
import { KioskPairingPanelRoute } from "../src/pages/kiosks/KioskPairingPanelRoute.js";
import { KioskCreatePanelRoute, KioskEditPanelRoute } from "../src/pages/kiosks/KioskPanelRoute.js";
import { jsonResponse } from "./helpers/http.js";

vi.mock("../src/layout/useActiveOrg.js", () => ({
  useActiveOrg: () => ({ orgId: "org-1", orgName: "Factory" }),
}));

const FULL_ACCESS: AccessDocument = {
  roles: ["admin"],
  capabilities: [
    CABINET_CAPABILITY.OPERATIONS_READ,
    CABINET_CAPABILITY.OPERATIONS_WRITE,
    CABINET_CAPABILITY.CREDENTIALS_MANAGE,
  ],
};

const KIOSK = {
  id: "k1",
  name: "Касса у входа",
  location: "Зал 1",
  dayLimitPerEmployee: 5,
  showPrices: true,
  printEmployeeQrOnSlip: false,
  status: "active" as const,
  lastSeenAt: null,
  enrolled: false,
  productIds: [],
  createdAt: "2026-08-06T00:00:00.000Z",
};

const DEVICE_ROW = {
  id: "k1",
  type: "kiosk",
  name: "Касса у входа",
  place: { id: null, name: "Зал 1" },
  status: "online",
  lastSeenAt: null,
  paired: true,
};

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/devices"))
      return jsonResponse(200, { items: [DEVICE_ROW], page: 1, pageSize: 8, total: 1 });
    if (url === "/api/lines") return jsonResponse(200, { items: [] });
    if (url === "/api/kiosks") return jsonResponse(200, { items: [KIOSK] });
    if (url === "/api/kiosks/k1") return jsonResponse(204, undefined);
    if (url.startsWith("/api/products")) return jsonResponse(200, { items: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDevicesRouter(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route
        path="/devices"
        element={
          <RequireCapability capability={CABINET_CAPABILITY.OPERATIONS_READ}>
            <DevicesPage />
          </RequireCapability>
        }
      >
        <Route
          path="kiosks/new"
          element={
            <RequireCapability capability={CABINET_CAPABILITY.OPERATIONS_WRITE}>
              <KioskCreatePanelRoute />
            </RequireCapability>
          }
        />
        <Route
          path="kiosks/:kioskId/edit"
          element={
            <RequireCapability capability={CABINET_CAPABILITY.OPERATIONS_WRITE}>
              <KioskEditPanelRoute />
            </RequireCapability>
          }
        />
        <Route
          path="kiosks/:kioskId/pair"
          element={
            <RequireCapability capability={CABINET_CAPABILITY.CREDENTIALS_MANAGE}>
              <KioskPairingPanelRoute />
            </RequireCapability>
          }
        />
      </Route>,
    ),
    { initialEntries: [initialEntry] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AccessProvider value={FULL_ACCESS}>
          <RouterProvider router={router} />
        </AccessProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { router };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("hosts the kiosk edit panel over the devices table", async () => {
  stubFetch();
  renderDevicesRouter("/devices/kiosks/k1/edit");

  await screen.findByRole("dialog", { name: "Изменить киоск" });
  expect(await screen.findByText("Касса у входа")).toBeDefined();
});

it("hosts the kiosk pairing panel under devices", async () => {
  stubFetch();
  renderDevicesRouter("/devices/kiosks/k1/pair");

  expect(await screen.findByRole("dialog", { name: "Привязка киоска" })).toBeDefined();
});

it("closes a directly entered panel back to the devices list", async () => {
  stubFetch();
  const { router } = renderDevicesRouter("/devices/kiosks/k1/edit");

  await screen.findByRole("dialog", { name: "Изменить киоск" });
  const close = screen.getByRole("button", { name: "Закрыть" });
  close.click();
  await screen.findByRole("table");
  expect(router.state.location.pathname).toBe("/devices");
});

it("archives an active kiosk from the edit panel via confirmation", async () => {
  const fetchMock = stubFetch();
  const { router } = renderDevicesRouter("/devices/kiosks/k1/edit");

  await screen.findByLabelText("Название");
  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  within(panel).getByRole("button", { name: "В архив" }).click();
  const confirmation = await screen.findByRole("alertdialog", { name: "Отправить киоск в архив?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "В архив" }));

  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/kiosks/k1" &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(true),
  );
  await waitFor(() => expect(router.state.location.pathname).toBe("/devices"));
});

it("does not fetch the kiosks list while no kiosk panel is open", async () => {
  const fetchMock = stubFetch();
  renderDevicesRouter("/devices");

  await screen.findByText("Касса у входа");
  expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/kiosks")).toBe(false);
});

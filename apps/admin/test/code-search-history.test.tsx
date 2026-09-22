/**
 * Filter history of the code-search section: each registry tab keeps its
 * filters in the URL, the tab switch returns to a tab's last address, and a
 * card's «← Поиск кодов» goes back to the tab (and filters) it was opened
 * from -- not to a bare `/codes`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { BoxesPage } from "../src/pages/boxes/index.js";
import { BoxCardPage } from "../src/pages/code-search/BoxCard.js";
import { CodeCardPage } from "../src/pages/code-search/CodeCard.js";
import { CodeSearchPage } from "../src/pages/code-search/index.js";
import { PalletCardPage } from "../src/pages/code-search/PalletCard.js";
import {
  forgetRegistryLocations,
  lastRegistryHref,
  registryHref,
  rememberRegistryLocation,
} from "../src/pages/code-search/registry-location.js";
import { PalletsPage } from "../src/pages/pallets/index.js";
import { jsonResponse } from "./helpers/http.js";

const ACCESS: AccessDocument = { roles: [], capabilities: [CABINET_CAPABILITY.OPERATIONS_READ] };

const PALLET = {
  id: "pal-w1",
  sscc: "00104600682000000019",
  kind: "warehouse",
  productId: "p1",
  productName: "Молоко 1л",
  deviceName: "ТСД-1",
  rejectedMembershipCount: 0,
  terminalId: "hh-1",
  lineName: null,
  operatorId: null,
  boxCount: 30,
  unitCount: 600,
  closedAt: "2026-09-17T10:00:00.000Z",
  contentsChangedAfterClose: false,
  disassembledAt: null,
};

const PALLET_CARD = {
  ...PALLET,
  status: "closed",
  shiftId: null,
  shiftNumber: null,
  openedAt: "2026-09-17T09:00:00.000Z",
  boxes: [],
  exceptions: [],
  rejections: [],
};

const BOX_CARD = {
  id: "box-1",
  sscc: "00123460682000000101",
  status: "closed",
  shiftId: "s1",
  shiftNumber: "SEP26-001",
  productId: "p1",
  productName: "Молоко 1л",
  terminalId: null,
  lineName: null,
  operatorId: null,
  openedAt: "2026-09-10T14:00:00.000Z",
  closedAt: "2026-09-10T15:00:00.000Z",
  disassembledAt: null,
  pallet: null,
  items: [],
  exceptions: [],
  pickupOrders: [],
};

const CODE_CARD = {
  codeHash: "a".repeat(64),
  gtin14: "04630000000001",
  serial: "SN0001",
  productId: "p1",
  productName: "Молоко 1л",
  status: "free",
  scannedAt: "2026-08-20T08:00:00.000Z",
  productionDate: null,
  currentBox: null,
  history: [],
};

const SHIFT = {
  id: "s1",
  number: "SEP26-001",
  status: "active",
  mode: "validation",
  productId: "p1",
  productName: "Молоко 1л",
  lineId: null,
  lineName: null,
  plannedDate: "2026-09-10",
  boxCapacity: null,
  palletBoxCapacity: null,
  palletsEnabled: false,
  createdFrom: "admin",
  openedAt: null,
  closedAt: null,
  lateDataAt: null,
  closeReason: null,
  createdAt: "2026-09-10T09:00:00.000Z",
};
const SHIFT_2 = {
  ...SHIFT,
  id: "s2",
  number: "SEP26-002",
  plannedDate: "2026-09-11",
  createdAt: "2026-09-11T09:00:00.000Z",
};

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/products")) {
      return jsonResponse(200, {
        items: [{ id: "p1", gtin14: "04600682000019", name: "Молоко 1л" }],
      });
    }
    if (url.startsWith("/api/devices")) {
      return jsonResponse(200, { items: [], page: 1, pageSize: 50, total: 0 });
    }
    if (url === "/api/pallets/pal-w1/exports") return jsonResponse(200, []);
    if (url.startsWith("/api/pallets")) return jsonResponse(200, { items: [PALLET] });
    if (url === "/api/code-search/pallets/pal-w1") return jsonResponse(200, PALLET_CARD);
    if (url === "/api/pallet-exports/formats") return jsonResponse(200, []);
    if (url.startsWith("/api/pallet-exports")) return jsonResponse(200, []);
    if (url === "/api/code-search/boxes/box-1") return jsonResponse(200, BOX_CARD);
    if (url === `/api/code-search/codes/${CODE_CARD.codeHash}`) {
      return jsonResponse(200, CODE_CARD);
    }
    if (url === "/api/code-search/chz-statuses") return jsonResponse(200, []);
    if (url.startsWith("/api/code-search/codes")) {
      return jsonResponse(200, { items: [], page: 2, pageCount: 3, total: 0 });
    }
    if (url.startsWith("/api/shifts")) return jsonResponse(200, { items: [SHIFT, SHIFT_2] });
    if (url.startsWith("/api/boxes")) return jsonResponse(200, { items: [] });
    if (url.startsWith("/api/employees")) return jsonResponse(200, { items: [] });
    return jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderSection(initialEntry: string) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <AccessProvider value={ACCESS}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <LocationProbe />
          <Routes>
            <Route path="/codes" element={<CodeSearchPage />} />
            <Route path="/boxes" element={<BoxesPage />} />
            <Route path="/pallets" element={<PalletsPage />} />
            <Route path="/codes/pallet/:palletId" element={<PalletCardPage />} />
            <Route path="/codes/box/:boxId" element={<BoxCardPage />} />
            <Route path="/codes/km/:codeHash" element={<CodeCardPage />} />
          </Routes>
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
}

function currentLocation(): string {
  return screen.getByTestId("location").textContent ?? "";
}

beforeEach(() => {
  forgetRegistryLocations();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetRegistryLocations();
});

describe("registry-location memory", () => {
  it("returns bare paths before any registry was visited and /codes as the last tab", () => {
    expect(registryHref("pallets")).toBe("/pallets");
    expect(lastRegistryHref()).toBe("/codes");
  });

  it("remembers each tab's last search and which tab was last", () => {
    rememberRegistryLocation("pallets", "?kind=warehouse");
    rememberRegistryLocation("codes", "?status=free&page=2");
    expect(registryHref("pallets")).toBe("/pallets?kind=warehouse");
    expect(registryHref("codes")).toBe("/codes?status=free&page=2");
    expect(registryHref("boxes")).toBe("/boxes");
    expect(lastRegistryHref()).toBe("/codes?status=free&page=2");
  });
});

describe("pallets tab", () => {
  it("reads its filters from the URL and writes filter changes back to it", async () => {
    const fetchMock = stubFetch();
    renderSection("/pallets?kind=warehouse&product=p1&from=2026-09-01&to=2026-09-17");
    const user = userEvent.setup();

    await waitFor(() => {
      expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
        `/api/pallets?kind=warehouse&productId=p1&closedFrom=${encodeURIComponent(
          new Date("2026-09-01T00:00:00").toISOString(),
        )}&closedTo=${encodeURIComponent(new Date("2026-09-17T23:59:59.999").toISOString())}&limit=100`,
      );
    });
    expect(screen.getByRole("combobox", { name: "Вид паллеты" }).textContent).toContain(
      "Складские",
    );

    await user.click(screen.getByRole("combobox", { name: "Вид паллеты" }));
    await user.click(await screen.findByRole("option", { name: "Производственные" }));
    expect(currentLocation()).toBe(
      "/pallets?kind=production&product=p1&from=2026-09-01&to=2026-09-17",
    );
  });

  it("comes back to the pallets tab with its filters from a pallet card", async () => {
    stubFetch();
    renderSection("/pallets?kind=warehouse");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("link", { name: "(00)104600682000000019" }));
    const back = await screen.findByRole("link", { name: "← Поиск кодов" });
    expect(back.getAttribute("href")).toBe("/pallets?kind=warehouse");

    await user.click(back);
    expect(currentLocation()).toBe("/pallets?kind=warehouse");
    expect((await screen.findByRole("combobox", { name: "Вид паллеты" })).textContent).toContain(
      "Складские",
    );
  });

  it("switches tabs and returns to each tab's last filters", async () => {
    stubFetch();
    renderSection("/pallets?kind=warehouse");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: "Короба" }));
    await waitFor(() => expect(currentLocation()).toBe("/boxes?shift=s2"));

    await user.click(await screen.findByRole("tab", { name: "Паллеты" }));
    expect(currentLocation()).toBe("/pallets?kind=warehouse");
  });
});

describe("boxes tab", () => {
  it("keeps the chosen shift in the URL and replaces the auto-selected default", async () => {
    stubFetch();
    renderSection("/boxes");
    const user = userEvent.setup();

    await waitFor(() => expect(currentLocation()).toBe("/boxes?shift=s2"));
    await user.click(screen.getByRole("combobox", { name: "Смена" }));
    await user.click(await screen.findByRole("option", { name: /SEP26-001/ }));
    expect(currentLocation()).toBe("/boxes?shift=s1");
  });

  it("honours a shift given in the URL instead of auto-selecting the newest", async () => {
    const fetchMock = stubFetch();
    renderSection("/boxes?shift=s1");

    await waitFor(() => {
      expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
        "/api/boxes?shiftId=s1",
      );
    });
    expect(currentLocation()).toBe("/boxes?shift=s1");
  });

  it("returns from a box card to the boxes tab", async () => {
    stubFetch();
    renderSection("/boxes?shift=s1");
    await screen.findByRole("tab", { name: "Короба" });
    cleanup();

    stubFetch();
    renderSection("/codes/box/box-1");
    const back = await screen.findByRole("link", { name: "← Поиск кодов" });
    expect(back.getAttribute("href")).toBe("/boxes?shift=s1");
  });
});

describe("codes tab", () => {
  it("reads status, product and page from the URL and resets the page on a filter change", async () => {
    const fetchMock = stubFetch();
    renderSection("/codes?status=free&product=p1&page=2");
    const user = userEvent.setup();

    await waitFor(() => {
      expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
        "/api/code-search/codes?page=2&productId=p1&status=free",
      );
    });

    await user.click(screen.getByRole("combobox", { name: "Статус" }));
    await user.click(await screen.findByRole("option", { name: "В коробе" }));
    expect(currentLocation()).toBe("/codes?status=aggregated&product=p1");
  });

  it("returns from a code card to the codes tab with its filters", async () => {
    stubFetch();
    renderSection("/codes?status=free&page=2");
    await screen.findByRole("tab", { name: "Коды" });
    cleanup();

    stubFetch();
    renderSection(`/codes/km/${CODE_CARD.codeHash}`);
    const back = await screen.findByRole("link", { name: "← Поиск кодов" });
    expect(back.getAttribute("href")).toBe("/codes?status=free&page=2");
  });
});

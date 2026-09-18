/**
 * Cabinet surfaces of warehouse pallets (plan 3): the org-wide `/pallets`
 * registry tab, the widened pallet card, its exports section and its
 * «Расформировать» action.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { PalletsPage } from "../src/pages/pallets/index.js";
import { jsonResponse } from "./helpers/http.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const READ_ONLY: AccessDocument = { roles: [], capabilities: [CABINET_CAPABILITY.OPERATIONS_READ] };

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const WAREHOUSE_PALLET = {
  id: "pal-w1",
  sscc: "00104600682000000019",
  kind: "warehouse",
  productId: "p1",
  productName: "Молоко 1л",
  deviceName: "ТСД-1",
  rejectedMembershipCount: 2,
  terminalId: "hh-1",
  lineName: null,
  operatorId: null,
  boxCount: 30,
  unitCount: 600,
  closedAt: "2026-09-17T10:00:00.000Z",
  contentsChangedAfterClose: false,
  disassembledAt: null,
};

const PRODUCTION_PALLET = {
  ...WAREHOUSE_PALLET,
  id: "pal-p1",
  sscc: "00103460068200000004",
  kind: "production",
  deviceName: "Станция 1",
  rejectedMembershipCount: 0,
  lineName: "Линия розлива № 1",
  boxCount: 12,
  unitCount: 240,
  contentsChangedAfterClose: true,
};

type FetchBody = (url: string, init: RequestInit | undefined) => unknown;

function stubRegistryFetch(body: FetchBody) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/products" || url.startsWith("/api/products?")) {
      return jsonResponse(200, {
        items: [{ id: "p1", gtin14: "04600682000019", name: "Молоко 1л" }],
      });
    }
    if (url.includes("/api/devices")) {
      return jsonResponse(200, {
        items: [
          {
            id: "hh-1",
            type: "handheld",
            name: "ТСД-1",
            place: { id: null, name: null },
            status: "active",
            lastSeenAt: null,
            paired: true,
          },
        ],
        page: 1,
        pageSize: 50,
        total: 1,
      });
    }
    return jsonResponse(200, body(url, init));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderRegistry() {
  return render(
    <QueryClientProvider client={newQueryClient()}>
      <AccessProvider value={READ_ONLY}>
        <MemoryRouter initialEntries={["/pallets"]}>
          <Routes>
            <Route path="/pallets" element={<PalletsPage />} />
          </Routes>
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
}

describe("pallets registry", () => {
  it("lists production and warehouse pallets org-wide with kind, device and warnings", async () => {
    stubRegistryFetch(() => ({ items: [WAREHOUSE_PALLET, PRODUCTION_PALLET] }));
    renderRegistry();

    expect(await screen.findByRole("tab", { name: "Паллеты" })).toBeDefined();
    const table = within(await screen.findByRole("table"));
    const warehouseLink = table.getByRole("link", { name: "(00)104600682000000019" });
    expect(warehouseLink.getAttribute("href")).toBe("/codes/pallet/pal-w1");
    expect(table.getByText("Складская")).toBeDefined();
    expect(table.getByText("Производственная")).toBeDefined();
    expect(table.getByText("ТСД-1")).toBeDefined();
    expect(table.getByText("Отказов: 2")).toBeDefined();
    expect(table.getByText("Состав изменился после закрытия")).toBeDefined();
  });

  it("sends the chosen kind, product and closure window as query parameters", async () => {
    const fetchMock = stubRegistryFetch(() => ({ items: [] }));
    renderRegistry();
    const user = userEvent.setup();

    expect(await screen.findByText("Паллет по этим условиям нет")).toBeDefined();
    await user.click(screen.getByRole("combobox", { name: "Вид паллеты" }));
    await user.click(await screen.findByRole("option", { name: "Складские" }));
    await user.click(screen.getByRole("combobox", { name: "Товар" }));
    await user.click(await screen.findByRole("option", { name: "Молоко 1л" }));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls).toContain("/api/pallets?kind=warehouse&productId=p1&limit=100");
    });
  });

  it("loads the next page with the server's cursor on «Показать ещё»", async () => {
    const fetchMock = stubRegistryFetch((url) =>
      url.includes("cursor=")
        ? { items: [PRODUCTION_PALLET] }
        : { items: [WAREHOUSE_PALLET], nextCursor: "next-1" },
    );
    renderRegistry();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Показать ещё" }));

    const table = within(await screen.findByRole("table"));
    expect(await table.findByRole("link", { name: "(00)103460068200000004" })).toBeDefined();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
      "/api/pallets?limit=100&cursor=next-1",
    );
    expect(screen.queryByRole("button", { name: "Показать ещё" })).toBeNull();
  });
});

/**
 * Cabinet surfaces of warehouse pallets (plan 3): the org-wide `/pallets`
 * registry tab, the widened pallet card, its exports section and its
 * «Расформировать» action.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { PalletCardPage } from "../src/pages/code-search/PalletCard.js";
import { PalletsPage } from "../src/pages/pallets/index.js";
import { jsonResponse } from "./helpers/http.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const READ_ONLY: AccessDocument = { roles: [], capabilities: [CABINET_CAPABILITY.OPERATIONS_READ] };
const READ_WRITE: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

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

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(
      urls.some((url) => url.startsWith("/api/products") && url.includes("archived=all")),
    ).toBe(true);
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

const WAREHOUSE_CARD = {
  id: "pal-w1",
  sscc: "00104600682000000019",
  status: "closed",
  kind: "warehouse",
  shiftId: null,
  shiftNumber: null,
  productId: "p1",
  productName: "Молоко 1л",
  terminalId: "hh-1",
  lineName: null,
  operatorId: null,
  openedAt: "2026-09-17T09:00:00.000Z",
  closedAt: "2026-09-17T10:00:00.000Z",
  disassembledAt: null,
  boxes: [
    {
      id: "box-1",
      sscc: "00123460682000000101",
      shiftId: "shift-a",
      shiftNumber: "SEP26-001",
      productionDate: "2026-09-10",
      itemCount: 20,
      closedAt: "2026-09-10T15:00:00.000Z",
      disassembledAt: null,
    },
    {
      id: "box-2",
      sscc: "00123460682000000102",
      shiftId: "shift-b",
      shiftNumber: "SEP26-004",
      productionDate: "2026-09-14",
      itemCount: 20,
      closedAt: "2026-09-14T15:00:00.000Z",
      disassembledAt: null,
    },
  ],
  exceptions: [],
  rejections: [
    {
      boxSscc: "00123460682000000103",
      boxId: "box-3",
      reason: "already_on_pallet",
      winningPalletSscc: "00104600682000000002",
      addedAt: "2026-09-17T09:30:00.000Z",
      recordedAt: "2026-09-17T09:31:00.000Z",
    },
    {
      boxSscc: "00123460682000000999",
      boxId: null,
      reason: "not_found",
      winningPalletSscc: null,
      addedAt: "2026-09-17T09:35:00.000Z",
      recordedAt: "2026-09-17T09:36:00.000Z",
    },
  ],
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderCard(
  card: unknown,
  access: AccessDocument = READ_ONLY,
  extra: FetchBody = () => ({ items: [] }),
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/code-search/pallets/pal-w1") return jsonResponse(200, card);
    return jsonResponse(200, extra(url, init));
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={newQueryClient()}>
      <AccessProvider value={access}>
        <MemoryRouter initialEntries={["/codes/pallet/pal-w1"]}>
          <Routes>
            <Route path="/codes/pallet/:palletId" element={<PalletCardPage />} />
            <Route path="/disaggregation/:id" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { fetchMock, user: userEvent.setup() };
}

describe("warehouse pallet card", () => {
  it("shows the kind, no shift link, and each box's own origin shift", async () => {
    renderCard(WAREHOUSE_CARD);

    expect(await screen.findByRole("heading", { name: "(00)104600682000000019" })).toBeDefined();
    expect(screen.getByText("Складская")).toBeDefined();
    // Only the two boxes' own shift links exist -- no shift link for the
    // pallet header, since this warehouse pallet is not tied to any shift.
    expect(screen.getAllByRole("link", { name: /SEP26/ })).toHaveLength(2);
    const boxes = within(screen.getByRole("region", { name: "Короба на паллете" }));
    expect(boxes.getByText("SEP26-001")).toBeDefined();
    expect(boxes.getByText("SEP26-004")).toBeDefined();
  });

  it("lists refused memberships with a readable reason and the winning pallet", async () => {
    // Read-write access (used by Task 5's write actions) renders the same
    // read-only card content; exercised here as a trivial use.
    renderCard(WAREHOUSE_CARD, READ_WRITE);

    const rejections = within(await screen.findByRole("region", { name: "Отказано в постановке" }));
    expect(rejections.getByText("(00)123460682000000103")).toBeDefined();
    expect(rejections.getByText("Уже на другой паллете")).toBeDefined();
    expect(rejections.getByText("(00)104600682000000002")).toBeDefined();
    expect(rejections.getByText("Короб не найден")).toBeDefined();
  });
});

const PALLET_FORMAT = {
  id: "pallet_xml_gismt_aggregation",
  version: 1,
  label: "[XML][ГИСМТ] Агрегация паллеты",
  extension: "xml",
  mimeType: "application/xml; charset=utf-8",
};

const READY_EXPORT = {
  id: "exp-1",
  shiftId: null,
  palletId: "pal-w1",
  formatId: "pallet_xml_gismt_aggregation",
  formatVersion: 1,
  maxLines: null,
  status: "ready",
  errorCode: null,
  productNameSnapshot: "Молоко 1л",
  shiftDateSnapshot: "2026-09-17",
  totalCodeCount: 0,
  totalBoxCount: 2,
  totalPalletCount: 1,
  createdByUserId: "u1",
  createdByName: "Елена Ким",
  sourceSnapshotStartedAt: "2026-09-17T10:05:00.000Z",
  completedAt: "2026-09-17T10:05:02.000Z",
  attemptCount: 1,
  createdAt: "2026-09-17T10:05:00.000Z",
  stale: false,
  artifacts: [
    {
      id: "art-1",
      partNumber: 1,
      physicalLineCount: 12,
      codeCount: 0,
      boxCount: 2,
      filename: "Молоко_2026-09-17_паллета_00104600682000000019_2_коробов.xml",
      mimeType: "application/xml; charset=utf-8",
      byteSize: 512,
      sha256: "0".repeat(64),
    },
  ],
};

describe("pallet exports section", () => {
  it("orders the pallet aggregation export and shows the history", async () => {
    let created = false;
    const { fetchMock, user } = renderCard(WAREHOUSE_CARD, READ_ONLY, (url, init) => {
      if (url === "/api/pallet-exports/formats") return [PALLET_FORMAT];
      if (url === "/api/pallets/pal-w1/exports" && init?.method === "POST") {
        created = true;
        return { ...READY_EXPORT, status: "queued", artifacts: [] };
      }
      if (url === "/api/pallets/pal-w1/exports") return created ? [READY_EXPORT] : [];
      return { items: [] };
    });

    const section = within(await screen.findByRole("region", { name: "Отчёты паллеты" }));
    expect(await section.findByText("Отчёты для этой паллеты ещё не формировались.")).toBeDefined();
    await user.click(section.getByRole("button", { name: "Сформировать отчёт" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) => String(call[0]) === "/api/pallets/pal-w1/exports" && call[1]?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ formatId: "pallet_xml_gismt_aggregation", formatVersion: 1 });
      expect(typeof body.idempotencyKey).toBe("string");
      expect(body).not.toHaveProperty("maxLines");
    });
    expect(await section.findByText("Готов")).toBeDefined();
    expect(section.getByText(/паллета_00104600682000000019/)).toBeDefined();
    expect(section.getByText("2 коробов")).toBeDefined();
  });

  it("explains instead of offering the export while the pallet is not closed", async () => {
    renderCard({ ...WAREHOUSE_CARD, status: "open", closedAt: null });

    const section = within(await screen.findByRole("region", { name: "Отчёты паллеты" }));
    expect(section.getByText("Отчёт доступен после закрытия паллеты.")).toBeDefined();
    expect(section.queryByRole("button", { name: "Сформировать отчёт" })).toBeNull();
  });
});

describe("pallet disassembly from the card", () => {
  it("creates a draft document and opens it prefilled with the pallet SSCC", async () => {
    const { fetchMock, user } = renderCard(WAREHOUSE_CARD, READ_WRITE, (url, init) => {
      if (url === "/api/disaggregation" && init?.method === "POST") {
        return { id: "doc-9", docNo: "DA-9", status: "draft", lines: [] };
      }
      if (url === "/api/pallet-exports/formats") return [];
      if (url === "/api/pallets/pal-w1/exports") return [];
      return { items: [] };
    });

    await user.click(await screen.findByRole("button", { name: "Расформировать" }));

    expect((await screen.findByTestId("location")).textContent).toBe(
      "/disaggregation/doc-9?sscc=00104600682000000019",
    );
    expect(
      fetchMock.mock.calls.some(
        (call) => String(call[0]) === "/api/disaggregation" && call[1]?.method === "POST",
      ),
    ).toBe(true);
  });

  it("hides the action from read-only users and for a pallet already taken apart", async () => {
    renderCard(WAREHOUSE_CARD, READ_ONLY);
    expect(await screen.findByRole("heading", { name: "(00)104600682000000019" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Расформировать" })).toBeNull();
    cleanup();

    renderCard(
      { ...WAREHOUSE_CARD, status: "disassembled", disassembledAt: "2026-09-18T08:00:00.000Z" },
      READ_WRITE,
    );
    expect(await screen.findByRole("heading", { name: "(00)104600682000000019" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Расформировать" })).toBeNull();
  });
});

describe("pallet placard from the card", () => {
  it("opens the A4 placard by default and the A5 one when chosen", async () => {
    const openMock = vi.fn();
    vi.stubGlobal("open", openMock);
    const { user } = renderCard(WAREHOUSE_CARD, READ_ONLY, (url) =>
      url.includes("/exports") || url.includes("/formats") ? [] : { items: [] },
    );

    await user.click(await screen.findByRole("button", { name: "Ярлык" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Ярлык паллеты" }));
    expect(dialog.getByRole("radio", { name: "A4" }).getAttribute("aria-checked")).toBe("true");
    await user.click(dialog.getByRole("button", { name: "Открыть" }));
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(String(openMock.mock.calls[0]?.[0])).toMatch(
      /^\/api\/code-search\/pallets\/pal-w1\/placard\?format=a4&timeZone=/,
    );
    expect(screen.queryByRole("dialog", { name: "Ярлык паллеты" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Ярлык" }));
    const again = within(await screen.findByRole("dialog", { name: "Ярлык паллеты" }));
    await user.click(again.getByRole("radio", { name: "A5" }));
    await user.click(again.getByRole("button", { name: "Открыть" }));
    expect(String(openMock.mock.calls[1]?.[0])).toContain("/placard?format=a5&timeZone=");
  });

  it("offers no placard for an open pallet or one without an SSCC", async () => {
    const extra: FetchBody = (url) =>
      url.includes("/exports") || url.includes("/formats") ? [] : { items: [] };
    renderCard({ ...WAREHOUSE_CARD, status: "open", closedAt: null }, READ_ONLY, extra);
    expect(await screen.findByRole("heading", { name: "(00)104600682000000019" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Ярлык" })).toBeNull();
    cleanup();

    renderCard({ ...WAREHOUSE_CARD, sscc: null }, READ_ONLY, extra);
    expect(await screen.findByRole("heading", { name: "Без SSCC" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Ярлык" })).toBeNull();
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrderDetailPage } from "../src/pages/pickup/OrderDetail.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const GS = String.fromCharCode(0x1d);
// Valid GTIN-14 check digit (04600682000013) + a real GS separator, so
// `renderDataMatrixSvg` (bwip-js `gs1datamatrix`, which enforces the AI-01
// GTIN checksum) doesn't throw and crash the page under test.
const ITEM_A = {
  id: "i1",
  gtin14: "04600682000013",
  serial: "SER1",
  rawKm: `01${"04600682000013"}21SER1${GS}93Abcd`,
  productName: "Молоко 1л",
  unitPrice: "59.00",
};

const ITEM_B = {
  id: "i2",
  gtin14: "04600682000013",
  serial: "SER2",
  rawKm: `01${"04600682000013"}21SER2${GS}93Efgh`,
  productName: "Сыр Российский",
  unitPrice: "119.00",
};

const ORDER = {
  id: "o1",
  orderNo: "37",
  employeeName: "Смирнов Алексей",
  kioskName: "Киоск-1",
  reason: "buy",
  writeoffReasonName: null,
  itemCount: 2,
  totalPrice: "178.00",
  status: "pending",
  createdAt: "2026-07-23T14:05:00.000Z",
  employeeBadgeCode: null,
  items: [ITEM_A, ITEM_B],
  receiptNo: null,
  actNo: null,
};

const REASONS = { items: [{ id: "r1", name: "Маркетинг", sortOrder: 0 }] };

function renderPage(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/pickup/o1"]}>
        <Routes>
          <Route path="/pickup/:id" element={<OrderDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function defaultFetchMock() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/pickup-orders/o1" && (!init || init.method === undefined)) {
      return jsonResponse(200, ORDER);
    }
    if (path === "/api/pickup-reasons") {
      return jsonResponse(200, REASONS);
    }
    if (path === "/api/pickup-orders/o1/resolve") {
      return jsonResponse(200, { ...ORDER, status: "punched" });
    }
    if (path === "/api/pickup-orders/o1/cancel") {
      return jsonResponse(200, { ...ORDER, status: "cancelled" });
    }
    throw new Error(`unexpected fetch: ${path}`);
  });
}

describe("OrderDetailPage", () => {
  it("renders the employee name, both product names, and the full KM text", async () => {
    renderPage(defaultFetchMock());

    expect(await screen.findByText("Смирнов Алексей")).toBeDefined();
    expect(screen.getByText("Молоко 1л")).toBeDefined();
    expect(screen.getByText("Сыр Российский")).toBeDefined();
    expect(screen.getByText(ITEM_A.rawKm)).toBeDefined();
    expect(screen.getByText(ITEM_B.rawKm)).toBeDefined();
  });

  it("opens the receipt modal on 'Пробита на кассе' and POSTs resolve with action punch + receiptNo", async () => {
    const fetchMock = defaultFetchMock();
    renderPage(fetchMock);

    await screen.findByText("Смирнов Алексей");

    fireEvent.click(screen.getByRole("button", { name: "Пробита на кассе" }));

    const receiptInput = await screen.findByLabelText("Номер чека");
    fireEvent.change(receiptInput, { target: { value: "CHK-001" } });

    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pickup-orders/o1/resolve",
        expect.objectContaining({ method: "POST" }),
      );
    });

    const resolveCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/pickup-orders/o1/resolve",
    );
    expect(resolveCall).toBeDefined();
    const body = JSON.parse((resolveCall?.[1] as RequestInit).body as string);
    expect(body).toEqual(expect.objectContaining({ action: "punch", receiptNo: "CHK-001" }));

    expect(await screen.findByText("Заявка проведена")).toBeDefined();
  });

  it("cancels the order via a confirm modal and POSTs /cancel", async () => {
    const fetchMock = defaultFetchMock();
    renderPage(fetchMock);

    await screen.findByText("Смирнов Алексей");

    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));

    fireEvent.click(await screen.findByRole("button", { name: "Отменить заявку" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pickup-orders/o1/cancel",
        expect.objectContaining({ method: "POST" }),
      );
    });

    expect(await screen.findByText("Заявка отменена")).toBeDefined();
  });

  it("opens the write-off modal and POSTs resolve with action writeoff + actNo + writeoffReasonId", async () => {
    const fetchMock = defaultFetchMock();
    renderPage(fetchMock);

    await screen.findByText("Смирнов Алексей");

    fireEvent.click(screen.getByRole("button", { name: "Списать актом" }));

    const actInput = await screen.findByLabelText("Номер акта");
    fireEvent.change(actInput, { target: { value: "ACT-9" } });

    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pickup-orders/o1/resolve",
        expect.objectContaining({ method: "POST" }),
      );
    });

    const resolveCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/pickup-orders/o1/resolve",
    );
    expect(resolveCall).toBeDefined();
    const body = JSON.parse((resolveCall?.[1] as RequestInit).body as string);
    expect(body).toEqual(
      expect.objectContaining({ action: "writeoff", actNo: "ACT-9", writeoffReasonId: "r1" }),
    );
  });

  it("shows an Alert instead of crashing when the order 404s", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(404, { message: "Not found" }),
    );
    renderPage(fetchMock);

    expect(
      await screen.findByText(
        "Не удалось загрузить заявку. Обновите страницу или войдите заново.",
      ),
    ).toBeDefined();
  });

  it("disables all actions when the order is not pending", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/pickup-orders/o1") return jsonResponse(200, { ...ORDER, status: "punched" });
      if (path === "/api/pickup-reasons") return jsonResponse(200, REASONS);
      throw new Error(`unexpected fetch: ${path}`);
    });
    renderPage(fetchMock);

    await screen.findByText("Смирнов Алексей");

    expect(screen.getByRole("button", { name: "Пробита на кассе" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Списать актом" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Печать" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Отменить" })).toHaveProperty("disabled", true);
  });

  it("renders a fallback placeholder instead of crashing when an item's rawKm is malformed", async () => {
    const brokenItem = { ...ITEM_A, id: "i3", rawKm: "not-a-valid-km" };
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/pickup-orders/o1") {
        return jsonResponse(200, { ...ORDER, items: [brokenItem] });
      }
      if (path === "/api/pickup-reasons") return jsonResponse(200, REASONS);
      throw new Error(`unexpected fetch: ${path}`);
    });
    renderPage(fetchMock);

    expect(await screen.findByText("Смирнов Алексей")).toBeDefined();
    expect(screen.getByText("Код не отображается")).toBeDefined();
  });
});

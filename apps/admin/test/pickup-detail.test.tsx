import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import type * as PickupApiModule from "../src/pages/pickup/api.js";
import { OrderDetailPage } from "../src/pages/pickup/OrderDetail.js";

const { writeHookMountSpy } = vi.hoisted(() => ({ writeHookMountSpy: vi.fn() }));

vi.mock("../src/pages/pickup/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PickupApiModule>();
  return {
    ...actual,
    useResolveOrder: () => {
      writeHookMountSpy("resolve");
      return actual.useResolveOrder();
    },
    useCancelOrder: () => {
      writeHookMountSpy("cancel");
      return actual.useCancelOrder();
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  writeHookMountSpy.mockClear();
  delete document.documentElement.dataset.theme;
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
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
  exportedAt: null,
  employeeBadgeCode: null,
  items: [ITEM_A, ITEM_B],
  receiptNo: null,
  actNo: null,
  conflictCount: 0,
  syncConflicts: [],
  boxConflicts: [],
  exportHeldProductNames: [],
  commercemlConfigured: true,
};

const REASONS = { items: [{ id: "r1", name: "Маркетинг", sortOrder: 0 }] };

const OPERATIONS_READ_ONLY: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const OPERATIONS_WRITE_ACCESS: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const OPERATIONS_WRITE_WITHOUT_INTEGRATIONS_READ: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const OPERATIONS_WRITE_WITH_INTEGRATIONS_READ: AccessDocument = {
  roles: [],
  capabilities: [
    CABINET_CAPABILITY.OPERATIONS_READ,
    CABINET_CAPABILITY.OPERATIONS_WRITE,
    CABINET_CAPABILITY.INTEGRATIONS_READ,
  ],
};

function renderPage(
  fetchMock: ReturnType<typeof vi.fn>,
  access: AccessDocument = OPERATIONS_WRITE_ACCESS,
) {
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/pickup/o1"]}>
        <Routes>
          <Route
            path="/pickup/:id"
            element={
              <AccessProvider value={access}>
                <OrderDetailPage />
              </AccessProvider>
            }
          />
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
  it("keeps order details readable while hiding resolution and cancel without operations.write", async () => {
    renderPage(defaultFetchMock(), OPERATIONS_READ_ONLY);

    expect(await screen.findByText(ORDER.employeeName)).toBeDefined();
    expect(screen.getByText(ITEM_A.productName)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Пробита на кассе" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Списать актом" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Отменить" })).toBeNull();
    expect(screen.getByRole("button", { name: "Печать" })).toBeDefined();
    expect(writeHookMountSpy).not.toHaveBeenCalled();
  });

  it("renders the employee name, both product names, and the full KM text", async () => {
    renderPage(defaultFetchMock());

    expect(await screen.findByText("Смирнов Алексей")).toBeDefined();
    expect(screen.getByText("Молоко 1л")).toBeDefined();
    expect(screen.getByText("Сыр Российский")).toBeDefined();
    expect(screen.getByText(ITEM_A.rawKm)).toBeDefined();
    expect(screen.getByText(ITEM_B.rawKm)).toBeDefined();
  });

  it("keeps rendered DataMatrix codes on a white field in the dark theme", async () => {
    document.documentElement.dataset.theme = "dark";
    renderPage(defaultFetchMock());

    await screen.findByText("Смирнов Алексей");
    const code = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".mk-pickup-dm");
      if (!element) throw new Error("expected a rendered DataMatrix");
      return element;
    });

    expect(getComputedStyle(code).backgroundColor).toBe("rgb(255, 255, 255)");
  });

  it("shows what the kiosk lost at sync time", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/pickup-orders/o1") {
        return jsonResponse(200, {
          ...ORDER,
          conflictCount: 2,
          syncConflicts: [
            { rawKm: "0104600682000013215AAA", reason: "duplicate" },
            { rawKm: "0104600682000013215BBB", reason: "over_limit" },
          ],
        });
      }
      if (path === "/api/pickup-reasons") return jsonResponse(200, REASONS);
      throw new Error(`unexpected fetch: ${path}`);
    });
    renderPage(fetchMock);

    expect(await screen.findByText(/Отклонено при синхронизации: 2/)).toBeDefined();
    expect(screen.getByText(/дубль/i)).toBeDefined();
    expect(screen.getByText(/лимит/i)).toBeDefined();
  });

  it("renders no conflicts plaque for a clean order", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/pickup-orders/o1") {
        return jsonResponse(200, { ...ORDER, conflictCount: 0, syncConflicts: [] });
      }
      if (path === "/api/pickup-reasons") return jsonResponse(200, REASONS);
      throw new Error(`unexpected fetch: ${path}`);
    });
    renderPage(fetchMock);

    expect(await screen.findByText(ORDER.orderNo)).toBeDefined();
    expect(screen.queryByText(/Отклонено при синхронизации/)).toBeNull();
  });

  it("shows 'not yet exported' for an order 1С hasn't confirmed", async () => {
    renderPage(defaultFetchMock());

    expect(await screen.findByText("Ещё не выгружена")).toBeDefined();
  });

  it("shows the export timestamp once 1С has confirmed receipt", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/pickup-orders/o1") {
        return jsonResponse(200, { ...ORDER, exportedAt: "2026-07-24T09:00:00.000Z" });
      }
      if (path === "/api/pickup-reasons") return jsonResponse(200, REASONS);
      throw new Error(`unexpected fetch: ${path}`);
    });
    renderPage(fetchMock);

    expect(await screen.findByText(/^Выгружена /)).toBeDefined();
    expect(screen.queryByText("Ещё не выгружена")).toBeNull();
  });

  it("shows a held-order alert linking to the CommerceML channel page when a product carries no 1С link", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/pickup-orders/o1") {
        return jsonResponse(200, { ...ORDER, exportHeldProductNames: ["Молоко 1л"] });
      }
      if (path === "/api/pickup-reasons") return jsonResponse(200, REASONS);
      throw new Error(`unexpected fetch: ${path}`);
    });
    renderPage(fetchMock, OPERATIONS_WRITE_WITH_INTEGRATIONS_READ);

    expect(await screen.findByText("Заявка придержана — 1 товар(ов) без связи с 1С")).toBeDefined();
    // "Молоко 1л" also appears in the items table below, so scope this
    // assertion to the alert itself rather than a bare `getByText`.
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Молоко 1л")).toBeDefined();
    const link = within(alert).getByText("Перейти к очереди сопоставления");
    expect(link.closest("a")?.getAttribute("href")).toBe("/integrations/commerceml");
  });

  it("explains the held integration problem without a link when integrations.read is absent", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/pickup-orders/o1") {
        return jsonResponse(200, { ...ORDER, exportHeldProductNames: ["Молоко 1л"] });
      }
      if (path === "/api/pickup-reasons") return jsonResponse(200, REASONS);
      throw new Error(`unexpected fetch: ${path}`);
    });
    renderPage(fetchMock, OPERATIONS_WRITE_WITHOUT_INTEGRATIONS_READ);

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("Очередь сопоставления недоступна для вашей роли."),
    ).toBeDefined();
    expect(within(alert).queryByRole("link")).toBeNull();
  });

  it("does not show the held-order alert once the order has already been exported", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/pickup-orders/o1") {
        return jsonResponse(200, {
          ...ORDER,
          exportedAt: "2026-07-24T09:00:00.000Z",
          exportHeldProductNames: ["Молоко 1л"],
        });
      }
      if (path === "/api/pickup-reasons") return jsonResponse(200, REASONS);
      throw new Error(`unexpected fetch: ${path}`);
    });
    renderPage(fetchMock);

    await screen.findByText(/^Выгружена /);
    expect(screen.queryByText(/Заявка придержана/)).toBeNull();
  });

  it("hides all 1C export information when CommerceML is not configured", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/pickup-orders/o1") {
        return jsonResponse(200, {
          ...ORDER,
          commercemlConfigured: false,
          exportHeldProductNames: ["Молоко 1л"],
        });
      }
      if (path === "/api/pickup-reasons") return jsonResponse(200, REASONS);
      throw new Error(`unexpected fetch: ${path}`);
    });
    renderPage(fetchMock, OPERATIONS_WRITE_WITH_INTEGRATIONS_READ);

    await screen.findByText(ORDER.orderNo);
    expect(screen.queryByText("Выгрузка в 1С")).toBeNull();
    expect(screen.queryByText(/Заявка придержана/)).toBeNull();
    expect(screen.queryByText("Перейти к очереди сопоставления")).toBeNull();
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
    const fetchMock = vi.fn(async () => jsonResponse(404, { message: "Not found" }));
    renderPage(fetchMock);

    expect(
      await screen.findByText("Не удалось загрузить заявку. Обновите страницу или войдите заново."),
    ).toBeDefined();
  });

  it("disables all actions when the order is not pending", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/pickup-orders/o1")
        return jsonResponse(200, { ...ORDER, status: "punched" });
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
    // ItemCode (and its bwip-js dependency) is lazy-loaded, so the fallback
    // placeholder for a malformed code appears asynchronously once that chunk
    // resolves -- hence findByText rather than a synchronous getByText.
    expect(await screen.findByText("Код не отображается")).toBeDefined();
  });
});

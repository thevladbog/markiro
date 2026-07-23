import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShiftsPage } from "../src/pages/shifts/index.js";

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

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ShiftsPage />
    </QueryClientProvider>,
  );
}

const PRODUCT_A = {
  id: "p1",
  gtin14: "04006381333931",
  name: "Молоко 1л",
  productGroup: "Молочные продукты",
  boxCapacity: 12,
  palletCapacity: 48,
  status: "active",
  defaultCounterpartyId: "cp1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PRODUCT_B = {
  id: "p2",
  gtin14: "04600000000018",
  name: "Сыр Российский",
  productGroup: "Молочные продукты",
  boxCapacity: 6,
  palletCapacity: 24,
  status: "active",
  defaultCounterpartyId: null,
  createdAt: "2026-01-02T00:00:00.000Z",
};

const DRAFT_PRODUCT = {
  id: "p3",
  gtin14: "04600000000025",
  name: "Черновик продукт",
  productGroup: null,
  boxCapacity: null,
  palletCapacity: null,
  status: "draft",
  defaultCounterpartyId: null,
  createdAt: "2026-01-03T00:00:00.000Z",
};

const COUNTERPARTY = {
  id: "cp1",
  name: "Acme Ltd",
  gln: "6291041500213",
  inn: null,
  gs1Prefixes: [],
  notes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PLANNED_SHIFT = {
  id: "s1",
  status: "planned",
  mode: "validation",
  productId: "p1",
  productName: "Молоко 1л",
  lineId: "l1",
  lineName: "Линия 1",
  counterpartyId: null,
  counterpartyName: null,
  plannedQty: 500,
  plannedDate: "2026-07-25",
  boxCapacity: null,
  palletCapacity: null,
  palletsEnabled: false,
  createdFrom: "admin",
  openedAt: null,
  closedAt: null,
  closeReason: null,
  createdAt: "2026-07-20T00:00:00.000Z",
};

const ACTIVE_TOLLING_SHIFT = {
  ...PLANNED_SHIFT,
  id: "s2",
  status: "active",
  mode: "aggregation",
  productId: "p2",
  productName: "Сыр Российский",
  lineId: null,
  lineName: null,
  counterpartyId: "cp1",
  counterpartyName: "Acme Ltd",
  plannedQty: 1000,
  plannedDate: "2026-07-23",
  boxCapacity: 12,
  palletCapacity: 48,
  palletsEnabled: true,
  openedAt: "2026-07-23T08:00:00.000Z",
};

const CLOSED_SHIFT = {
  ...PLANNED_SHIFT,
  id: "s3",
  status: "closed",
  plannedQty: 200,
  plannedDate: "2026-07-20",
  lineId: null,
  lineName: null,
  openedAt: "2026-07-20T08:00:00.000Z",
  closedAt: "2026-07-20T16:00:00.000Z",
  closeReason: "Брак линии",
};

describe("ShiftsPage", () => {
  it("renders shifts from the mocked GET response with joined fields, mode badges, the tolling label, and status chips", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) {
        return jsonResponse(200, { items: [PLANNED_SHIFT, ACTIVE_TOLLING_SHIFT, CLOSED_SHIFT] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const table = within(await screen.findByRole("table"));
    expect(table.getAllByText("Молоко 1л").length).toBe(2);
    expect(table.getByText("Сыр Российский")).toBeDefined();
    expect(table.getByText("Линия 1")).toBeDefined();
    expect(table.getAllByText("—").length).toBe(2); // missing lineName on the other two rows
    expect(table.getAllByText("Валидация").length).toBe(2);
    expect(table.getByText("Агрегация")).toBeDefined();
    expect(table.getByText("500")).toBeDefined();
    expect(table.getByText("1000")).toBeDefined();
    expect(table.getByText("200")).toBeDefined();
    expect(table.getByText("для: Acme Ltd")).toBeDefined();
    expect(table.getByText("Запланирована")).toBeDefined();
    expect(table.getByText("Активна")).toBeDefined();
    expect(table.getByText("Закрыта")).toBeDefined();
    expect(table.getByText("Брак линии")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/shifts", expect.any(Object));
  });

  it("shows edit/delete actions only for planned rows, and the close action only for active rows", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) {
        return jsonResponse(200, { items: [PLANNED_SHIFT, ACTIVE_TOLLING_SHIFT, CLOSED_SHIFT] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    const table = within(await screen.findByRole("table"));

    expect(table.getAllByRole("button", { name: "Изменить" })).toHaveLength(1);
    expect(table.getAllByRole("button", { name: "Удалить" })).toHaveLength(1);
    expect(table.getAllByRole("button", { name: "Закрыть смену" })).toHaveLength(1);
  });

  it("opens the close-reason modal and POSTs the exact {reason} body on confirm", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s2/close" && init?.method === "POST") {
        return jsonResponse(200, {
          ...ACTIVE_TOLLING_SHIFT,
          status: "closed",
          closeReason: "Плановая остановка",
        });
      }
      if (path.startsWith("/api/shifts"))
        return jsonResponse(200, { items: [ACTIVE_TOLLING_SHIFT] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Сыр Российский");

    fireEvent.click(screen.getByRole("button", { name: "Закрыть смену" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Причина закрытия"), {
      target: { value: "Плановая остановка" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть смену" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/shifts/s2/close",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ reason: "Плановая остановка" }),
        }),
      );
    });
  });

  it("disables draft products in the shift form's product select and shows a hint", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path === "/api/products") return jsonResponse(200, { items: [DRAFT_PRODUCT, PRODUCT_A] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");

    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");

    const draftOption = screen.getByRole("option", {
      name: `${DRAFT_PRODUCT.name} (черновик — недоступно)`,
    }) as HTMLOptionElement;
    expect(draftOption.disabled).toBe(true);

    const activeOption = screen.getByRole("option", { name: PRODUCT_A.name }) as HTMLOptionElement;
    expect(activeOption.disabled).toBe(false);
  });

  it("prefills capacity inputs and preselects the counterparty when the product changes (aggregation mode)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path === "/api/products") return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/counterparties") return jsonResponse(200, { items: [COUNTERPARTY] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");

    fireEvent.click(screen.getByLabelText("Агрегация"));
    fireEvent.change(screen.getByLabelText("Продукт"), { target: { value: PRODUCT_A.id } });

    const boxInput = (await screen.findByLabelText("Вместимость короба, шт")) as HTMLInputElement;
    expect(boxInput.value).toBe(String(PRODUCT_A.boxCapacity));

    const counterpartySelect = screen.getByLabelText(
      "Для контрагента (толлинг)",
    ) as HTMLSelectElement;
    expect(counterpartySelect.value).toBe(PRODUCT_A.defaultCounterpartyId);
  });

  it("sends counterpartyId: null when the user clears the prefilled counterparty before submitting", async () => {
    const created = { ...ACTIVE_TOLLING_SHIFT, id: "new1" };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") return jsonResponse(201, created);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path === "/api/products") return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/counterparties") return jsonResponse(200, { items: [COUNTERPARTY] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");

    fireEvent.change(screen.getByLabelText("Продукт"), { target: { value: PRODUCT_A.id } });
    await waitFor(() => {
      expect((screen.getByLabelText("Для контрагента (толлинг)") as HTMLSelectElement).value).toBe(
        PRODUCT_A.defaultCounterpartyId,
      );
    });

    fireEvent.change(screen.getByLabelText("Для контрагента (толлинг)"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/shifts",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            mode: "validation",
            lineId: null,
            plannedQty: null,
            plannedDate: null,
            counterpartyId: null,
            productId: PRODUCT_A.id,
          }),
        }),
      );
    });
  });

  it("omits counterpartyId from the create payload when left untouched and the product has no default", async () => {
    const created = { ...PLANNED_SHIFT, id: "new2", productId: PRODUCT_B.id };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") return jsonResponse(201, created);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path === "/api/products") return jsonResponse(200, { items: [PRODUCT_B] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");

    fireEvent.change(screen.getByLabelText("Продукт"), { target: { value: PRODUCT_B.id } });
    fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/shifts",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            mode: "validation",
            lineId: null,
            plannedQty: null,
            plannedDate: null,
            productId: PRODUCT_B.id,
          }),
        }),
      );
    });
  });

  it("shows box/pallet capacity fields only in aggregation mode, and pallet capacity only when pallets are enabled", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path === "/api/products") return jsonResponse(200, { items: [PRODUCT_A] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");

    expect(screen.queryByLabelText("Вместимость короба, шт")).toBeNull();
    expect(screen.queryByLabelText("Использовать паллеты")).toBeNull();

    fireEvent.click(screen.getByLabelText("Агрегация"));
    expect(await screen.findByLabelText("Вместимость короба, шт")).toBeDefined();
    expect(screen.getByLabelText("Использовать паллеты")).toBeDefined();
    expect(screen.queryByLabelText("Вместимость паллеты, шт")).toBeNull();

    fireEvent.click(screen.getByLabelText("Использовать паллеты"));
    expect(await screen.findByLabelText("Вместимость паллеты, шт")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Валидация"));
    expect(screen.queryByLabelText("Вместимость короба, шт")).toBeNull();
  });

  it("applies the status and date-range filters to the GET /shifts query", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");

    fireEvent.change(screen.getByLabelText("Статус"), { target: { value: "active" } });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/shifts?status=active", expect.any(Object));
    });

    fireEvent.change(screen.getByLabelText("С даты"), { target: { value: "2026-07-01" } });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/shifts?status=active&from=2026-07-01",
        expect.any(Object),
      );
    });

    fireEvent.change(screen.getByLabelText("По дату"), { target: { value: "2026-07-31" } });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/shifts?status=active&from=2026-07-01&to=2026-07-31",
        expect.any(Object),
      );
    });
  });

  it("sends PATCH with plannedQty but omits counterpartyId and productId when editing", async () => {
    const updated = { ...PLANNED_SHIFT, plannedQty: 750 };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s1" && init?.method === "PATCH") {
        return jsonResponse(200, updated);
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [PLANNED_SHIFT] });
      if (path === "/api/products") return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Молоко 1л");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить смену");

    fireEvent.change(screen.getByLabelText("Плановое количество, шт"), {
      target: { value: "750" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      // Find the PATCH call and verify the body contains plannedQty but not counterpartyId/productId
      const patchCalls = fetchMock.mock.calls.filter(
        (call) => call[0] === "/api/shifts/s1" && call[1]?.method === "PATCH"
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const patchCall = patchCalls[0]!;
      const body = JSON.parse(patchCall[1]?.body as string);
      // The test changes only plannedQty, so it should be in the payload with the new value
      expect(body.plannedQty).toBe(750);
      // Other fields are either sent as-is or omitted if untouched
      expect(body.mode).toBe("validation");
      // counterpartyId and productId should NOT be in PATCH payloads at all
      expect(body).not.toHaveProperty("counterpartyId");
      expect(body).not.toHaveProperty("productId");
    }, { timeout: 3000 });
  });

  it("sends POST with prefilled boxCapacity and mode aggregation; palletCapacity omitted while pallets disabled", async () => {
    const created = {
      ...PLANNED_SHIFT,
      id: "new3",
      productId: PRODUCT_A.id,
      productName: PRODUCT_A.name,
      mode: "aggregation",
      boxCapacity: PRODUCT_A.boxCapacity,
      palletCapacity: null,
      palletsEnabled: false,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") return jsonResponse(201, created);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path === "/api/products") return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");

    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");

    fireEvent.click(screen.getByLabelText("Агрегация"));
    fireEvent.change(screen.getByLabelText("Продукт"), { target: { value: PRODUCT_A.id } });
    await waitFor(() => {
      expect((screen.getByLabelText("Вместимость короба, шт") as HTMLInputElement).value).toBe(
        String(PRODUCT_A.boxCapacity),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));

    await waitFor(() => {
      // Find the POST call to /api/shifts (skip initial GET calls)
      const postCalls = fetchMock.mock.calls.filter(
        (call) => call[0] === "/api/shifts" && call[1]?.method === "POST"
      );
      expect(postCalls.length).toBeGreaterThan(0);
      const postCall = postCalls[0]!;
      const body = JSON.parse(postCall[1]?.body as string);
      expect(body.mode).toBe("aggregation");
      expect(body.productId).toBe(PRODUCT_A.id);
      expect(body.boxCapacity).toBe(PRODUCT_A.boxCapacity);
      expect(body.palletsEnabled).toBe(false);
      expect(body.lineId).toBeNull();
      expect(body.plannedQty).toBeNull();
      expect(body.plannedDate).toBeNull();
      expect(body.palletCapacity).toBeUndefined();
    }, { timeout: 3000 });
  });

  it("sends POST with palletsEnabled:true and prefilled palletCapacity when pallets checkbox is toggled", async () => {
    const created = {
      ...PLANNED_SHIFT,
      id: "new4",
      productId: PRODUCT_A.id,
      productName: PRODUCT_A.name,
      mode: "aggregation",
      boxCapacity: PRODUCT_A.boxCapacity,
      palletCapacity: PRODUCT_A.palletCapacity,
      palletsEnabled: true,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") return jsonResponse(201, created);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path === "/api/products") return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");

    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");

    fireEvent.click(screen.getByLabelText("Агрегация"));
    fireEvent.change(screen.getByLabelText("Продукт"), { target: { value: PRODUCT_A.id } });
    await waitFor(() => {
      expect((screen.getByLabelText("Вместимость короба, шт") as HTMLInputElement).value).toBe(
        String(PRODUCT_A.boxCapacity),
      );
    });

    // Toggle the pallets checkbox to show and prefill the pallet capacity field
    fireEvent.click(screen.getByLabelText("Использовать паллеты"));
    await waitFor(() => {
      expect((screen.getByLabelText("Вместимость паллеты, шт") as HTMLInputElement).value).toBe(
        String(PRODUCT_A.palletCapacity),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));

    await waitFor(() => {
      // Find the POST call to /api/shifts (skip initial GET calls)
      const postCalls = fetchMock.mock.calls.filter(
        (call) => call[0] === "/api/shifts" && call[1]?.method === "POST"
      );
      expect(postCalls.length).toBeGreaterThan(0);
      const postCall = postCalls[0]!;
      const body = JSON.parse(postCall[1]?.body as string);
      expect(body.mode).toBe("aggregation");
      expect(body.productId).toBe(PRODUCT_A.id);
      expect(body.boxCapacity).toBe(PRODUCT_A.boxCapacity);
      expect(body.palletsEnabled).toBe(true);
      expect(body.palletCapacity).toBe(PRODUCT_A.palletCapacity);
      expect(body.lineId).toBeNull();
      expect(body.plannedQty).toBeNull();
      expect(body.plannedDate).toBeNull();
    }, { timeout: 3000 });
  });
});

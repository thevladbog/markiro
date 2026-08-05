import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import type * as ShiftsApiModule from "../src/pages/shifts/api.js";
import { ShiftsPage } from "../src/pages/shifts/index.js";

const { writeHookMountSpy } = vi.hoisted(() => ({ writeHookMountSpy: vi.fn() }));

vi.mock("../src/pages/shifts/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ShiftsApiModule>();
  return {
    ...actual,
    useCreateShift: () => {
      writeHookMountSpy("create");
      return actual.useCreateShift();
    },
    useUpdateShift: () => {
      writeHookMountSpy("update");
      return actual.useUpdateShift();
    },
    useDeleteShift: () => {
      writeHookMountSpy("delete");
      return actual.useDeleteShift();
    },
    useCloseShift: () => {
      writeHookMountSpy("close");
      return actual.useCloseShift();
    },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  writeHookMountSpy.mockClear();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const OPERATIONS_READ_ONLY: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const OPERATIONS_WRITE_ACCESS: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

function renderPage(access: AccessDocument = OPERATIONS_WRITE_ACCESS) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider value={access}>
        <ShiftsPage />
      </AccessProvider>
    </QueryClientProvider>,
  );
}

async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
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
  defaultLabelTemplateId: "lt1",
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

const PRODUCT_B_WITH_DEFAULTS = {
  ...PRODUCT_B,
  defaultCounterpartyId: "cp2",
  defaultLabelTemplateId: "lt1",
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

const LABEL_TEMPLATE = {
  id: "lt1",
  name: "Короб 58×40",
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

// Task 6: a second, distinct label template -- used together with
// LABEL_TEMPLATE so the item-label-template select and the box-label-template
// select can each be asserted against their own id, not each other's.
const BOX_LABEL_TEMPLATE = {
  id: "lt2",
  name: "Короб паллета 100×150",
  widthMm: 100,
  heightMm: 150,
  dpi: 203,
  language: "zpl",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

// Task 6: two distinct counterparties -- the buyer the goods are for, and a
// brand owner whose SSCC numbers the boxes carry instead. They must be
// settable independently, so fixtures for the two need distinct ids.
const BUYER = {
  id: "cp3",
  name: "Buyer LLC",
  gln: "6291041500213",
  inn: null,
  gs1Prefixes: [],
  notes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const BRAND_OWNER = {
  id: "cp2",
  name: "Brand Owner Co",
  gln: "6291041500220",
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
  lateDataAt: null,
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
  it("keeps shift rows readable while hiding mutations without operations.write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("/api/shifts")) {
          return jsonResponse(200, { items: [PLANNED_SHIFT, ACTIVE_TOLLING_SHIFT] });
        }
        return jsonResponse(200, { items: [] });
      }),
    );

    renderPage(OPERATIONS_READ_ONLY);

    expect(await screen.findByText(PLANNED_SHIFT.productName)).toBeDefined();
    expect(screen.getByText(ACTIVE_TOLLING_SHIFT.productName)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Добавить смену" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Закрыть смену" })).toBeNull();
    expect(writeHookMountSpy).not.toHaveBeenCalled();
  });

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

  it("marks a shift that received data after it was closed", async () => {
    const lateDataShift = { ...CLOSED_SHIFT, id: "s4", lateDataAt: "2026-07-28T19:30:00.000Z" };
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [lateDataShift] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    expect(await screen.findByText("Данные после закрытия")).toBeDefined();
  });

  it("does not mark a shift that received nothing late", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [CLOSED_SHIFT] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    await screen.findByText("Молоко 1л");
    expect(screen.queryByText("Данные после закрытия")).toBeNull();
  });

  it("shows a spinner (not EmptyState) while the list request is still pending", async () => {
    // A fetch that never resolves keeps the query in isPending forever.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    renderPage();

    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.queryByText("Смены не запланированы")).toBeNull();
  });

  it("shows an error alert (not EmptyState) when the list request fails, e.g. an expired session (401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { message: "Unauthorized" })),
    );

    renderPage();

    expect(
      await screen.findByText("Не удалось загрузить данные. Обновите страницу или войдите заново."),
    ).toBeDefined();
    expect(screen.queryByText("Смены не запланированы")).toBeNull();
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
    const user = userEvent.setup();
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

    await user.click(screen.getByRole("combobox", { name: "Продукт" }));
    const draftOption = screen.getByRole("option", {
      name: `${DRAFT_PRODUCT.name} (черновик — недоступно)`,
    });
    expect(draftOption.getAttribute("data-disabled")).toBe("");

    const activeOption = screen.getByRole("option", { name: PRODUCT_A.name });
    expect(activeOption.getAttribute("data-disabled")).toBeNull();
  });

  it("prefills capacity inputs and preselects the counterparty when the product changes (aggregation mode)", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByLabelText("Агрегация"));
    await chooseOption(user, "Продукт", PRODUCT_A.name);

    const boxInput = (await screen.findByLabelText("Вместимость короба, шт")) as HTMLInputElement;
    expect(boxInput.value).toBe(String(PRODUCT_A.boxCapacity));

    expect(
      screen.getByRole("combobox", { name: "Для контрагента (толлинг)" }).textContent,
    ).toContain(COUNTERPARTY.name);
  });

  it("sends counterpartyId: null when the user clears the prefilled counterparty before submitting", async () => {
    const user = userEvent.setup();
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

    await chooseOption(user, "Продукт", PRODUCT_A.name);
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Для контрагента (толлинг)" }).textContent,
      ).toContain(COUNTERPARTY.name);
    });

    await chooseOption(user, "Для контрагента (толлинг)", "Не выбран");
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
    const user = userEvent.setup();
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

    await chooseOption(user, "Продукт", PRODUCT_B.name);
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

  it("prefills the label template select from the product's default when the product changes", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path === "/api/products") return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/label-templates") return jsonResponse(200, { items: [LABEL_TEMPLATE] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");

    await chooseOption(user, "Продукт", PRODUCT_A.name);

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Шаблон этикетки" }).textContent).toContain(
        LABEL_TEMPLATE.name,
      );
    });
  });

  it("applies product B defaults after counterparty and template were touched for product A", async () => {
    const user = userEvent.setup();
    const created = { ...PLANNED_SHIFT, id: "new-defaults", productId: PRODUCT_B_WITH_DEFAULTS.id };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") return jsonResponse(201, created);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path === "/api/products") {
        return jsonResponse(200, { items: [PRODUCT_A, PRODUCT_B_WITH_DEFAULTS] });
      }
      if (path === "/api/counterparties") {
        return jsonResponse(200, { items: [COUNTERPARTY, BUYER, BRAND_OWNER] });
      }
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [LABEL_TEMPLATE, BOX_LABEL_TEMPLATE] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");

    await chooseOption(user, "Продукт", PRODUCT_A.name);
    await chooseOption(user, "Для контрагента (толлинг)", BUYER.name);
    await chooseOption(user, "Шаблон этикетки", BOX_LABEL_TEMPLATE.name);
    await chooseOption(user, "Продукт", PRODUCT_B_WITH_DEFAULTS.name);

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Для контрагента (толлинг)" }).textContent,
      ).toContain(BRAND_OWNER.name);
      expect(screen.getByRole("combobox", { name: "Шаблон этикетки" }).textContent).toContain(
        LABEL_TEMPLATE.name,
      );
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
            counterpartyId: BRAND_OWNER.id,
            labelTemplateId: LABEL_TEMPLATE.id,
            productId: PRODUCT_B_WITH_DEFAULTS.id,
          }),
        }),
      );
    });
  });

  it("sends labelTemplateId: null when the user clears the prefilled label template before submitting", async () => {
    const user = userEvent.setup();
    const created = { ...PLANNED_SHIFT, id: "new5", productId: PRODUCT_A.id };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") return jsonResponse(201, created);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path === "/api/products") return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/label-templates") return jsonResponse(200, { items: [LABEL_TEMPLATE] });
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");

    await chooseOption(user, "Продукт", PRODUCT_A.name);
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Шаблон этикетки" }).textContent).toContain(
        LABEL_TEMPLATE.name,
      );
    });

    await chooseOption(user, "Шаблон этикетки", "Не выбран");
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
            labelTemplateId: null,
            productId: PRODUCT_A.id,
          }),
        }),
      );
    });
  });

  it("omits labelTemplateId from the create payload when left untouched", async () => {
    const user = userEvent.setup();
    const created = { ...PLANNED_SHIFT, id: "new6", productId: PRODUCT_B.id };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") return jsonResponse(201, created);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path === "/api/products") return jsonResponse(200, { items: [PRODUCT_B] });
      if (path === "/api/label-templates") return jsonResponse(200, { items: [LABEL_TEMPLATE] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");

    await chooseOption(user, "Продукт", PRODUCT_B.name);
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");

    await chooseOption(user, "Статус", "Активна");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/shifts?status=active", expect.any(Object));
    });

    await user.click(screen.getByRole("button", { name: "С даты" }));
    await user.click(screen.getByRole("button", { name: "Предыдущий месяц" }));
    await user.click(screen.getByRole("button", { name: "1 июля 2026" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/shifts?status=active&from=2026-07-01",
        expect.any(Object),
      );
    });

    await user.click(screen.getByRole("button", { name: "По дату" }));
    await user.click(screen.getByRole("button", { name: "Предыдущий месяц" }));
    await user.click(screen.getByRole("button", { name: "31 июля 2026" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/shifts?status=active&from=2026-07-01&to=2026-07-31",
        expect.any(Object),
      );
    });

    await user.click(screen.getByRole("button", { name: "Очистить дату: С даты" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/shifts?status=active&to=2026-07-31",
        expect.any(Object),
      );
    });

    await user.click(screen.getByRole("button", { name: "Очистить дату: По дату" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/shifts?status=active", expect.any(Object));
    });
  });

  it("clears a planned date to null in the update payload", async () => {
    const user = userEvent.setup();
    const updated = { ...PLANNED_SHIFT, plannedDate: null };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s1" && init?.method === "PATCH") return jsonResponse(200, updated);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [PLANNED_SHIFT] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Молоко 1л");
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить смену");

    await user.click(screen.getByRole("button", { name: "Очистить дату: Дата смены" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (call) => call[0] === "/api/shifts/s1" && call[1]?.method === "PATCH",
      );
      const body = JSON.parse(patchCall?.[1]?.body as string);
      expect(body.plannedDate).toBeNull();
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

    await waitFor(
      () => {
        // Find the PATCH call and verify the body contains plannedQty but not counterpartyId/productId
        const patchCalls = fetchMock.mock.calls.filter(
          (call) => call[0] === "/api/shifts/s1" && call[1]?.method === "PATCH",
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
        // Same "untouched -> omitted" contract for the new selects (Task 6):
        // a mutation that sent them unconditionally would show up here.
        expect(body).not.toHaveProperty("ssccIssuerCounterpartyId");
        expect(body).not.toHaveProperty("boxLabelTemplateId");
      },
      { timeout: 3000 },
    );
  });

  it("submits the sscc issuer separately from the counterparty", async () => {
    const user = userEvent.setup();
    const updated = {
      ...PLANNED_SHIFT,
      counterpartyId: BUYER.id,
      ssccIssuerCounterpartyId: BRAND_OWNER.id,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s1" && init?.method === "PATCH") {
        return jsonResponse(200, updated);
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [PLANNED_SHIFT] });
      if (path === "/api/counterparties") return jsonResponse(200, { items: [BUYER, BRAND_OWNER] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Молоко 1л");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить смену");

    // The issuer select defaults to "our own organization", not "none" --
    // it must read as a real choice with its own identity, not an absence.
    await user.click(screen.getByRole("combobox", { name: "Эмитент группового кода" }));
    await user.click(screen.getByRole("option", { name: "Наша организация" }));

    await chooseOption(user, "Для контрагента (толлинг)", BUYER.name);
    await chooseOption(user, "Эмитент группового кода", BRAND_OWNER.name);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(
      () => {
        const patchCalls = fetchMock.mock.calls.filter(
          (call) => call[0] === "/api/shifts/s1" && call[1]?.method === "PATCH",
        );
        expect(patchCalls.length).toBeGreaterThan(0);
        const body = JSON.parse(patchCalls[0]![1]?.body as string);
        // The two ids must land on their own distinct fields -- a swapped
        // assignment (issuer id sent as counterpartyId or vice versa) would
        // typecheck and look plausible, since both are plain uuid strings
        // drawn from the same counterparties list.
        expect(body.counterpartyId).toBe(BUYER.id);
        expect(body.ssccIssuerCounterpartyId).toBe(BRAND_OWNER.id);
      },
      { timeout: 3000 },
    );
  });

  it("sends ssccIssuerCounterpartyId: null when the user selects then clears it back to the default", async () => {
    const user = userEvent.setup();
    const updated = { ...PLANNED_SHIFT, ssccIssuerCounterpartyId: null };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s1" && init?.method === "PATCH") {
        return jsonResponse(200, updated);
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [PLANNED_SHIFT] });
      if (path === "/api/counterparties") return jsonResponse(200, { items: [BRAND_OWNER] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Молоко 1л");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить смену");

    // Same "default sends null" contract counterpartyId/labelTemplateId
    // already have their own test for (see "sends counterpartyId: null..."
    // above) -- touch the select away from its default, then clear it back
    // to "Наша организация" ("") before submitting. Deleting the `? : null`
    // ternary in toPayload would send a raw "" here instead of null.
    await chooseOption(user, "Эмитент группового кода", BRAND_OWNER.name);
    await chooseOption(user, "Эмитент группового кода", "Наша организация");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(
      () => {
        const patchCalls = fetchMock.mock.calls.filter(
          (call) => call[0] === "/api/shifts/s1" && call[1]?.method === "PATCH",
        );
        expect(patchCalls.length).toBeGreaterThan(0);
        const body = JSON.parse(patchCalls[0]![1]?.body as string);
        expect(body.ssccIssuerCounterpartyId).toBeNull();
      },
      { timeout: 3000 },
    );
  });

  it("sends boxLabelTemplateId: null when the user selects then clears it back to the default", async () => {
    const user = userEvent.setup();
    const updated = { ...PLANNED_SHIFT, boxLabelTemplateId: null };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s1" && init?.method === "PATCH") {
        return jsonResponse(200, updated);
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [PLANNED_SHIFT] });
      if (path === "/api/label-templates") return jsonResponse(200, { items: [LABEL_TEMPLATE] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Молоко 1л");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить смену");

    // Same contract as above, for the box label template select: touch it
    // away from its default, then clear it back to the no-template option
    // ("") before submitting, and confirm the payload carries an explicit
    // null rather than a raw empty string.
    await chooseOption(user, "Шаблон этикетки короба", LABEL_TEMPLATE.name);
    await chooseOption(user, "Шаблон этикетки короба", "Не выбран");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(
      () => {
        const patchCalls = fetchMock.mock.calls.filter(
          (call) => call[0] === "/api/shifts/s1" && call[1]?.method === "PATCH",
        );
        expect(patchCalls.length).toBeGreaterThan(0);
        const body = JSON.parse(patchCalls[0]![1]?.body as string);
        expect(body.boxLabelTemplateId).toBeNull();
      },
      { timeout: 3000 },
    );
  });

  it("renders each select's own value, not its counterpart's, on load in edit mode", async () => {
    // Two near-identical pairs of Selects sit side by side in the form:
    // counterparty/ssccIssuer, and labelTemplate/boxLabelTemplate. A
    // copy-paste error that crosses only the `value=` prop between a pair
    // would still submit correctly (fireEvent.change sets the value it then
    // asserts, so submission-based tests can't see it) but would *display*
    // the wrong answer to "whose numbers/template is this" -- exactly the
    // silent defect this feature exists to prevent. Assert the rendered DOM
    // value of each select against its own distinct fixture id, before any
    // interaction.
    const shiftWithDistinctFields = {
      ...PLANNED_SHIFT,
      counterpartyId: BUYER.id,
      counterpartyName: BUYER.name,
      ssccIssuerCounterpartyId: BRAND_OWNER.id,
      labelTemplateId: LABEL_TEMPLATE.id,
      boxLabelTemplateId: BOX_LABEL_TEMPLATE.id,
    };
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) {
        return jsonResponse(200, { items: [shiftWithDistinctFields] });
      }
      if (path === "/api/counterparties") return jsonResponse(200, { items: [BUYER, BRAND_OWNER] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [LABEL_TEMPLATE, BOX_LABEL_TEMPLATE] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Молоко 1л");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить смену");

    expect(
      screen.getByRole("combobox", { name: "Для контрагента (толлинг)" }).textContent,
    ).toContain(BUYER.name);
    expect(screen.getByRole("combobox", { name: "Эмитент группового кода" }).textContent).toContain(
      BRAND_OWNER.name,
    );
    expect(screen.getByRole("combobox", { name: "Шаблон этикетки" }).textContent).toContain(
      LABEL_TEMPLATE.name,
    );
    expect(screen.getByRole("combobox", { name: "Шаблон этикетки короба" }).textContent).toContain(
      BOX_LABEL_TEMPLATE.name,
    );
  });

  it("sends POST with prefilled boxCapacity and mode aggregation; palletCapacity omitted while pallets disabled", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByLabelText("Агрегация"));
    await chooseOption(user, "Продукт", PRODUCT_A.name);
    await waitFor(() => {
      expect((screen.getByLabelText("Вместимость короба, шт") as HTMLInputElement).value).toBe(
        String(PRODUCT_A.boxCapacity),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));

    await waitFor(
      () => {
        // Find the POST call to /api/shifts (skip initial GET calls)
        const postCalls = fetchMock.mock.calls.filter(
          (call) => call[0] === "/api/shifts" && call[1]?.method === "POST",
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
      },
      { timeout: 3000 },
    );
  });

  it("sends POST with palletsEnabled:true and prefilled palletCapacity when pallets checkbox is toggled", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByLabelText("Агрегация"));
    await chooseOption(user, "Продукт", PRODUCT_A.name);
    await waitFor(() => {
      expect((screen.getByLabelText("Вместимость короба, шт") as HTMLInputElement).value).toBe(
        String(PRODUCT_A.boxCapacity),
      );
    });

    // Toggle the pallets checkbox to show and prefill the pallet capacity field
    await user.click(screen.getByLabelText("Использовать паллеты"));
    await waitFor(() => {
      expect((screen.getByLabelText("Вместимость паллеты, шт") as HTMLInputElement).value).toBe(
        String(PRODUCT_A.palletCapacity),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));

    await waitFor(
      () => {
        // Find the POST call to /api/shifts (skip initial GET calls)
        const postCalls = fetchMock.mock.calls.filter(
          (call) => call[0] === "/api/shifts" && call[1]?.method === "POST",
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
      },
      { timeout: 3000 },
    );
  });
});

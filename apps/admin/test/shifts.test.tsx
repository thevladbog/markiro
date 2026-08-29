import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import type { ProductDto } from "../src/pages/catalog/api.js";
import type * as ShiftsApiModule from "../src/pages/shifts/api.js";
import { ShiftsPage } from "../src/pages/shifts/index.js";
import {
  BOX_TEMPLATE_SELECTION,
  ShiftForm,
  type ShiftFormValues,
} from "../src/pages/shifts/ShiftForm.js";
import { ShiftPanelRoute } from "../src/pages/shifts/ShiftPanelRoute.js";

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

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  writeHookMountSpy.mockClear();
  await i18n.changeLanguage("ru");
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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
        <RouterProvider
          router={createMemoryRouter(
            createRoutesFromElements(
              <Route path="/shifts" element={<ShiftsPage />}>
                <Route path="new" element={<ShiftPanelRoute mode="create" />} />
                <Route path=":shiftId/edit" element={<ShiftPanelRoute mode="edit" />} />
              </Route>,
            ),
            { initialEntries: ["/shifts"] },
          )}
        />
      </AccessProvider>
    </QueryClientProvider>,
  );
}

async function chooseOption(
  _user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  const trigger = screen.getByRole("combobox", { name: label });
  // The searchable Combobox (product / tolling counterparty) opens a popover
  // on click; the Radix Select opens on pointerdown.
  if (trigger.classList.contains("mk-combobox__trigger")) {
    fireEvent.click(trigger);
  } else {
    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pageX: 0,
      pageY: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
  }
  const optionElement = await screen.findByRole("option", { name: option });
  fireEvent.click(optionElement);
  expect(trigger.textContent).toContain(option);
}

async function chooseDate(label: string, date: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(await screen.findByRole("button", { name: date }));
}

const PRODUCT_A: ProductDto = {
  id: "p1",
  gtin14: "04006381333931",
  name: "Молоко 1л",
  printName: null,
  productGroup: "Молочная продукция",
  chzProductGroupCode: 8,
  boxCapacity: 12,
  palletCapacity: 48,
  unitPrice: null,
  egaisCode: null,
  shelfLifeDays: null,
  externalRef: null,
  status: "active",
  archived: false,
  defaultCounterpartyId: "cp1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PRODUCT_B = {
  id: "p2",
  gtin14: "04600000000018",
  name: "Сыр Российский",
  productGroup: "Молочная продукция",
  chzProductGroupCode: 8,
  boxCapacity: 6,
  palletCapacity: 24,
  status: "active",
  defaultCounterpartyId: null,
  createdAt: "2026-01-02T00:00:00.000Z",
};

const PRODUCT_B_WITH_DEFAULTS = {
  ...PRODUCT_B,
  defaultCounterpartyId: "cp2",
};

const DRAFT_PRODUCT = {
  id: "p3",
  gtin14: "04600000000025",
  name: "Черновик продукт",
  productGroup: null,
  chzProductGroupCode: null,
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

const INITIAL_SHIFT_FORM_VALUES: ShiftFormValues = {
  productId: PRODUCT_A.id,
  mode: "validation",
  plannedQty: "500",
  plannedDate: "2026-08-06",
  productionDate: "",
  lineId: "",
  counterpartyId: "",
  ssccIssuerCounterpartyId: "",
  boxLabelTemplateSelection: BOX_TEMPLATE_SELECTION.none,
  boxCapacity: "",
  palletCapacity: "",
  palletsEnabled: false,
};

function DirtyReseedHarness() {
  const [initialValues, setInitialValues] = useState(INITIAL_SHIFT_FORM_VALUES);
  return (
    <div
      onChange={() =>
        setInitialValues({
          ...INITIAL_SHIFT_FORM_VALUES,
          plannedQty: "900",
        })
      }
    >
      <ShiftForm
        mode="edit"
        initialValues={initialValues}
        products={[PRODUCT_A]}
        lines={[]}
        counterparties={[]}
        formContext={{ defaultBoxLabelTemplateId: null, labelTemplates: [] }}
        onSubmit={() => undefined}
        onDirtyChange={() => undefined}
        onClose={() => undefined}
      />
    </div>
  );
}

it("does not re-seed over an operator edit when initial values change in the same commit", () => {
  render(<DirtyReseedHarness />);

  const quantity = screen.getByLabelText("Плановое количество, шт");
  fireEvent.change(quantity, { target: { value: "501" } });

  expect((quantity as HTMLInputElement).value).toBe("501");
});

// A second box template lets tests distinguish an explicit shift override
// from the organisation default.
const BOX_LABEL_TEMPLATE = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Короб паллета 100×150",
  widthMm: 100,
  heightMm: 150,
  dpi: 203,
  language: "zpl",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const DEFAULT_BOX_LABEL_TEMPLATE = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Короб 100×100",
  widthMm: 100,
  heightMm: 100,
  dpi: 203,
  language: "zpl",
  updatedAt: "2026-08-14T00:00:00.000Z",
};

const SHIFT_PLANNING_CONFIG = {
  defaultBoxLabelTemplateId: DEFAULT_BOX_LABEL_TEMPLATE.id,
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
  number: "AUG26-001",
  status: "planned",
  mode: "validation",
  productId: "p1",
  productName: "Молоко 1л",
  lineId: "l1",
  lineName: "Линия 1",
  counterpartyId: null,
  counterpartyName: null,
  ssccIssuerCounterpartyId: null,
  boxLabelTemplateId: null,
  plannedQty: 500,
  plannedDate: "2026-07-25",
  productionDate: null,
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
  number: "AUG26-002/S",
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
  number: "AUG26-003",
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
          return jsonResponse(200, { items: [PLANNED_SHIFT, ACTIVE_TOLLING_SHIFT, CLOSED_SHIFT] });
        }
        return jsonResponse(200, { items: [] });
      }),
    );

    renderPage(OPERATIONS_READ_ONLY);

    expect((await screen.findAllByText(PLANNED_SHIFT.productName)).length).toBe(2);
    expect(screen.getByText(ACTIVE_TOLLING_SHIFT.productName)).toBeDefined();
    // Planned-date column + production-date column (fallback to plannedDate).
    expect(screen.getAllByText("25.07.2026").length).toBe(2);
    expect(screen.queryByRole("button", { name: "Добавить смену" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Закрыть смену" })).toBeNull();
    expect(screen.getByRole("button", { name: "Сформировать отчет" })).toBeDefined();
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
    expect(screen.getByTestId("shifts-page").classList).toContain("mk-admin-page");
    expect(screen.getByRole("group", { name: "Фильтры смен" })).toBeDefined();
    expect(screen.getByText("3 смены").getAttribute("aria-live")).toBe("polite");
    expect(fetchMock).toHaveBeenCalledWith("/api/shifts", expect.any(Object));
  });

  it("shows the shift number in the first table column", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) {
        return jsonResponse(200, { items: [PLANNED_SHIFT, ACTIVE_TOLLING_SHIFT, CLOSED_SHIFT] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    await screen.findByText("AUG26-001");
    const headers = screen.getAllByRole("columnheader");
    expect(headers[0]?.textContent).toContain("Номер");
    // The number lives in the FIRST data cell of each row, not merely
    // somewhere on the page.
    const rows = screen.getAllByRole("row").slice(1); // drop the header row
    const firstCells = rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent);
    expect(firstCells).toEqual(["AUG26-001", "AUG26-002/S", "AUG26-003"]);
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

  it("shows edit for planned and active rows, delete only for planned, and close only for active", async () => {
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

    expect(table.getAllByRole("button", { name: "Изменить" })).toHaveLength(2);
    expect(table.getAllByRole("button", { name: "Удалить" })).toHaveLength(1);
    expect(table.getAllByRole("button", { name: "Закрыть смену" })).toHaveLength(1);
  });

  it("requires a critical confirmation before saving active-shift metadata", async () => {
    const user = userEvent.setup();
    const activeShift = {
      ...ACTIVE_TOLLING_SHIFT,
      boxLabelTemplateId: DEFAULT_BOX_LABEL_TEMPLATE.id,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s2" && init?.method === "PATCH") {
        return jsonResponse(200, { ...activeShift, plannedQty: 1200, boxLabelTemplateId: "lt2" });
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [activeShift] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_B] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE, BOX_LABEL_TEMPLATE] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    const row = (await screen.findByText("Сыр Российский")).closest("tr");
    expect(row).not.toBeNull();
    await user.click(within(row!).getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить смену · AUG26-002/S");

    expect((screen.getByRole("radio", { name: "Валидация" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("combobox", { name: "Шаблон этикетки" })).toBeNull();
    expect((screen.getByLabelText("Вместимость короба, шт") as HTMLInputElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("Плановое количество, шт"), {
      target: { value: "1200" },
    });
    await chooseOption(user, "Шаблон этикетки короба", BOX_LABEL_TEMPLATE.name);
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    const dialog = await screen.findByRole("alertdialog", {
      name: "Критическое изменение активной смены",
    });
    expect(dialog.textContent).toContain(
      "выйдите из неё и войдите повторно на всех работающих с ней станциях",
    );
    expect(
      fetchMock.mock.calls.some(
        (call) => call[0] === "/api/shifts/s2" && call[1]?.method === "PATCH",
      ),
    ).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Сохранить изменения" }));
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (call) => call[0] === "/api/shifts/s2" && call[1]?.method === "PATCH",
      );
      expect(JSON.parse(patchCall?.[1]?.body as string)).toEqual({
        plannedQty: 1200,
        boxLabelTemplateId: BOX_LABEL_TEMPLATE.id,
      });
    });
    expect(await screen.findByText(/Изменения сохранены.*войдите в смену повторно/)).toBeDefined();
  });

  it("sends a chosen production date when creating a shift", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const created = { ...PLANNED_SHIFT, id: "new-production-date", productionDate: "2026-08-20" };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") return jsonResponse(201, created);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await chooseOption(user, "Продукт", PRODUCT_A.name);
    await chooseDate("Дата производства (для отчётов)", "20 августа 2026");
    fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/shifts" && init?.method === "POST",
      );
      const body = JSON.parse(postCall?.[1]?.body as string) as Record<string, unknown>;
      expect(body.productionDate).toBe("2026-08-20");
    });
  });

  it("initializes a null production date as blank instead of inferring it from the shift dates", async () => {
    const shiftWithNullProductionDate = {
      ...ACTIVE_TOLLING_SHIFT,
      plannedDate: "2026-07-23",
      openedAt: "2026-07-24T08:00:00.000Z",
      productionDate: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.startsWith("/api/shifts")) {
          return jsonResponse(200, { items: [shiftWithNullProductionDate] });
        }
        return jsonResponse(200, { items: [] });
      }),
    );

    renderPage();
    const row = (await screen.findByText("Сыр Российский")).closest("tr");
    fireEvent.click(within(row!).getByRole("button", { name: "Изменить" }));

    expect(
      screen.getByRole("button", { name: "Дата производства (для отчётов)" }).textContent,
    ).toContain("Выберите дату");
    expect(
      screen.queryByRole("button", { name: "Очистить дату: Дата производства (для отчётов)" }),
    ).toBeNull();
  });

  it("clears a production date to null in the edit payload", async () => {
    const user = userEvent.setup();
    const shiftWithProductionDate = { ...PLANNED_SHIFT, productionDate: "2026-07-24" };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s1" && init?.method === "PATCH") {
        return jsonResponse(200, { ...shiftWithProductionDate, productionDate: null });
      }
      if (path.startsWith("/api/shifts"))
        return jsonResponse(200, { items: [shiftWithProductionDate] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Молоко 1л");
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await user.click(
      screen.getByRole("button", { name: "Очистить дату: Дата производства (для отчётов)" }),
    );
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/shifts/s1" && init?.method === "PATCH",
      );
      const body = JSON.parse(patchCall?.[1]?.body as string) as Record<string, unknown>;
      expect(body.productionDate).toBeNull();
    });
  });

  it("does not stale-overwrite an unchanged production date on an active shift", async () => {
    const user = userEvent.setup();
    const activeShift = {
      ...ACTIVE_TOLLING_SHIFT,
      boxLabelTemplateId: DEFAULT_BOX_LABEL_TEMPLATE.id,
      productionDate: "2026-07-24",
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s2" && init?.method === "PATCH") {
        return jsonResponse(200, { ...activeShift, plannedQty: 1200 });
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [activeShift] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_B] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    const row = (await screen.findByText("Сыр Российский")).closest("tr");
    fireEvent.click(within(row!).getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить смену · AUG26-002/S");
    expect((screen.getByRole("radio", { name: "Валидация" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("Плановое количество, шт"), {
      target: { value: "1200" },
    });
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Критическое изменение активной смены",
    });
    await user.click(within(dialog).getByRole("button", { name: "Сохранить изменения" }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/shifts/s2" && init?.method === "PATCH",
      );
      const body = JSON.parse(patchCall?.[1]?.body as string) as Record<string, unknown>;
      expect(body.plannedQty).toBe(1200);
      expect(body).not.toHaveProperty("productionDate");
    });
  });

  it("sends a changed production date for an active shift and keeps its panel open when locked", async () => {
    const user = userEvent.setup();
    const activeShift = {
      ...ACTIVE_TOLLING_SHIFT,
      boxLabelTemplateId: DEFAULT_BOX_LABEL_TEMPLATE.id,
      productionDate: "2026-07-24",
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s2" && init?.method === "PATCH") {
        return jsonResponse(409, {
          code: "PRODUCTION_DATE_LOCKED",
          message: "Production date cannot change after the first box closure",
        });
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [activeShift] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_B] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    const row = (await screen.findByText("Сыр Российский")).closest("tr");
    fireEvent.click(within(row!).getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить смену · AUG26-002/S");
    await chooseDate("Дата производства (для отчётов)", "25 июля 2026");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Критическое изменение активной смены",
    });
    await user.click(within(dialog).getByRole("button", { name: "Сохранить изменения" }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/shifts/s2" && init?.method === "PATCH",
      );
      const body = JSON.parse(patchCall?.[1]?.body as string) as Record<string, unknown>;
      expect(body.productionDate).toBe("2026-07-25");
    });
    expect(
      await screen.findByText("Production date cannot change after the first box closure"),
    ).toBeDefined();
    expect(screen.getByText("Изменить смену · AUG26-002/S")).toBeDefined();
  });

  it("shows the opening date when an existing shift has no planned date", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/shifts")) {
        return jsonResponse(200, {
          items: [{ ...ACTIVE_TOLLING_SHIFT, plannedDate: null }],
        });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const row = (await screen.findByText("Сыр Российский")).closest("tr");
    expect(within(row!).getByText("23.07.2026")).toBeDefined();
  });

  it("converts a legacy opening timestamp to the browser's local calendar date", async () => {
    const openedAt = "2026-07-23T23:30:00-11:00";
    const expected = (() => {
      const date = new Date(openedAt);
      return [
        String(date.getDate()).padStart(2, "0"),
        String(date.getMonth() + 1).padStart(2, "0"),
        date.getFullYear(),
      ].join(".");
    })();
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/shifts")) {
        return jsonResponse(200, {
          items: [{ ...ACTIVE_TOLLING_SHIFT, plannedDate: null, openedAt }],
        });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const row = (await screen.findByText("Сыр Российский")).closest("tr");
    expect(within(row!).getByText(expected)).toBeDefined();
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
    const dialog = await screen.findByRole("alertdialog", { name: "Закрыть смену" });
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

  it("keeps a close failure and its reason inside the confirmation", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s2/close" && init?.method === "POST") {
        return jsonResponse(409, { message: "Shift already closed" });
      }
      if (path.startsWith("/api/shifts")) {
        return jsonResponse(200, { items: [ACTIVE_TOLLING_SHIFT] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Закрыть смену" }));
    const dialog = screen.getByRole("alertdialog", { name: "Закрыть смену" });
    fireEvent.change(within(dialog).getByLabelText("Причина закрытия"), {
      target: { value: "Переналадка линии" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть смену" }));

    expect(await within(dialog).findByText("Shift already closed")).toBeDefined();
    expect((within(dialog).getByLabelText("Причина закрытия") as HTMLInputElement).value).toBe(
      "Переналадка линии",
    );
  });

  it("confirms planned-shift deletion and keeps API failures in the dialog", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s1" && init?.method === "DELETE") {
        return jsonResponse(409, { message: "Shift has production data" });
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [PLANNED_SHIFT] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Удалить" }));
    const dialog = screen.getByRole("alertdialog", { name: "Удалить смену?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));

    expect(await within(dialog).findByText("Shift has production data")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/shifts/s1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("disables draft products in the shift form's product select and shows a hint", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products"))
        return jsonResponse(200, { items: [DRAFT_PRODUCT, PRODUCT_A] });
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
    expect((draftOption as HTMLButtonElement).disabled).toBe(true);

    const activeOption = screen.getByRole("option", { name: PRODUCT_A.name });
    expect((activeOption as HTMLButtonElement).disabled).toBe(false);
  });

  it("requests archived products for name resolution but disables them in the product select", async () => {
    const user = userEvent.setup();
    const archivedProduct = { ...PRODUCT_A, id: "p9", name: "Снятый продукт", archived: true };
    const productUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) {
        productUrls.push(path);
        return jsonResponse(200, { items: [archivedProduct, PRODUCT_A] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");

    // "all" keeps an archived product's name resolvable on historical shifts…
    expect(productUrls[0]).toBe("/api/products?archived=all");

    // …while the creation combobox refuses to offer it.
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");
    await user.click(screen.getByRole("combobox", { name: "Продукт" }));
    const archivedOption = screen.getByRole("option", {
      name: `${archivedProduct.name} (не используется)`,
    });
    expect((archivedOption as HTMLButtonElement).disabled).toBe(true);
    const activeOption = screen.getByRole("option", { name: PRODUCT_A.name });
    expect((activeOption as HTMLButtonElement).disabled).toBe(false);
  });

  it("prefills capacity inputs and preselects the counterparty when the product changes (aggregation mode)", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
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
      if (path === "/api/shifts/planning-config") {
        return jsonResponse(200, { defaultBoxLabelTemplateId: null });
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
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
  }, 10_000);

  it("omits counterpartyId from the create payload when left untouched and the product has no default", async () => {
    const user = userEvent.setup();
    const created = { ...PLANNED_SHIFT, id: "new2", productId: PRODUCT_B.id };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") return jsonResponse(201, created);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_B] });
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

  it("does not render the retired item-label template control", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");

    expect(screen.queryByRole("combobox", { name: "Шаблон этикетки" })).toBeNull();
  });

  it("applies product B's counterparty default after the field was touched for product A", async () => {
    const user = userEvent.setup();
    const created = {
      ...PLANNED_SHIFT,
      id: "new-defaults",
      productId: PRODUCT_B_WITH_DEFAULTS.id,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") return jsonResponse(201, created);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) {
        return jsonResponse(200, { items: [PRODUCT_A, PRODUCT_B_WITH_DEFAULTS] });
      }
      if (path === "/api/counterparties") {
        return jsonResponse(200, { items: [COUNTERPARTY, BUYER, BRAND_OWNER] });
      }
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE, BOX_LABEL_TEMPLATE] });
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
    await chooseOption(user, "Продукт", PRODUCT_B_WITH_DEFAULTS.name);

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Для контрагента (толлинг)" }).textContent,
      ).toContain(BRAND_OWNER.name);
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
            productId: PRODUCT_B_WITH_DEFAULTS.id,
          }),
        }),
      );
    });
  }, 10_000);

  it("never sends the retired item-label field from create", async () => {
    const user = userEvent.setup();
    const created = { ...PLANNED_SHIFT, id: "new5", productId: PRODUCT_A.id };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") return jsonResponse(201, created);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");

    await chooseOption(user, "Продукт", PRODUCT_A.name);
    fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/shifts" && init?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall?.[1]?.body as string) as Record<string, unknown>;
      expect(body).not.toHaveProperty("labelTemplateId");
    });
  }, 10_000);

  it("omits both retired item-template and untouched box-template fields from create", async () => {
    const user = userEvent.setup();
    const created = { ...PLANNED_SHIFT, id: "new6", productId: PRODUCT_B.id };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") return jsonResponse(201, created);
      if (path === "/api/shifts/planning-config") {
        return jsonResponse(200, { defaultBoxLabelTemplateId: null });
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_B] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE] });
      }
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

  it("shows the organisation box-template default and resolves it to a UUID for aggregation", async () => {
    const created = {
      ...PLANNED_SHIFT,
      id: "new-inherited-box-template",
      mode: "aggregation",
      productId: PRODUCT_A.id,
      boxLabelTemplateId: DEFAULT_BOX_LABEL_TEMPLATE.id,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") return jsonResponse(201, created);
      if (path === "/api/shifts/planning-config") {
        return jsonResponse(200, SHIFT_PLANNING_CONFIG);
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE, BOX_LABEL_TEMPLATE] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);

    const templateSelect = await screen.findByRole("combobox", {
      name: "Шаблон этикетки короба",
    });
    expect(templateSelect.textContent).toContain(
      `Использовать настройку организации — ${DEFAULT_BOX_LABEL_TEMPLATE.name}`,
    );
    expect(screen.queryByRole("combobox", { name: "Шаблон этикетки" })).toBeNull();

    fireEvent.click(screen.getByLabelText("Агрегация"));
    await chooseOption(userEvent.setup(), "Продукт", PRODUCT_A.name);
    fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/shifts" && init?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall?.[1]?.body as string) as Record<string, unknown>;
      expect(body.boxLabelTemplateId).toBe(DEFAULT_BOX_LABEL_TEMPLATE.id);
      expect(body).not.toHaveProperty("labelTemplateId");
      expect(Object.values(body)).not.toContain(BOX_TEMPLATE_SELECTION.organization);
      expect(Object.values(body)).not.toContain(BOX_TEMPLATE_SELECTION.none);
    });
  });

  it("submits an explicit box-template override instead of the organisation default", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") {
        return jsonResponse(201, { ...PLANNED_SHIFT, id: "new-override" });
      }
      if (path === "/api/shifts/planning-config") {
        return jsonResponse(200, SHIFT_PLANNING_CONFIG);
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE, BOX_LABEL_TEMPLATE] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await screen.findByText("Новая смена");
    fireEvent.click(screen.getByLabelText("Агрегация"));
    await chooseOption(userEvent.setup(), "Продукт", PRODUCT_A.name);
    await chooseOption(userEvent.setup(), "Шаблон этикетки короба", BOX_LABEL_TEMPLATE.name);
    fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/shifts" && init?.method === "POST",
      );
      const body = JSON.parse(postCall?.[1]?.body as string) as Record<string, unknown>;
      expect(body.boxLabelTemplateId).toBe(BOX_LABEL_TEMPLATE.id);
      expect(body).not.toHaveProperty("labelTemplateId");
    });
  });

  it("allows validation without any box-template source", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts" && init?.method === "POST") {
        return jsonResponse(201, { ...PLANNED_SHIFT, id: "new-validation" });
      }
      if (path === "/api/shifts/planning-config") {
        return jsonResponse(200, { ...SHIFT_PLANNING_CONFIG, defaultBoxLabelTemplateId: null });
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_B] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    await chooseOption(userEvent.setup(), "Продукт", PRODUCT_B.name);
    expect(screen.getByRole("combobox", { name: "Шаблон этикетки короба" }).textContent).toContain(
      "Использовать настройку организации — Не настроен",
    );
    fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/shifts" && init?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall?.[1]?.body as string) as Record<string, unknown>;
      expect(body).not.toHaveProperty("boxLabelTemplateId");
      expect(body).not.toHaveProperty("labelTemplateId");
    });
  });

  it("blocks aggregation inline when neither organisation nor override has a box template", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/planning-config") {
        return jsonResponse(200, { ...SHIFT_PLANNING_CONFIG, defaultBoxLabelTemplateId: null });
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смены не запланированы");
    fireEvent.click(screen.getAllByRole("button", { name: "Запланировать смену" })[0]!);
    fireEvent.click(await screen.findByLabelText("Агрегация"));
    await chooseOption(userEvent.setup(), "Продукт", PRODUCT_A.name);
    fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));

    expect(await screen.findByText("Для агрегации выберите шаблон этикетки короба")).toBeDefined();
    expect(
      fetchMock.mock.calls.some(([url, init]) => url === "/api/shifts" && init?.method === "POST"),
    ).toBe(false);
  });

  it("shows box/pallet capacity fields only in aggregation mode, and pallet capacity only when pallets are enabled", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
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

    await user.click(screen.getByRole("button", { name: "Сбросить" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/shifts", expect.any(Object));
    });
  }, 10_000);

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
    await screen.findByText("Изменить смену · AUG26-001");

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
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Молоко 1л");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить смену · AUG26-001");

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
        // The SSCC issuer still follows untouched -> omitted. The box-template
        // snapshot is deliberately serialized on every edit, including null.
        expect(body).not.toHaveProperty("ssccIssuerCounterpartyId");
        expect(body.boxLabelTemplateId).toBeNull();
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
    await screen.findByText("Изменить смену · AUG26-001");

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
  }, 10_000);

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
    await screen.findByText("Изменить смену · AUG26-001");

    // Same "default sends null" contract counterpartyId already has its own
    // test for (see "sends counterpartyId: null..."
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

  it("sends boxLabelTemplateId: null when the user explicitly selects no template", async () => {
    const user = userEvent.setup();
    const updated = { ...PLANNED_SHIFT, boxLabelTemplateId: null };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s1" && init?.method === "PATCH") {
        return jsonResponse(200, updated);
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [PLANNED_SHIFT] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Молоко 1л");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить смену · AUG26-001");

    // Same contract as above, for the box label template select: touch it
    // away from its default, then clear it back to the no-template option
    // ("") before submitting, and confirm the payload carries an explicit
    // null rather than a raw empty string.
    await chooseOption(user, "Шаблон этикетки короба", DEFAULT_BOX_LABEL_TEMPLATE.name);
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
    // The counterparty, SSCC issuer, and box-template selects carry different
    // business identities. Assert each rendered value before interaction so a
    // copy-paste error cannot silently display another field's value.
    const shiftWithDistinctFields = {
      ...PLANNED_SHIFT,
      counterpartyId: BUYER.id,
      counterpartyName: BUYER.name,
      ssccIssuerCounterpartyId: BRAND_OWNER.id,
      boxLabelTemplateId: BOX_LABEL_TEMPLATE.id,
    };
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/shifts")) {
        return jsonResponse(200, { items: [shiftWithDistinctFields] });
      }
      if (path === "/api/counterparties") return jsonResponse(200, { items: [BUYER, BRAND_OWNER] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE, BOX_LABEL_TEMPLATE] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Молоко 1л");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить смену · AUG26-001");

    expect(
      screen.getByRole("combobox", { name: "Для контрагента (толлинг)" }).textContent,
    ).toContain(BUYER.name);
    expect(screen.getByRole("combobox", { name: "Эмитент группового кода" }).textContent).toContain(
      BRAND_OWNER.name,
    );
    expect(screen.queryByRole("combobox", { name: "Шаблон этикетки" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Шаблон этикетки короба" }).textContent).toContain(
      BOX_LABEL_TEMPLATE.name,
    );
  });

  it("keeps a planned shift's snapshotted box template when the organisation default changed", async () => {
    const snapshottedShift = {
      ...PLANNED_SHIFT,
      boxLabelTemplateId: BOX_LABEL_TEMPLATE.id,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s1" && init?.method === "PATCH") {
        return jsonResponse(200, snapshottedShift);
      }
      if (path === "/api/shifts/planning-config") {
        return jsonResponse(200, SHIFT_PLANNING_CONFIG);
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [snapshottedShift] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE, BOX_LABEL_TEMPLATE] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText(PLANNED_SHIFT.productName);
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));

    const templateSelect = await screen.findByRole("combobox", {
      name: "Шаблон этикетки короба",
    });
    expect(templateSelect.textContent).toContain(BOX_LABEL_TEMPLATE.name);
    expect(templateSelect.textContent).not.toContain(DEFAULT_BOX_LABEL_TEMPLATE.name);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/shifts/s1" && init?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse(patchCall?.[1]?.body as string) as Record<string, unknown>;
      expect(body.boxLabelTemplateId).toBe(BOX_LABEL_TEMPLATE.id);
      expect(body).not.toHaveProperty("labelTemplateId");
    });
  });

  it("writes the current organisation default when a planned shift adopts it", async () => {
    const snapshottedShift = {
      ...PLANNED_SHIFT,
      boxLabelTemplateId: BOX_LABEL_TEMPLATE.id,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/shifts/s1" && init?.method === "PATCH") {
        return jsonResponse(200, {
          ...snapshottedShift,
          boxLabelTemplateId: DEFAULT_BOX_LABEL_TEMPLATE.id,
        });
      }
      if (path === "/api/shifts/planning-config") {
        return jsonResponse(200, SHIFT_PLANNING_CONFIG);
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [snapshottedShift] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE, BOX_LABEL_TEMPLATE] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText(PLANNED_SHIFT.productName);
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await chooseOption(
      userEvent.setup(),
      "Шаблон этикетки короба",
      `Использовать настройку организации — ${DEFAULT_BOX_LABEL_TEMPLATE.name}`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/shifts/s1" && init?.method === "PATCH",
      );
      const body = JSON.parse(patchCall?.[1]?.body as string) as Record<string, unknown>;
      expect(body.boxLabelTemplateId).toBe(DEFAULT_BOX_LABEL_TEMPLATE.id);
      expect(Object.values(body)).not.toContain(BOX_TEMPLATE_SELECTION.organization);
      expect(Object.values(body)).not.toContain(BOX_TEMPLATE_SELECTION.none);
    });
  });

  it("localizes the organisation inheritance option in English", async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path === "/api/shifts/planning-config") {
          return jsonResponse(200, SHIFT_PLANNING_CONFIG);
        }
        if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
        if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
        if (path === "/api/label-templates") {
          return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE] });
        }
        return jsonResponse(200, { items: [] });
      }),
    );

    renderPage();
    fireEvent.click((await screen.findAllByRole("button", { name: "Plan a shift" }))[0]!);

    expect(
      (await screen.findByRole("combobox", { name: "Box label template" })).textContent,
    ).toContain(`Use organization setting — ${DEFAULT_BOX_LABEL_TEMPLATE.name}`);
    expect(screen.queryByRole("combobox", { name: "Label template" })).toBeNull();
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
      if (path === "/api/shifts/planning-config") {
        return jsonResponse(200, SHIFT_PLANNING_CONFIG);
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE] });
      }
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
      if (path === "/api/shifts/planning-config") {
        return jsonResponse(200, SHIFT_PLANNING_CONFIG);
      }
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.startsWith("/api/products")) return jsonResponse(200, { items: [PRODUCT_A] });
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      if (path === "/api/label-templates") {
        return jsonResponse(200, { items: [DEFAULT_BOX_LABEL_TEMPLATE] });
      }
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

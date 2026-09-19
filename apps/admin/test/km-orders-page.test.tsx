import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { KmOrdersPage } from "../src/pages/km-orders/index.js";

const ACCESS_WRITE: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};
const ACCESS_READ_ONLY: AccessDocument = {
  roles: ["member"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const ID = {
  completed: "11111111-1111-4111-8111-111111111111",
  rejected: "11111111-1111-4111-8111-111111111112",
  fetching: "11111111-1111-4111-8111-111111111113",
  water: "22222222-2222-4222-8222-222222222222",
  beer: "22222222-2222-4222-8222-222222222223",
  juice: "22222222-2222-4222-8222-222222222224",
  archived: "22222222-2222-4222-8222-222222222225",
  noGtin: "22222222-2222-4222-8222-222222222226",
  oms: "33333333-3333-4333-8333-333333333333",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const number = new Intl.NumberFormat("ru");

function inDays(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function agoDays(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function orderRow(overrides: Record<string, unknown>) {
  return {
    id: ID.completed,
    productId: ID.water,
    productName: "Вода газированная 1,0 л",
    gtin14: "04680089900383",
    productGroupAlias: "water",
    templateId: 1,
    quantity: 5000,
    state: "completed",
    omsOrderId: ID.oms,
    bufferStatus: "ACTIVE",
    bufferExpiresAt: inDays(10),
    availableCodes: 0,
    fetchedCount: 5000,
    issuedCount: 1200,
    availableForIssue: 3800,
    rejectionReason: null,
    errorCode: null,
    errorMessage: null,
    attempts: 1,
    createdBy: { id: "user_1", name: "Елена Ким" },
    createdAt: agoDays(2),
    updatedAt: agoDays(1),
    ...overrides,
  };
}

const ORDERS = [
  orderRow({}),
  orderRow({
    id: ID.rejected,
    productId: ID.beer,
    productName: "Пиво светлое 0,45 л",
    gtin14: "04680089900390",
    productGroupAlias: "beer",
    quantity: 3000,
    state: "rejected",
    bufferStatus: null,
    bufferExpiresAt: null,
    fetchedCount: 0,
    issuedCount: 0,
    availableForIssue: 0,
    rejectionReason: "Неверный GTIN",
    createdAt: agoDays(3),
    updatedAt: agoDays(3),
  }),
  orderRow({
    id: ID.fetching,
    productId: ID.juice,
    productName: "Сок яблочный 1,0 л",
    gtin14: "04680089900406",
    productGroupAlias: "juice",
    quantity: 2000,
    state: "fetching",
    bufferStatus: "ACTIVE",
    bufferExpiresAt: inDays(40),
    fetchedCount: 700,
    issuedCount: 0,
    availableForIssue: 700,
    createdAt: agoDays(40),
    updatedAt: agoDays(1),
  }),
];

function product(overrides: Record<string, unknown>) {
  return {
    id: ID.water,
    gtin14: "04680089900383",
    name: "Вода газированная 1,0 л",
    productGroup: "Упакованная вода",
    chzProductGroupCode: 3,
    boxCapacity: 12,
    palletBoxCapacity: 40,
    unitPrice: null,
    printName: null,
    egaisCode: null,
    shelfLifeDays: 180,
    externalRef: null,
    status: "active",
    archived: false,
    defaultCounterpartyId: null,
    createdAt: agoDays(100),
    ...overrides,
  };
}

const PRODUCTS = [
  product({}),
  product({ id: ID.beer, gtin14: "04680089900390", name: "Пиво светлое 0,45 л" }),
  product({
    id: ID.archived,
    gtin14: "04680089900413",
    name: "Кефир 0,5 л",
    archived: true,
  }),
  product({ id: ID.noGtin, gtin14: "", name: "Черновик без GTIN" }),
];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

interface RenderOptions {
  access?: AccessDocument;
  orders?: unknown[];
  onCreate?: (body: unknown) => Response;
}

function renderPage(options: RenderOptions = {}) {
  const access = options.access ?? ACCESS_WRITE;
  const orders = options.orders ?? ORDERS;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "/api/chz-km-orders" && init?.method === "POST") {
        const create = options.onCreate;
        if (!create) throw new Error("Unexpected create request");
        return create(JSON.parse(String(init.body)));
      }
      if (url === "/api/chz-km-orders") return jsonResponse({ orders });
      if (url === "/api/products") return jsonResponse({ items: PRODUCTS });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const router = createMemoryRouter(
    createRoutesFromElements(
      <>
        <Route path="/km-orders" element={<KmOrdersPage />} />
        <Route path="/km-orders/:orderId" element={<div>Карточка заказа</div>} />
        <Route path="/integrations/:type" element={<div>Интеграция</div>} />
      </>,
    ),
    { initialEntries: ["/km-orders"] },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <AccessProvider value={access}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { router, requests, user: userEvent.setup() };
}

/**
 * The product list arrives from its own request, and the Select stays disabled
 * until it does -- clicking before that opens nothing, so every test that
 * picks a product goes through here instead of racing the query.
 */
async function openProductSelect(): Promise<void> {
  const trigger = await screen.findByRole("combobox", { name: "Продукт" });
  await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
  fireEvent.click(trigger);
}

function metricValue(label: string): string {
  const term = screen.getByText(label);
  const item = term.closest(".mk-metric-strip__item");
  if (!item) throw new Error(`No metric tile for ${label}`);
  return within(item as HTMLElement).getByRole("definition").textContent ?? "";
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("lists every order with its product, GTIN and translated state chip", async () => {
  renderPage();

  expect(await screen.findByText("Вода газированная 1,0 л")).toBeDefined();
  expect(screen.getByText("Пиво светлое 0,45 л")).toBeDefined();
  expect(screen.getByText("Сок яблочный 1,0 л")).toBeDefined();
  expect(screen.getByText("04680089900383")).toBeDefined();
  expect(screen.getByText("Завершён")).toBeDefined();
  expect(screen.getByText("Отклонён СУЗ")).toBeDefined();
  expect(screen.getByText("Получение кодов")).toBeDefined();
});

it("computes the four KPI tiles from the list alone", async () => {
  renderPage();

  await screen.findByText("Вода газированная 1,0 л");
  expect(metricValue("Доступно к выдаче")).toContain(number.format(4500));
  expect(metricValue("Истекают в 14 дней")).toContain(number.format(3800));
  expect(metricValue("Активных заказов")).toContain("1");
  expect(metricValue("Выдано за 30 дней")).toContain(number.format(1200));
});

it("links every row to its order card", async () => {
  const { router, user } = renderPage();

  await user.click(await screen.findByRole("link", { name: "Вода газированная 1,0 л" }));

  await waitFor(() => expect(router.state.location.pathname).toBe(`/km-orders/${ID.completed}`));
});

it("opens the order dialog with a product select and a quantity input", async () => {
  const { user } = renderPage();

  await user.click(await screen.findByRole("button", { name: "Заказать коды" }));

  const dialog = await screen.findByRole("dialog", { name: "Заказ кодов маркировки" });
  expect(within(dialog).getByRole("combobox", { name: "Продукт" })).toBeDefined();
  expect(within(dialog).getByLabelText("Количество кодов")).toBeDefined();
  expect(within(dialog).getByLabelText("Контактное лицо")).toBeDefined();
});

it("offers only products that carry a GTIN and are not archived", async () => {
  const { user } = renderPage();

  await user.click(await screen.findByRole("button", { name: "Заказать коды" }));
  await openProductSelect();

  expect(await screen.findByRole("option", { name: /Вода газированная/ })).toBeDefined();
  expect(screen.getByRole("option", { name: /Пиво светлое/ })).toBeDefined();
  expect(screen.queryByRole("option", { name: /Кефир/ })).toBeNull();
  expect(screen.queryByRole("option", { name: /Черновик без GTIN/ })).toBeNull();
});

it("posts the chosen product, quantity and contact person", async () => {
  const { requests, user } = renderPage({
    onCreate: () => jsonResponse({ ...orderRow({ state: "created" }), issues: [] }, 201),
  });

  await user.click(await screen.findByRole("button", { name: "Заказать коды" }));
  await openProductSelect();
  fireEvent.click(await screen.findByRole("option", { name: /Вода газированная/ }));
  const quantity = screen.getByLabelText("Количество кодов");
  await user.clear(quantity);
  await user.type(quantity, "2500");
  await user.type(screen.getByLabelText("Контактное лицо"), "Елена Ким");
  await user.click(screen.getByRole("button", { name: "Заказать" }));

  await waitFor(() =>
    expect(
      requests.some(({ url, init }) => url === "/api/chz-km-orders" && init?.method === "POST"),
    ).toBe(true),
  );
  const create = requests.find(
    ({ url, init }) => url === "/api/chz-km-orders" && init?.method === "POST",
  );
  expect(JSON.parse(String(create?.init?.body))).toEqual({
    productId: ID.water,
    quantity: 2500,
    contactPerson: "Елена Ким",
  });
});

it("renders every preflight blocker the server reported", async () => {
  const { user } = renderPage({
    onCreate: () =>
      jsonResponse(
        {
          code: "CHZ_KM_ORDER_PREFLIGHT_FAILED",
          blockedBy: ["AGENT_NOT_PAIRED", "OMS_SETTINGS_MISSING"],
        },
        422,
      ),
  });

  await user.click(await screen.findByRole("button", { name: "Заказать коды" }));
  await openProductSelect();
  fireEvent.click(await screen.findByRole("option", { name: /Вода газированная/ }));
  await user.click(screen.getByRole("button", { name: "Заказать" }));

  expect(await screen.findByText("Подключите агент КЭП в разделе «Интеграции»")).toBeDefined();
  expect(screen.getByText("Заполните настройки СУЗ в разделе «Интеграции»")).toBeDefined();
});

it("refuses a quantity outside the СУЗ limits before sending anything", async () => {
  const { requests, user } = renderPage();

  await user.click(await screen.findByRole("button", { name: "Заказать коды" }));
  await openProductSelect();
  fireEvent.click(await screen.findByRole("option", { name: /Вода газированная/ }));
  const quantity = screen.getByLabelText("Количество кодов");
  await user.clear(quantity);
  await user.type(quantity, "150001");
  await user.click(screen.getByRole("button", { name: "Заказать" }));

  expect(await screen.findByText("Укажите от 1 до 150 000 кодов.")).toBeDefined();
  expect(requests.some(({ init }) => init?.method === "POST")).toBe(false);
});

it("hides the order action from a read-only grant", async () => {
  renderPage({ access: ACCESS_READ_ONLY });

  await screen.findByText("Вода газированная 1,0 л");
  expect(screen.queryByRole("button", { name: "Заказать коды" })).toBeNull();
});

it("explains the СУЗ prerequisites and links to the channel when there is nothing yet", async () => {
  renderPage({ orders: [] });

  expect(await screen.findByText("Заказов кодов пока нет")).toBeDefined();
  const link = screen.getByRole("link", { name: "Настройки Честного Знака" });
  expect(link.getAttribute("href")).toBe("/integrations/chestny_znak");
});

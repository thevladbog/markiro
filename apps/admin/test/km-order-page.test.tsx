import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY, KM_LABEL_TEMPLATE_NAME } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { formatCreatedAt } from "../src/lib/datetime.js";
import { KmOrderPage } from "../src/pages/km-orders/KmOrderPage.js";

const ACCESS_WRITE: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};
const ACCESS_READ_ONLY: AccessDocument = {
  roles: ["member"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const ID = {
  order: "11111111-1111-4111-8111-111111111111",
  product: "22222222-2222-4222-8222-222222222222",
  oms: "33333333-3333-4333-8333-333333333333",
  exportIssue: "44444444-4444-4444-8444-444444444441",
  printIssue: "44444444-4444-4444-8444-444444444442",
  freshIssue: "44444444-4444-4444-8444-444444444443",
} as const;

const TEMPLATE = {
  stock: "tpl_km_stock",
  water: "tpl_km_water",
  beer: "tpl_km_beer",
  box: "tpl_box",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const number = new Intl.NumberFormat("ru");
/**
 * `Intl` groups with a no-break space; testing-library normalises every run of
 * whitespace in the DOM to a plain space before matching, so text assertions
 * compare against the same normalisation.
 */
function n(value: number): string {
  return number.format(value).replaceAll("\u00a0", " ");
}

function inDays(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function agoDays(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

const EXPIRES_AT = inDays(62);

const ISSUES = [
  {
    id: ID.exportIssue,
    kind: "export",
    format: "txt",
    fromSeq: 1,
    toSeq: 1000,
    count: 1000,
    createdBy: { id: "user_1", name: "Елена Ким" },
    createdAt: agoDays(2),
  },
  {
    id: ID.printIssue,
    kind: "print",
    format: null,
    fromSeq: 1001,
    toSeq: 1200,
    count: 200,
    createdBy: { id: "user_1", name: "Елена Ким" },
    createdAt: agoDays(1),
  },
];

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.order,
    productId: ID.product,
    productName: "Вода газированная 1,0 л",
    gtin14: "04680089900383",
    productGroupAlias: "water",
    templateId: 16,
    quantity: 5000,
    state: "completed",
    omsOrderId: ID.oms,
    bufferStatus: "ACTIVE",
    bufferExpiresAt: EXPIRES_AT,
    availableCodes: 0,
    fetchedCount: 5000,
    issuedCount: 1200,
    availableForIssue: 3800,
    rejectionReason: null,
    errorCode: null,
    errorMessage: null,
    attempts: 1,
    createdBy: { id: "user_1", name: "Елена Ким" },
    createdAt: agoDays(3),
    updatedAt: agoDays(2),
    issues: ISSUES,
    ...overrides,
  };
}

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE.stock,
    name: KM_LABEL_TEMPLATE_NAME,
    purpose: "product_km",
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    enabled: true,
    chzProductGroupCodes: null,
    updatedAt: agoDays(30),
    ...overrides,
  };
}

const TEMPLATES = [
  template({ id: TEMPLATE.water, name: "КМ для воды", chzProductGroupCodes: [3] }),
  template({ id: TEMPLATE.beer, name: "КМ для пива", chzProductGroupCodes: [7] }),
  template({ id: TEMPLATE.box, name: "Короб 100×150", purpose: "box" }),
  template({}),
];

const GROUPS = [
  { code: 3, alias: "water", name: "Упакованная вода" },
  { code: 7, alias: "beer", name: "Пиво" },
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
  card?: Record<string, unknown>;
  templates?: unknown[];
  onIssue?: (body: unknown) => Response;
  onRetry?: () => Response;
}

const originalLocation = window.location;

function renderCard(options: RenderOptions = {}) {
  const card = options.card ?? order();
  const orderUrl = `/api/chz-km-orders/${String(card.id)}`;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === `${orderUrl}/issues` && init?.method === "POST") {
        const issue = options.onIssue;
        if (!issue) throw new Error("Unexpected issue request");
        return issue(JSON.parse(String(init.body)));
      }
      if (url === `${orderUrl}/retry` && init?.method === "POST") {
        const retry = options.onRetry;
        if (!retry) throw new Error("Unexpected retry request");
        return retry();
      }
      if (url === orderUrl) return jsonResponse(card);
      if (url === "/api/label-templates?enabled=true") {
        return jsonResponse({ items: options.templates ?? TEMPLATES });
      }
      if (url === "/api/chz-product-groups") return jsonResponse({ items: GROUPS });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const open = vi.fn();
  vi.stubGlobal("open", open);
  const assign = vi.fn();
  // `window.location.assign` is non-configurable in JSDOM, so the whole
  // location object is swapped for the duration of the test (restored in
  // `afterEach`); the page routes through a memory router and never reads it.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, assign, href: originalLocation.href },
  });

  const router = createMemoryRouter(
    createRoutesFromElements(
      <>
        <Route path="/km-orders" element={<div>Список заказов</div>} />
        <Route path="/km-orders/:orderId" element={<KmOrderPage />} />
      </>,
    ),
    { initialEntries: [`/km-orders/${String(card.id)}`] },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <AccessProvider value={options.access ?? ACCESS_WRITE}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { requests, router, open, assign, user: userEvent.setup() };
}

function counterValue(label: string): string {
  const term = screen.getByText(label);
  const item = term.closest(".mk-metric-strip__item");
  if (!item) throw new Error(`No counter tile for ${label}`);
  return within(item as HTMLElement).getByRole("definition").textContent ?? "";
}

async function openIssueDialog(action: string, title: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: action }));
  return screen.findByRole("dialog", { name: title });
}

async function typeCount(dialog: HTMLElement, value: string): Promise<HTMLElement> {
  const count = within(dialog).getByLabelText("Сколько кодов выдать");
  fireEvent.change(count, { target: { value } });
  return count;
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  await i18n.changeLanguage("ru");
});

it("shows the four counters, the issued progress and the buffer deadline", async () => {
  renderCard();

  expect(await screen.findByRole("heading", { name: "Вода газированная 1,0 л" })).toBeDefined();
  expect(counterValue("Заказано")).toContain(number.format(5000));
  expect(counterValue("Получено")).toContain(number.format(5000));
  expect(counterValue("Выдано")).toContain(number.format(1200));
  expect(counterValue("Доступно к выдаче")).toContain(number.format(3800));

  expect(screen.getByText(`Выдано ${n(1200)} из ${n(5000)}`)).toBeDefined();
  const progress = screen.getByRole("progressbar");
  expect(progress.getAttribute("aria-valuenow")).toBe("1200");
  expect(progress.getAttribute("aria-valuemax")).toBe("5000");

  const deadline = formatCreatedAt(EXPIRES_AT, "ru");
  expect(
    screen.getByText(
      `Заказ в СУЗ действует до ${deadline}. Успейте выдать оставшиеся коды до этой даты.`,
    ),
  ).toBeDefined();
});

it("lists every issue with its range and a repeat action", async () => {
  renderCard();

  expect(await screen.findByText(`№ 1 – ${n(1000)}`)).toBeDefined();
  expect(screen.getByText(`№ ${n(1001)} – ${n(1200)}`)).toBeDefined();
  expect(screen.getByRole("button", { name: "Скачать ещё раз" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Печать ещё раз" })).toBeDefined();
});

it("re-downloads an export issue from its own file URL", async () => {
  const { assign, user } = renderCard();

  await user.click(await screen.findByRole("button", { name: "Скачать ещё раз" }));

  expect(assign).toHaveBeenCalledWith(
    `/api/chz-km-orders/${ID.order}/issues/${ID.exportIssue}/file`,
  );
});

it("reopens a print issue on its own print page", async () => {
  const { open, user } = renderCard();

  await user.click(await screen.findByRole("button", { name: "Печать ещё раз" }));

  expect(open).toHaveBeenCalledWith(
    `/km-orders/${ID.order}/issues/${ID.printIssue}/print`,
    "_blank",
  );
});

it("previews the exact range the server will issue next", async () => {
  renderCard();

  const dialog = await openIssueDialog("Печать", "Печать кодов");
  await typeCount(dialog, "500");

  // 1 200 codes are already issued, and the server hands out the lowest
  // still-available codes starting at `issuedCount + 1`.
  expect(within(dialog).getByText(`№ ${n(1201)} – ${n(1700)}`)).toBeDefined();
});

it("offers TXT and CSV for an export and posts the chosen format", async () => {
  const { requests, assign, user } = renderCard({
    onIssue: () =>
      jsonResponse(
        {
          id: ID.freshIssue,
          kind: "export",
          format: "csv",
          fromSeq: 1201,
          toSeq: 1300,
          count: 100,
          createdBy: { id: "user_1", name: "Елена Ким" },
          createdAt: new Date().toISOString(),
        },
        201,
      ),
  });

  const dialog = await openIssueDialog("Выгрузить", "Выгрузка кодов в файл");
  expect(within(dialog).getByRole("radio", { name: /TXT/ })).toBeDefined();
  const csv = within(dialog).getByRole("radio", { name: /CSV/ });
  await user.click(csv);
  await typeCount(dialog, "100");
  await user.click(within(dialog).getByRole("button", { name: "Выгрузить" }));

  await waitFor(() =>
    expect(
      requests.some(
        ({ url, init }) =>
          url === `/api/chz-km-orders/${ID.order}/issues` && init?.method === "POST",
      ),
    ).toBe(true),
  );
  const issue = requests.find(({ init }) => init?.method === "POST");
  expect(JSON.parse(String(issue?.init?.body))).toEqual({
    kind: "export",
    format: "csv",
    count: 100,
  });
  await waitFor(() =>
    expect(assign).toHaveBeenCalledWith(
      `/api/chz-km-orders/${ID.order}/issues/${ID.freshIssue}/file`,
    ),
  );
});

it("offers only the KM templates this order's product group may print", async () => {
  renderCard();

  const dialog = await openIssueDialog("Печать", "Печать кодов");
  const templates = within(dialog).getByRole("combobox", { name: "Шаблон этикетки" });
  await waitFor(() => expect(templates.hasAttribute("disabled")).toBe(false));
  // The stock KM label every tenant is seeded with, chosen for the operator.
  expect(templates.textContent).toContain(KM_LABEL_TEMPLATE_NAME);

  fireEvent.click(templates);
  expect(await screen.findByRole("option", { name: "КМ для воды" })).toBeDefined();
  // A template scoped to another product group, and a box template, are not
  // KM labels for this order.
  expect(screen.queryByRole("option", { name: "КМ для пива" })).toBeNull();
  expect(screen.queryByRole("option", { name: "Короб 100×150" })).toBeNull();
});

it("prints the chosen range through the preselected stock template", async () => {
  const { requests, open, user } = renderCard({
    onIssue: () =>
      jsonResponse(
        {
          id: ID.freshIssue,
          kind: "print",
          format: null,
          fromSeq: 1201,
          toSeq: 1700,
          count: 500,
          createdBy: { id: "user_1", name: "Елена Ким" },
          createdAt: new Date().toISOString(),
        },
        201,
      ),
  });

  const dialog = await openIssueDialog("Печать", "Печать кодов");
  const templates = within(dialog).getByRole("combobox", { name: "Шаблон этикетки" });
  await waitFor(() => expect(templates.hasAttribute("disabled")).toBe(false));
  await typeCount(dialog, "500");
  await user.click(within(dialog).getByRole("button", { name: "Напечатать" }));

  await waitFor(() => expect(requests.some(({ init }) => init?.method === "POST")).toBe(true));
  const issue = requests.find(({ init }) => init?.method === "POST");
  expect(JSON.parse(String(issue?.init?.body))).toEqual({ kind: "print", count: 500 });
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith(
      `/km-orders/${ID.order}/issues/${ID.freshIssue}/print?template=${TEMPLATE.stock}`,
      "_blank",
    ),
  );
});

it("caps «Все» at what is left, and at the print batch limit", async () => {
  const { user } = renderCard({
    card: order({
      quantity: 20_000,
      fetchedCount: 20_000,
      issuedCount: 0,
      availableForIssue: 20_000,
      issues: [],
    }),
  });

  const printDialog = await openIssueDialog("Печать", "Печать кодов");
  await user.click(within(printDialog).getByRole("button", { name: "Все" }));
  // Print is capped at 5 000 codes per batch, so «Все» stops there.
  expect(within(printDialog).getByText(`№ 1 – ${n(5000)}`)).toBeDefined();
  await user.click(within(printDialog).getByRole("button", { name: "Отмена" }));

  const exportDialog = await openIssueDialog("Выгрузить", "Выгрузка кодов в файл");
  await user.click(within(exportDialog).getByRole("button", { name: "Все" }));
  expect(within(exportDialog).getByText(`№ 1 – ${n(20_000)}`)).toBeDefined();
});

it("refuses a count above what is left instead of previewing it", async () => {
  const { requests } = renderCard();

  const dialog = await openIssueDialog("Выгрузить", "Выгрузка кодов в файл");
  await typeCount(dialog, "4000");

  expect(within(dialog).getByText(`Укажите от 1 до ${n(3800)} кодов.`)).toBeDefined();
  expect(within(dialog).queryByText(/№ /)).toBeNull();
  expect(requests.some(({ init }) => init?.method === "POST")).toBe(false);
});

it("reports how many codes are left when the server refuses the issue", async () => {
  const { user } = renderCard({
    onIssue: () => jsonResponse({ code: "CHZ_KM_ISSUE_TOO_MANY", available: 120 }, 409),
  });

  const dialog = await openIssueDialog("Выгрузить", "Выгрузка кодов в файл");
  await typeCount(dialog, "500");
  await user.click(within(dialog).getByRole("button", { name: "Выгрузить" }));

  expect(
    await within(dialog).findByText(`Осталось только ${n(120)} кодов. Уменьшите количество.`),
  ).toBeDefined();
});

it("reads out the refusal of a rejected order and offers no issue action", async () => {
  renderCard({
    card: order({
      state: "rejected",
      rejectionReason: "Неверный GTIN",
      fetchedCount: 0,
      issuedCount: 0,
      availableForIssue: 0,
      bufferExpiresAt: null,
      issues: [],
    }),
  });

  expect(await screen.findByText("Неверный GTIN")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Выгрузить" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Печать" })).toBeNull();
  expect(screen.getByText("Коды по этому заказу ещё не выдавались")).toBeDefined();
});

it("retries a failed order", async () => {
  const { requests, user } = renderCard({
    card: order({
      state: "failed",
      errorCode: "OMS_UNAVAILABLE",
      errorMessage: "СУЗ не отвечает",
      fetchedCount: 0,
      issuedCount: 0,
      availableForIssue: 0,
      issues: [],
    }),
    onRetry: () => jsonResponse(order({ state: "created", omsOrderId: null, issues: [] })),
  });

  expect(await screen.findByText("СУЗ не отвечает")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Повторить" }));

  await waitFor(() =>
    expect(
      requests.some(
        ({ url, init }) =>
          url === `/api/chz-km-orders/${ID.order}/retry` && init?.method === "POST",
      ),
    ).toBe(true),
  );
});

it("hides every issue action from a read-only grant", async () => {
  renderCard({ access: ACCESS_READ_ONLY });

  expect(await screen.findByRole("heading", { name: "Вода газированная 1,0 л" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Выгрузить" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Печать" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Скачать ещё раз" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Печать ещё раз" })).toBeNull();
});

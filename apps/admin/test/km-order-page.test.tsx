import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY, KM_LABEL_TEMPLATE_NAME } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { formatCreatedAt } from "../src/lib/datetime.js";
import { KmOrderPage, kmOrderTimeline } from "../src/pages/km-orders/KmOrderPage.js";
import { kmOrderSchema } from "../src/pages/km-orders/schemas.js";

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
/** Fixed once: every `order()` describes the same order, to the millisecond. */
const CREATED_AT = agoDays(3);
const UPDATED_AT = agoDays(2);

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
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
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

/** The issue `POST /issues` answers with for a 500-code print of this order. */
const FRESH_PRINT_ISSUE = {
  id: ID.freshIssue,
  kind: "print",
  format: null,
  fromSeq: 1201,
  toSeq: 1700,
  count: 500,
  createdBy: { id: "user_1", name: "Елена Ким" },
  createdAt: new Date().toISOString(),
};
const FRESH_PRINT_HREF = `/km-orders/${ID.order}/issues/${ID.freshIssue}/print?template=${TEMPLATE.stock}`;

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
  /** Fails `GET /chz-product-groups`, which decides which templates are eligible. */
  groupsFail?: boolean;
  /** Makes `window.open` answer `null`, the way a popup blocker does. */
  popupBlocked?: boolean;
  /** Answer every re-read of the order with this card, as a refresh would. */
  nextCard?: Record<string, unknown>;
  onIssue?: (body: unknown) => Response | Promise<Response>;
  onRetry?: () => Response;
}

const originalLocation = window.location;

function renderCard(options: RenderOptions = {}) {
  const card = options.card ?? order();
  const orderUrl = `/api/chz-km-orders/${String(card.id)}`;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  let cardReads = 0;
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
      if (url === orderUrl) {
        cardReads += 1;
        const next = options.nextCard;
        return jsonResponse(cardReads > 1 && next !== undefined ? next : card);
      }
      if (url === "/api/label-templates?enabled=true") {
        return jsonResponse({ items: options.templates ?? TEMPLATES });
      }
      if (url === "/api/chz-product-groups") {
        return options.groupsFail === true
          ? jsonResponse({ code: "INTERNAL_ERROR" }, 500)
          : jsonResponse({ items: GROUPS });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  // A real `window.open` answers with the new tab's window, or `null` when a
  // popup blocker swallows it -- the difference that decides whether the issue
  // dialog may close. `window` itself stands in for the tab.
  const open = vi.fn((): Window | null => (options.popupBlocked === true ? null : window));
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AccessProvider value={options.access ?? ACCESS_WRITE}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { requests, router, open, assign, client, user: userEvent.setup() };
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

it("hands over the address when a popup blocker swallows the reprint tab", async () => {
  // A reprint spends no codes, so nothing is lost -- but a button that does
  // nothing at all reads as a broken cabinet, and the page is still reachable.
  const { user } = renderCard({ popupBlocked: true });

  await user.click(await screen.findByRole("button", { name: "Печать ещё раз" }));

  expect(await screen.findByText("Вкладка печати не открылась")).toBeDefined();
  expect(screen.getByRole("link", { name: "Открыть страницу печати" }).getAttribute("href")).toBe(
    `/km-orders/${ID.order}/issues/${ID.printIssue}/print`,
  );
});

it("previews the exact range the server will issue next", async () => {
  renderCard();

  const dialog = await openIssueDialog("Печать", "Печать кодов");
  await typeCount(dialog, "500");

  // 1 200 codes are already issued, and the server hands out the lowest
  // still-available codes starting at `issuedCount + 1`.
  const range = within(dialog).getByText(`№ ${n(1201)} – ${n(1700)}`);
  // The range is its own node with nothing around it moving, so a screen
  // reader only hears it change if it announces itself.
  expect(range.getAttribute("aria-live")).toBe("polite");
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
    onIssue: () => jsonResponse(FRESH_PRINT_ISSUE, 201),
  });

  const dialog = await openIssueDialog("Печать", "Печать кодов");
  const templates = within(dialog).getByRole("combobox", { name: "Шаблон этикетки" });
  await waitFor(() => expect(templates.hasAttribute("disabled")).toBe(false));
  await typeCount(dialog, "500");
  await user.click(within(dialog).getByRole("button", { name: "Напечатать" }));

  await waitFor(() => expect(requests.some(({ init }) => init?.method === "POST")).toBe(true));
  const issue = requests.find(({ init }) => init?.method === "POST");
  expect(JSON.parse(String(issue?.init?.body))).toEqual({ kind: "print", count: 500 });
  await waitFor(() => expect(open).toHaveBeenCalledWith(FRESH_PRINT_HREF, "_blank"));
  // The tab opened, so the dialog has delivered the batch and may go.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps the dialog and links to the batch when the print tab is blocked", async () => {
  const { requests, open, user } = renderCard({
    popupBlocked: true,
    onIssue: () => jsonResponse(FRESH_PRINT_ISSUE, 201),
  });

  const dialog = await openIssueDialog("Печать", "Печать кодов");
  const templates = within(dialog).getByRole("combobox", { name: "Шаблон этикетки" });
  await waitFor(() => expect(templates.hasAttribute("disabled")).toBe(false));
  await typeCount(dialog, "500");
  await user.click(within(dialog).getByRole("button", { name: "Напечатать" }));

  await waitFor(() => expect(open).toHaveBeenCalledWith(FRESH_PRINT_HREF, "_blank"));
  // The 500 codes are spent and unrecoverable: the dialog stays, says so, and
  // hands over the page the swallowed tab would have shown.
  expect(
    await within(dialog).findByText("Коды выданы, но вкладка печати не открылась"),
  ).toBeDefined();
  const link = within(dialog).getByRole("link", { name: "Открыть страницу печати" });
  expect(link.getAttribute("href")).toBe(FRESH_PRINT_HREF);
  expect(link).toBe(document.activeElement);
  // Nothing left to click that would burn a second batch by reflex.
  expect(within(dialog).queryByRole("button", { name: "Напечатать" })).toBeNull();
  expect(requests.filter(({ init }) => init?.method === "POST")).toHaveLength(1);
});

it("blocks the print when the product groups could not be loaded", async () => {
  const { requests, user } = renderCard({ groupsFail: true });

  const dialog = await openIssueDialog("Печать", "Печать кодов");
  expect(
    await within(dialog).findByText(
      "Не удалось загрузить справочник групп продукции. Обновите страницу и повторите.",
    ),
  ).toBeDefined();
  // The tenant is never told its own template does not exist because a
  // request failed.
  expect(within(dialog).queryByText(/Нет шаблонов КМ/)).toBeNull();
  // Without the group reference every group-scoped template silently drops
  // out, so the picker must not stay open on whatever is left of the list.
  const templates = within(dialog).getByRole("combobox", { name: "Шаблон этикетки" });
  expect(templates.hasAttribute("disabled")).toBe(true);

  await typeCount(dialog, "500");
  await user.click(within(dialog).getByRole("button", { name: "Напечатать" }));

  expect(requests.some(({ init }) => init?.method === "POST")).toBe(false);
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
  const { requests, user } = renderCard();

  const dialog = await openIssueDialog("Выгрузить", "Выгрузка кодов в файл");
  await typeCount(dialog, "4000");

  expect(within(dialog).getByText(`Укажите от 1 до ${n(3800)} кодов.`)).toBeDefined();
  expect(within(dialog).queryByText(/№ /)).toBeNull();
  // The submit button is not disabled, so the handler's own guard is the only
  // thing between an over-large count and a request the server would have to
  // refuse: press it.
  await user.click(within(dialog).getByRole("button", { name: "Выгрузить" }));
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
  // The refused range must not stay on screen next to a smaller count.
  expect(within(dialog).queryByText(`№ ${n(1201)} – ${n(1700)}`)).toBeNull();
  expect(within(dialog).getByText("Укажите количество кодов.")).toBeDefined();
});

/**
 * Fires on every refusal that is not the too-many-codes conflict -- including
 * the one that matters: the server committed the issue and the answer was
 * lost. "Try again" would burn a second batch, so the copy has to point at
 * the issue history instead.
 */
it("sends a lost issue answer to the issue history rather than inviting a repeat", async () => {
  const { user } = renderCard({
    onIssue: () => jsonResponse({ code: "INTERNAL_ERROR" }, 500),
  });

  const dialog = await openIssueDialog("Печать", "Печать кодов");
  await typeCount(dialog, "500");
  await user.click(within(dialog).getByRole("button", { name: "Напечатать" }));

  const message = await within(dialog).findByText(/Не удалось подтвердить выдачу кодов/);
  expect(message.textContent).toContain("Выдачи кодов");
  expect(message.textContent).not.toContain("Повторите попытку");
});

/**
 * The server commits the issue the moment the request lands, and the parent
 * renders this dialog only while a mode is selected -- so a close during the
 * round trip unmounts it and the operator reads the untouched card as "I
 * cancelled, so nothing happened".
 */
it("refuses to close while the issue request is still in the air", async () => {
  let release: (() => void) | undefined;
  const { user } = renderCard({
    onIssue: () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(jsonResponse(FRESH_PRINT_ISSUE, 201));
      }),
  });

  const dialog = await openIssueDialog("Выгрузить", "Выгрузка кодов в файл");
  await typeCount(dialog, "500");
  await user.click(within(dialog).getByRole("button", { name: "Выгрузить" }));

  await user.click(within(dialog).getByRole("button", { name: "Отмена" }));
  expect(await within(dialog).findByText(/Запрос на выдачу уже отправлен/)).toBeDefined();

  // Escape and the × are the same close, and must behave the same way.
  fireEvent.keyDown(dialog, { key: "Escape" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть" }));
  expect(screen.getByRole("dialog", { name: "Выгрузка кодов в файл" })).toBeDefined();

  release?.();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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

it("names the exhausted order instead of asking for «от 1 до 0» codes", async () => {
  // A refresh while the dialog is open can take the last codes away -- the
  // «Все» button already guards it, and the message has to as well.
  const { client, user } = renderCard({
    nextCard: order({ issuedCount: 5000, availableForIssue: 0 }),
  });

  const dialog = await openIssueDialog("Печать", "Печать кодов");
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["km-orders", ID.order] });
  });
  await typeCount(dialog, "500");
  await user.click(within(dialog).getByRole("button", { name: "Напечатать" }));

  expect(within(dialog).getByText("Свободных кодов в этом заказе не осталось.")).toBeDefined();
  expect(within(dialog).queryByText(/Укажите от 1 до/)).toBeNull();
});

it("pins «Ход заказа» and «Сведения о заказе», including the rows the DTO cannot fill", async () => {
  renderCard();

  const timeline = (await screen.findByRole("heading", { name: "Ход заказа" })).closest(".mk-card");
  if (!timeline) throw new Error("No timeline card");
  expect(
    within(timeline as HTMLElement)
      .getAllByRole("listitem")
      .map((step) => step.textContent),
  ).toEqual([
    `✓СозданВыполнено${formatCreatedAt(CREATED_AT, "ru")}`,
    "✓ПодписаниеВыполнено",
    "✓Отправлен в СУЗВыполнено",
    "✓Ожидание буфераВыполнено",
    "✓Буфер готовВыполнено",
    "✓Получение кодовВыполнено",
    `●ЗавершёнСейчас${formatCreatedAt(UPDATED_AT, "ru")}`,
  ]);
  expect(
    within(timeline as HTMLElement).getByText("Создал: Елена Ким", { exact: false }),
  ).toBeDefined();

  const details = screen.getByRole("heading", { name: "Сведения о заказе" }).closest(".mk-card");
  if (!details) throw new Error("No details card");
  // The exact row set, so the two constants stay and the rows this cabinet
  // has no value for -- payment, contact person -- are not invented later.
  expect(
    within(details as HTMLElement)
      .getAllByRole("term")
      .map((term) => term.textContent),
  ).toEqual([
    "Заказ в СУЗ",
    "Статус буфера",
    "Группа продукции",
    "Шаблон СУЗ",
    "Серийные номера",
    "Способ выпуска",
    "Создал",
  ]);
  expect(within(details as HTMLElement).getByText("Присваивает оператор")).toBeDefined();
  expect(within(details as HTMLElement).getByText("Производство")).toBeDefined();

  // `kmOrderTimeline` itself: a terminal state outside the pipeline keeps the
  // two timestamps the DTO has and claims nothing about the steps between.
  const failed = kmOrderSchema.parse(order({ state: "failed", errorCode: "OMS_UNAVAILABLE" }));
  expect(kmOrderTimeline(failed)).toEqual([
    { state: "created", status: "done", at: failed.createdAt },
    { state: "failed", status: "current", at: failed.updatedAt },
  ]);
  const inFlight = kmOrderSchema.parse(order({ state: "fetching" }));
  expect(kmOrderTimeline(inFlight).map((step) => `${step.state}:${step.status}`)).toEqual([
    "created:done",
    "signing:done",
    "submitted:done",
    "buffer_pending:done",
    "buffer_active:done",
    "fetching:current",
    "completed:pending",
  ]);
  expect(kmOrderTimeline(inFlight).map((step) => step.at)).toEqual([
    inFlight.createdAt,
    null,
    null,
    null,
    null,
    inFlight.updatedAt,
    null,
  ]);
});

/**
 * The runner writes one of `KM_ORDER_ERROR_CODES` and leaves `errorMessage`
 * null for all but the СУЗ refusals, so without a translation the office
 * reads a bare identifier in an otherwise Russian cabinet.
 */
it("translates the failure code the runner wrote instead of printing it raw", async () => {
  renderCard({
    card: order({
      state: "failed",
      errorCode: "CHZ_CODES_INCOMPLETE",
      errorMessage: null,
      fetchedCount: 4000,
      issuedCount: 0,
      availableForIssue: 0,
      bufferExpiresAt: null,
      issues: [],
    }),
  });

  expect(await screen.findByText(/СУЗ выдал меньше кодов, чем было заказано/)).toBeDefined();
  expect(screen.queryByText("CHZ_CODES_INCOMPLETE")).toBeNull();
});

it("translates the code that says the order was submitted but not recorded", async () => {
  renderCard({
    card: order({
      state: "failed",
      errorCode: "CHZ_ORDER_SUBMIT_UNRECORDED",
      errorMessage: null,
      fetchedCount: 0,
      issuedCount: 0,
      availableForIssue: 0,
      bufferExpiresAt: null,
      issues: [],
    }),
  });

  // The one code whose recovery is outside this cabinet: the order is billed,
  // so the operator must look in СУЗ before ordering again.
  const message = await screen.findByText(/Заказ принят и оплачен в СУЗ/);
  expect(message.textContent).toContain("Честного Знака");
});

it("falls back to the raw identifier for a code this build does not know", async () => {
  // Better an untranslated identifier to quote to support than a blank alert.
  renderCard({
    card: order({
      state: "failed",
      errorCode: "CHZ_SOMETHING_NEWER",
      errorMessage: null,
      fetchedCount: 0,
      issuedCount: 0,
      availableForIssue: 0,
      bufferExpiresAt: null,
      issues: [],
    }),
  });

  expect(await screen.findByText("CHZ_SOMETHING_NEWER")).toBeDefined();
});

it("hides every issue action from a read-only grant", async () => {
  renderCard({ access: ACCESS_READ_ONLY });

  expect(await screen.findByRole("heading", { name: "Вода газированная 1,0 л" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Выгрузить" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Печать" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Скачать ещё раз" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Печать ещё раз" })).toBeNull();
});

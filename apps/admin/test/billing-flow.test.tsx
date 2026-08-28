import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { BillingLayout } from "../src/pages/billing/BillingLayout.js";
import { CreateRequestPage } from "../src/pages/billing/CreateRequestPage.js";
import { DocumentsPage } from "../src/pages/billing/DocumentsPage.js";
import { InvoiceDetailPage } from "../src/pages/billing/InvoicesPage.js";
import { OfferDetailPage } from "../src/pages/billing/OfferDetailPage.js";
import { RequestDetailPage } from "../src/pages/billing/RequestDetailPage.js";
import type {
  TenantBillingRequestDetail,
  TenantInvoiceDetail,
  TenantOffer,
} from "../src/pages/billing/api.js";

const ids = {
  request: "10000000-0000-4000-8000-000000000001",
  attachment: "10000000-0000-4000-8000-000000000002",
  offer1: "20000000-0000-4000-8000-000000000001",
  offer2: "20000000-0000-4000-8000-000000000002",
  offerDocument: "20000000-0000-4000-8000-000000000003",
  invoice: "30000000-0000-4000-8000-000000000001",
  invoiceDocument: "30000000-0000-4000-8000-000000000002",
  payment1: "40000000-0000-4000-8000-000000000001",
  payment2: "40000000-0000-4000-8000-000000000002",
  act: "50000000-0000-4000-8000-000000000001",
  actDocument: "50000000-0000-4000-8000-000000000002",
} as const;

const event = (
  sequence: number,
  kind: TenantBillingRequestDetail["events"][number]["kind"],
  actorKind: TenantBillingRequestDetail["events"][number]["actorKind"],
  overrides: Partial<TenantBillingRequestDetail["events"][number]> = {},
): TenantBillingRequestDetail["events"][number] => ({
  id: `60000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
  kind,
  fromStatus: null,
  toStatus: null,
  actorKind,
  message: null,
  metadata: null,
  createdAt: `2026-08-28T${String(8 + Math.floor(sequence / 6)).padStart(2, "0")}:${String(
    (sequence % 6) * 10,
  ).padStart(2, "0")}:00.000Z`,
  ...overrides,
});

function initialRequest(): TenantBillingRequestDetail {
  return {
    id: ids.request,
    number: "BR-000042",
    type: "capacity_change",
    status: "clarification_required",
    description: "Добавить две линии",
    desiredAt: "2026-09-10T00:00:00.000Z",
    context: { type: "limit", id: "lines" },
    responsibleSide: "tenant",
    createdAt: "2026-08-28T08:00:00.000Z",
    updatedAt: "2026-08-28T08:30:00.000Z",
    attachments: [],
    links: [],
    events: [
      event(0, "created", "tenant_user", { metadata: { type: "capacity_change" } }),
      event(1, "status_changed", "platform_user", {
        fromStatus: "new",
        toStatus: "under_review",
      }),
      event(2, "status_changed", "platform_user", {
        fromStatus: "under_review",
        toStatus: "clarification_required",
      }),
      event(3, "platform_comment", "platform_user", {
        message: "Уточните, нужны две новые линии или перенос существующих?",
      }),
    ],
  };
}

function finalRequest(): TenantBillingRequestDetail {
  const request = initialRequest();
  return {
    ...request,
    status: "completed",
    responsibleSide: "none",
    updatedAt: "2026-08-28T12:10:00.000Z",
    attachments: [
      {
        id: ids.attachment,
        fileName: "capacity-note.txt",
        contentType: "text/plain",
        byteSize: 32,
        sha256: "not-rendered-in-the-page",
        createdAt: "2026-08-28T09:10:00.000Z",
      },
    ],
    links: [
      {
        id: "70000000-0000-4000-8000-000000000001",
        offerId: ids.offer1,
        invoiceId: null,
        paymentId: null,
        actId: null,
        orderedServiceId: null,
        subscriptionEventId: null,
        createdAt: "2026-08-28T10:00:00.000Z",
      },
      {
        id: "70000000-0000-4000-8000-000000000002",
        offerId: null,
        invoiceId: ids.invoice,
        paymentId: null,
        actId: null,
        orderedServiceId: null,
        subscriptionEventId: null,
        createdAt: "2026-08-28T11:00:00.000Z",
      },
      {
        id: "70000000-0000-4000-8000-000000000003",
        offerId: null,
        invoiceId: null,
        paymentId: ids.payment1,
        actId: null,
        orderedServiceId: null,
        subscriptionEventId: null,
        createdAt: "2026-08-28T11:20:00.000Z",
      },
      {
        id: "70000000-0000-4000-8000-000000000004",
        offerId: null,
        invoiceId: null,
        paymentId: ids.payment2,
        actId: null,
        orderedServiceId: null,
        subscriptionEventId: null,
        createdAt: "2026-08-28T11:30:00.000Z",
      },
      {
        id: "70000000-0000-4000-8000-000000000005",
        offerId: null,
        invoiceId: null,
        paymentId: null,
        actId: ids.act,
        orderedServiceId: null,
        subscriptionEventId: null,
        createdAt: "2026-08-28T12:00:00.000Z",
      },
    ],
    events: [
      ...request.events,
      event(4, "tenant_reply", "tenant_user", { message: "Нужны две новые линии." }),
      event(5, "status_changed", "platform_user", {
        fromStatus: "clarification_required",
        toStatus: "under_review",
      }),
      event(6, "offer_linked", "platform_user", { metadata: { offerId: ids.offer1 } }),
      event(7, "status_changed", "platform_user", {
        fromStatus: "under_review",
        toStatus: "offer_prepared",
      }),
      event(8, "offer_changes_requested", "tenant_user", {
        message: "Разделите подключение на два этапа.",
        metadata: { offerId: ids.offer1 },
      }),
      event(9, "offer_accepted", "tenant_user", { metadata: { offerId: ids.offer2 } }),
      event(10, "invoice_linked", "platform_user", { metadata: { invoiceId: ids.invoice } }),
      event(11, "status_changed", "platform_user", {
        fromStatus: "offer_prepared",
        toStatus: "awaiting_payment",
      }),
      event(12, "payment_confirmed", "platform_user", { metadata: { paymentId: ids.payment1 } }),
      event(13, "payment_confirmed", "platform_user", { metadata: { paymentId: ids.payment2 } }),
      event(14, "status_changed", "platform_user", {
        fromStatus: "awaiting_payment",
        toStatus: "in_progress",
      }),
      event(15, "act_linked", "platform_user", { metadata: { actId: ids.act } }),
      event(16, "status_changed", "platform_user", {
        fromStatus: "in_progress",
        toStatus: "completed",
      }),
    ],
  };
}

const offer = (revision: 1 | 2): TenantOffer => ({
  id: revision === 1 ? ids.offer1 : ids.offer2,
  number: `КП-0042/${revision}`,
  status: "published",
  total: "120000.00",
  // Keep the fixture actionable even when a broader suite leaves a mocked clock behind.
  expiresAt: "2099-09-15T00:00:00.000Z",
  publishedAt: `2026-08-28T${revision === 1 ? "10:00" : "10:40"}:00.000Z`,
  paidAt: null,
  termsMarkdown: revision === 1 ? "Подключение одним этапом" : "Подключение в два этапа",
  isCurrent: true,
  actionable: true,
  latestDecision: null,
  request: { id: ids.request, number: "BR-000042", status: "offer_prepared" },
  lines: [
    {
      id: `21000000-0000-4000-8000-00000000000${revision}`,
      position: 1,
      kind: "service",
      nameRu: "Подключение двух линий",
      quantity: 2,
      unit: "линия",
      agreedUnitPrice: "60000.00",
      lineTotal: "120000.00",
    },
  ],
  documents: [
    {
      id: ids.offerDocument,
      revision,
      format: "pdf",
      status: "ready",
      contentType: "application/pdf",
      byteSize: 1024,
      createdAt: "2026-08-28T10:45:00.000Z",
    },
  ],
});

const invoice: TenantInvoiceDetail = {
  id: ids.invoice,
  number: "INV-000042",
  issueDate: "2026-08-28T11:00:00.000Z",
  dueDate: "2026-09-04T00:00:00.000Z",
  status: "paid",
  total: "120000.00",
  currency: "RUB",
  subtotal: "100000.00",
  vatTotal: "20000.00",
  paymentSummary: { confirmedAmount: "120000.00", remainingAmount: "0.00", status: "paid" },
  lines: [
    {
      position: 1,
      nameRu: "Подключение двух линий",
      unit: "линия",
      quantity: 2,
      agreedUnitPrice: "60000.00",
      lineTotal: "120000.00",
    },
  ],
  documents: [
    {
      id: ids.invoiceDocument,
      revision: 1,
      format: "pdf",
      status: "ready",
      contentType: "application/pdf",
      byteSize: 2048,
      createdAt: "2026-08-28T11:00:00.000Z",
    },
  ],
  payments: [
    { id: ids.payment1, amount: "40000.00", currency: "RUB", paidAt: "2026-08-28T11:20:00.000Z" },
    { id: ids.payment2, amount: "80000.00", currency: "RUB", paidAt: "2026-08-28T11:30:00.000Z" },
  ],
  request: { id: ids.request, number: "BR-000042", status: "completed" },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderBilling(entry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider defaultTheme="light">
        <AccessProvider
          value={{
            roles: ["owner"],
            capabilities: [CABINET_CAPABILITY.BILLING_READ, CABINET_CAPABILITY.BILLING_REQUEST],
          }}
        >
          <MemoryRouter initialEntries={[entry]}>
            <Routes>
              <Route path="/billing" element={<BillingLayout />}>
                <Route path="requests/new" element={<CreateRequestPage />} />
                <Route path="requests/:id" element={<RequestDetailPage />} />
                <Route path="offers/:id" element={<OfferDetailPage />} />
                <Route path="invoices/:id" element={<InvoiceDetailPage />} />
                <Route path="documents" element={<DocumentsPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AccessProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("runs the owner journey with strict request handling, exact retries, unique history, and signed downloads", async () => {
  let request = initialRequest();
  let currentOffer = offer(1);
  const replyBodies: string[] = [];
  let replyAttempts = 0;
  const opened = vi.fn();
  vi.stubGlobal("open", opened);
  vi.stubGlobal("crypto", {
    randomUUID: vi
      .fn()
      .mockReturnValueOnce("90000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("90000000-0000-4000-8000-000000000002")
      .mockReturnValueOnce("90000000-0000-4000-8000-000000000003")
      .mockReturnValueOnce("90000000-0000-4000-8000-000000000004"),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input).replace(/^\/api/, "");
      const method = init.method ?? "GET";
      if (method === "POST" && url === "/billing/requests") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          type: "capacity_change",
          description: "Добавить две линии",
          context: { type: "limit", id: "lines" },
        });
        return json(request);
      }
      if (method === "GET" && url === `/billing/requests/${ids.request}`) return json(request);
      if (method === "POST" && url === `/billing/requests/${ids.request}/replies`) {
        replyBodies.push(String(init.body));
        replyAttempts += 1;
        if (replyAttempts === 1) {
          return json({ message: "simulated connection loss after submit" }, 503);
        }
        request = {
          ...request,
          status: "offer_prepared",
          responsibleSide: "tenant",
          links: finalRequest().links.slice(0, 1),
          events: finalRequest().events.slice(0, 8),
        };
        return json(request.events[4]);
      }
      if (method === "GET" && url === `/billing/offers/${ids.offer1}`) return json(currentOffer);
      if (method === "POST" && url === `/billing/offers/${ids.offer1}/change-request`) {
        currentOffer = {
          ...currentOffer,
          actionable: false,
          latestDecision: {
            decision: "changes_requested",
            message: "Разделите подключение на два этапа.",
            createdAt: "2026-08-28T10:20:00.000Z",
          },
        };
        return json({
          id: "22000000-0000-4000-8000-000000000001",
          offerId: ids.offer1,
          decision: "changes_requested",
          message: "Разделите подключение на два этапа.",
          createdAt: "2026-08-28T10:20:00.000Z",
        });
      }
      if (method === "GET" && url === `/billing/offers/${ids.offer2}`) return json(offer(2));
      if (method === "POST" && url === `/billing/offers/${ids.offer2}/accept`) {
        return json({
          id: "22000000-0000-4000-8000-000000000002",
          offerId: ids.offer2,
          decision: "accepted",
          message: null,
          createdAt: "2026-08-28T10:50:00.000Z",
        });
      }
      if (method === "GET" && url === `/billing/invoices/${ids.invoice}`) return json(invoice);
      if (method === "GET" && url === "/billing/documents") {
        return json({
          items: [
            {
              id: ids.actDocument,
              type: "act",
              entityId: ids.act,
              revision: 1,
              format: "pdf",
              status: "ready",
              contentType: "application/pdf",
              byteSize: 4096,
              createdAt: "2026-08-28T12:00:00.000Z",
            },
          ],
        });
      }
      const downloads = new Map([
        [
          `/billing/requests/${ids.request}/attachments/${ids.attachment}/download`,
          "https://signed.example/request.txt",
        ],
        [
          `/billing/invoices/${ids.invoice}/documents/${ids.invoiceDocument}/download`,
          "https://signed.example/invoice.pdf",
        ],
        [
          `/billing/acts/${ids.act}/documents/${ids.actDocument}/download`,
          "https://signed.example/act.pdf",
        ],
      ]);
      if (method === "GET" && downloads.has(url)) return json({ url: downloads.get(url) });
      throw new Error(`Unhandled billing-flow request: ${method} ${url}`);
    }),
  );

  const create = renderBilling(
    "/billing/requests/new?type=capacity_change&contextType=limit&contextId=lines",
  );
  fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "Добавить две линии" } });
  fireEvent.click(screen.getByRole("button", { name: "Создать заявку" }));
  expect(await screen.findByRole("heading", { name: "Заявка BR-000042" })).toBeDefined();
  expect(
    screen.getByText("Уточните, нужны две новые линии или перенос существующих?"),
  ).toBeDefined();

  fireEvent.change(screen.getByLabelText("Ответ на уточнение"), {
    target: { value: "  Нужны две новые линии.  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Отправить ответ" }));
  expect(await screen.findByRole("button", { name: "Повторить отправку" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
  await waitFor(() => expect(replyBodies).toHaveLength(2));
  expect(replyBodies[1]).toBe(replyBodies[0]);
  expect(JSON.parse(replyBodies[0] ?? "{}")).toMatchObject({ message: "Нужны две новые линии." });
  expect(await screen.findByRole("link", { name: "Коммерческое предложение" })).toBeDefined();
  create.unmount();

  const firstOffer = renderBilling(`/billing/offers/${ids.offer1}`);
  expect(await screen.findByRole("heading", { name: "Предложение КП-0042/1" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Запросить изменения" }));
  fireEvent.change(screen.getByLabelText("Что нужно изменить"), {
    target: { value: "Разделите подключение на два этапа." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Отправить запрос" }));
  expect(await screen.findByRole("heading", { name: "Документы" })).toBeDefined();
  firstOffer.unmount();

  const revisedOffer = renderBilling(`/billing/offers/${ids.offer2}`);
  expect(await screen.findByText("Подключение в два этапа")).toBeDefined();
  const accept = screen.getByRole("button", { name: "Принять" });
  accept.focus();
  fireEvent.click(accept);
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByRole("button", { name: "Подтвердить принятие" })).toBeDefined();
  fireEvent.click(within(dialog).getByRole("button", { name: "Подтвердить принятие" }));
  expect(await screen.findByRole("heading", { name: "Документы" })).toBeDefined();
  revisedOffer.unmount();

  request = finalRequest();
  const completed = renderBilling(`/billing/requests/${ids.request}`);
  expect(await screen.findByText("Выполнено")).toBeDefined();
  const linkedCard = screen.getByRole("heading", { name: "Связанные объекты" }).closest(".mk-card");
  expect(linkedCard).not.toBeNull();
  const linked = within(linkedCard as HTMLElement).getByRole("list");
  expect(within(linked).getAllByRole("link", { name: "Коммерческое предложение" })).toHaveLength(1);
  expect(within(linked).getAllByRole("link", { name: "Счёт" })).toHaveLength(1);
  expect(within(linked).getAllByText("Подтверждённая оплата")).toHaveLength(2);
  expect(within(linked).getAllByText("Акт")).toHaveLength(1);
  const history = within(screen.getByRole("list", { name: "История заявки" })).getAllByRole(
    "listitem",
  );
  expect(history).toHaveLength(request.events.length);
  expect(history.map((item) => item.textContent)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Запрошены изменения предложения"),
      expect.stringContaining("Предложение принято"),
      expect.stringContaining("Счёт связан"),
      expect.stringContaining("Оплата подтверждена"),
      expect.stringContaining("Акт связан"),
    ]),
  );
  expect(
    request.events.every(
      (item, index, values) => index === 0 || item.createdAt >= values[index - 1]!.createdAt,
    ),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Скачать capacity-note.txt" }));
  await waitFor(() =>
    expect(opened).toHaveBeenCalledWith(
      "https://signed.example/request.txt",
      "_blank",
      "noopener,noreferrer",
    ),
  );
  completed.unmount();

  const paidInvoice = renderBilling(`/billing/invoices/${ids.invoice}`);
  expect(await screen.findByText("40 000,00 ₽")).toBeDefined();
  expect(screen.getByText("80 000,00 ₽")).toBeDefined();
  expect(screen.getByText("0,00 ₽")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Скачать" }));
  await waitFor(() =>
    expect(opened).toHaveBeenCalledWith(
      "https://signed.example/invoice.pdf",
      "_blank",
      "noopener,noreferrer",
    ),
  );
  paidInvoice.unmount();

  renderBilling("/billing/documents");
  expect(await screen.findByText("Акт")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Скачать" }));
  await waitFor(() =>
    expect(opened).toHaveBeenCalledWith(
      "https://signed.example/act.pdf",
      "_blank",
      "noopener,noreferrer",
    ),
  );
});

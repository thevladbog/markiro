import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNTANT_ME, TENANT_ID, jsonResponse, renderSaasApp } from "./render.js";

const INVOICE_ID = "91111111-1111-4111-8111-111111111111";
const LINE_ID = "92111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-08-21T10:00:00.000Z";
const HTML_DOCUMENT_ID = "96111111-1111-4111-8111-111111111111";
const PDF_DOCUMENT_ID = "97111111-1111-4111-8111-111111111111";
const TENANT_NAME = "ООО Фабрика";

const readyDocuments = [
  {
    id: HTML_DOCUMENT_ID,
    revision: 1,
    format: "html",
    status: "ready",
    contentType: "text/html; charset=utf-8",
    byteSize: 4096,
    sha256: "a".repeat(64),
    errorCode: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
  {
    id: PDF_DOCUMENT_ID,
    revision: 1,
    format: "pdf",
    status: "ready",
    contentType: "application/pdf",
    byteSize: 8192,
    sha256: "b".repeat(64),
    errorCode: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
] as const;

const failedHtmlDocument = {
  id: HTML_DOCUMENT_ID,
  revision: 1,
  format: "html",
  status: "failed",
  contentType: null,
  byteSize: null,
  sha256: null,
  errorCode: "object_storage_unavailable",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
} as const;

const invoiceBase = {
  id: INVOICE_ID,
  number: "INV-000021",
  tenantId: TENANT_ID,
  tenantName: TENANT_NAME,
  issueDate: "2026-08-21T10:00:00.000Z",
  dueDate: "2026-08-28T10:00:00.000Z",
  currency: "RUB",
  sellerSnapshot: {
    kind: "sole_proprietor",
    displayName: "Markiro",
    inn: "234190622844",
  },
  buyerSnapshot: { displayName: "Factory" },
  subtotal: "12500.00",
  vatTotal: "2500.00",
  total: "15000.00",
  applicationMode: "automatic",
  createdByPlatformUserId: "platform-accountant",
  issuedByPlatformUserId: "platform-accountant",
  issuedAt: "2026-08-21T10:00:00.000Z",
  paidAt: null,
  cancelledAt: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
} as const;

const issuedDetail = {
  ...invoiceBase,
  status: "issued",
  lines: [
    {
      id: LINE_ID,
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      position: 1,
      kind: "plan",
      catalogVersionId: "11111111-1111-4111-8111-111111111111",
      catalogKind: "plan",
      nameRu: "Производство",
      nameEn: "Production",
      descriptionRu: null,
      descriptionEn: null,
      quantity: 1,
      unit: "месяц",
      catalogUnitPrice: "15000.00",
      agreedUnitPrice: "15000.00",
      vatRate: "20.00",
      vatIncluded: true,
      lineSubtotal: "12500.00",
      lineVat: "2500.00",
      lineTotal: "15000.00",
      activationPolicy: "manual",
      createdAt: CREATED_AT,
    },
  ],
  documents: readyDocuments,
  payments: [],
  paymentSummary: {
    confirmedAmount: "0.00",
    remainingAmount: "15000.00",
    status: "issued",
  },
  application: { status: "not_paid", latestByLine: [], attempts: [] },
};

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

function installApi({
  initialDocuments = readyDocuments,
  failRender = false,
  deferDownloads = false,
  readyAfterDetailRequests,
}: {
  initialDocuments?: readonly Record<string, unknown>[];
  failRender?: boolean;
  deferDownloads?: boolean;
  readyAfterDetailRequests?: number;
} = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let paymentAttempts = 0;
  let paid = false;
  let cancelled = false;
  let documents: readonly Record<string, unknown>[] = initialDocuments;
  let detailRequests = 0;
  const downloadResolvers: Array<() => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input);
      const method = init.method ?? "GET";
      if (path.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
      if (path.endsWith("/api/platform/invoices") && method === "GET") {
        return jsonResponse(200, {
          items: [
            {
              ...invoiceBase,
              status: "issued",
            },
          ],
        });
      }
      if (path.endsWith(`/api/platform/invoices/${INVOICE_ID}`) && method === "GET") {
        detailRequests += 1;
        if (readyAfterDetailRequests !== undefined && detailRequests > readyAfterDetailRequests) {
          documents = readyDocuments;
        }
        return jsonResponse(
          200,
          cancelled
            ? {
                ...issuedDetail,
                documents,
                status: "cancelled",
                cancelledAt: "2026-08-21T12:00:00.000Z",
                payments: [],
                paymentSummary: null,
                application: { status: "not_paid", latestByLine: [], attempts: [] },
              }
            : paid
              ? {
                  ...issuedDetail,
                  documents,
                  status: "paid",
                  paidAt: "2026-08-21T12:00:00.000Z",
                  payments: [
                    {
                      id: "93111111-1111-4111-8111-111111111111",
                      tenantId: TENANT_ID,
                      invoiceId: INVOICE_ID,
                      source: "manual",
                      paidAt: "2026-08-21T12:00:00.000Z",
                      amount: "15000.00",
                      currency: "RUB",
                      bankReference: "BANK-42",
                      importRowId: null,
                      platformUserId: "platform-accountant",
                      idempotencyKey: "invoice-payment-42",
                      createdAt: "2026-08-21T12:00:00.000Z",
                    },
                  ],
                  paymentSummary: {
                    confirmedAmount: "15000.00",
                    remainingAmount: "0.00",
                    status: "paid",
                  },
                  application: {
                    status: "pending",
                    latestByLine: [
                      {
                        id: "94111111-1111-4111-8111-111111111111",
                        tenantId: TENANT_ID,
                        invoiceId: INVOICE_ID,
                        invoiceLineId: LINE_ID,
                        attempt: 1,
                        status: "pending",
                        kind: "plan",
                        source: "payment",
                        beforeSnapshot: null,
                        afterSnapshot: null,
                        errorCode: null,
                        actorPlatformUserId: "platform-accountant",
                        createdAt: "2026-08-21T12:00:00.000Z",
                      },
                    ],
                    attempts: [],
                  },
                }
              : { ...issuedDetail, documents },
        );
      }
      if (path.endsWith(`/api/platform/invoices/${INVOICE_ID}/cancel`) && method === "POST") {
        calls.push({ method, path, body: {} });
        cancelled = true;
        const { tenantName, ...cancelledInvoice } = invoiceBase;
        void tenantName;
        return jsonResponse(201, {
          ...cancelledInvoice,
          status: "cancelled",
          cancelledAt: "2026-08-21T12:00:00.000Z",
        });
      }
      if (path.endsWith(`/api/platform/invoices/${INVOICE_ID}/documents`) && method === "POST") {
        calls.push({ method, path, body: JSON.parse(String(init.body)) });
        if (failRender) return jsonResponse(503, { code: "object_storage_unavailable" });
        documents = readyDocuments;
        return jsonResponse(201, {
          revision: 1,
          documents: readyDocuments.map(
            ({ createdAt: _createdAt, updatedAt: _updatedAt, ...document }) => document,
          ),
        });
      }
      if (
        path.includes(`/api/platform/invoices/${INVOICE_ID}/documents/`) &&
        path.endsWith("/download") &&
        method === "GET"
      ) {
        calls.push({ method, path, body: null });
        if (deferDownloads) {
          await new Promise<void>((resolve) => downloadResolvers.push(resolve));
        }
        const format = path.includes(HTML_DOCUMENT_ID) ? "html" : "pdf";
        return jsonResponse(200, {
          url: `https://objects.example.invalid/invoices/${INVOICE_ID}.${format}?signature=redacted`,
        });
      }
      if (path.endsWith(`/api/platform/payments/invoices/${INVOICE_ID}`) && method === "POST") {
        const body = JSON.parse(String(init.body));
        calls.push({ method, path, body });
        paymentAttempts += 1;
        if (paymentAttempts === 1) return jsonResponse(503, { code: "temporary_failure" });
        paid = true;
        return jsonResponse(201, {
          id: "93111111-1111-4111-8111-111111111111",
          tenantId: TENANT_ID,
          invoiceId: INVOICE_ID,
          source: "manual",
          paidAt: body.paidAt,
          amount: body.amount,
          currency: "RUB",
          bankReference: body.bankReference,
          importRowId: null,
          platformUserId: "platform-accountant",
          idempotencyKey: body.idempotencyKey,
          createdAt: "2026-08-21T12:00:00.000Z",
          invoiceStatus: "paid",
          confirmedAmount: "15000.00",
          remainingAmount: "0.00",
        });
      }
      if (path.endsWith(`/api/platform/invoices/${INVOICE_ID}/apply`) && method === "POST") {
        const body = JSON.parse(String(init.body));
        calls.push({ method, path, body });
        return jsonResponse(200, {
          invoiceId: INVOICE_ID,
          status: "applied",
          results: [
            {
              lineId: LINE_ID,
              attempt: 1,
              status: "applied",
              kind: "plan",
              result: { id: "95111111-1111-4111-8111-111111111111" },
              errorCode: null,
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  );
  return {
    calls: () => structuredClone(calls),
    resolveDownload: (index: number) => downloadResolvers[index]?.(),
  };
}

describe("invoice commercial lifecycle", () => {
  it("rejects a malformed invoice success body at the browser boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
        if (path.endsWith("/api/platform/invoices")) {
          return jsonResponse(200, {
            items: [
              {
                id: INVOICE_ID,
                number: issuedDetail.number,
                tenantId: TENANT_ID,
                status: "issued",
                total: "15000.00",
                paidAt: null,
              },
            ],
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderSaasApp({ initialEntry: "/billing" });

    expect(await screen.findByText("Не удалось загрузить счета")).toBeDefined();
    expect(screen.queryByRole("link", { name: issuedDetail.number })).toBeNull();
  });

  it("opens a dedicated invoice route from the billing register", async () => {
    installApi();
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: "/billing" });

    const link = await screen.findByRole("link", { name: "INV-000021" });
    expect(link.getAttribute("href")).toBe(`/invoices/${INVOICE_ID}`);
    await user.click(link);
    expect(await screen.findByRole("heading", { name: "Счёт INV-000021" })).toBeDefined();
  });

  it("shows tenant names and translated, visually distinct invoice statuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
        if (path.endsWith("/api/platform/invoices")) {
          return jsonResponse(200, {
            items: [
              { ...invoiceBase, status: "issued" },
              {
                ...invoiceBase,
                id: "90111111-1111-4111-8111-111111111111",
                number: "INV-000020",
                status: "draft",
                issueDate: null,
                sellerSnapshot: null,
                buyerSnapshot: null,
                issuedByPlatformUserId: null,
                issuedAt: null,
              },
            ],
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderSaasApp({ initialEntry: "/billing" });

    const tenantLinks = await screen.findAllByRole("link", { name: TENANT_NAME });
    expect(tenantLinks[0]?.getAttribute("href")).toBe(`/tenants/${TENANT_ID}`);
    expect(screen.getByText("Выставлен").closest(".mk-chip")?.className).toContain("mk-chip--info");
    expect(screen.getByText("Черновик").closest(".mk-chip")?.className).toContain(
      "mk-chip--neutral",
    );
    expect(document.body.textContent).not.toContain(TENANT_ID);
  });

  it("withdraws an issued invoice only after destructive confirmation", async () => {
    const api = installApi();
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/invoices/${INVOICE_ID}` });

    expect(await screen.findByRole("link", { name: TENANT_NAME })).toBeDefined();
    expect(document.body.textContent).not.toContain(INVOICE_ID);
    await user.click(screen.getByRole("button", { name: "Отозвать счёт" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Счёт останется в финансовой истории");
    await user.click(screen.getByRole("button", { name: "Подтвердить отзыв" }));

    await waitFor(() =>
      expect(api.calls()).toContainEqual({
        method: "POST",
        path: `/api/platform/invoices/${INVOICE_ID}/cancel`,
        body: {},
      }),
    );
    expect(await screen.findByText("Отозван")).toBeDefined();
  });

  it("deletes a draft after confirmation and returns to the invoice register", async () => {
    let deleted = false;
    const calls: Array<{ method: string; path: string }> = [];
    const draftDetail = {
      ...issuedDetail,
      status: "draft",
      issueDate: null,
      sellerSnapshot: null,
      buyerSnapshot: null,
      issuedByPlatformUserId: null,
      issuedAt: null,
      documents: [],
      payments: [],
      paymentSummary: null,
      application: { status: "not_paid", latestByLine: [], attempts: [] },
    } as const;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const method = init.method ?? "GET";
        if (path.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
        if (path.endsWith(`/api/platform/invoices/${INVOICE_ID}`) && method === "GET") {
          return jsonResponse(200, draftDetail);
        }
        if (path.endsWith(`/api/platform/invoices/${INVOICE_ID}`) && method === "DELETE") {
          calls.push({ method, path });
          deleted = true;
          return jsonResponse(200, {
            id: INVOICE_ID,
            tenantId: TENANT_ID,
            number: invoiceBase.number,
            deleted: true,
          });
        }
        if (path.endsWith("/api/platform/invoices") && method === "GET") {
          return jsonResponse(200, {
            items: deleted ? [] : [{ ...invoiceBase, status: "issued" }],
          });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/invoices/${INVOICE_ID}` });

    await user.click(await screen.findByRole("button", { name: "Удалить черновик" }));
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "Удалённый черновик нельзя восстановить",
    );
    await user.click(screen.getByRole("button", { name: "Удалить" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "DELETE",
        path: `/api/platform/invoices/${INVOICE_ID}`,
      }),
    );
    expect(await screen.findByRole("heading", { name: "Счета" })).toBeDefined();
  });

  it("records only the remaining balance for a partially-paid invoice", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const method = init.method ?? "GET";
        if (path.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
        if (path.endsWith(`/api/platform/invoices/${INVOICE_ID}`) && method === "GET") {
          return jsonResponse(200, {
            ...issuedDetail,
            status: "partially_paid",
            payments: [
              {
                id: "93111111-1111-4111-8111-111111111111",
                tenantId: TENANT_ID,
                invoiceId: INVOICE_ID,
                source: "bank_import",
                paidAt: "2026-08-21T12:00:00.000Z",
                amount: "5000.00",
                currency: "RUB",
                bankReference: "BANK-PARTIAL",
                importRowId: "94111111-1111-4111-8111-111111111111",
                platformUserId: "platform-accountant",
                idempotencyKey: "bank-import:partial",
                createdAt: "2026-08-21T12:00:00.000Z",
              },
            ],
            paymentSummary: {
              confirmedAmount: "5000.00",
              remainingAmount: "10000.00",
              status: "partially_paid",
            },
          });
        }
        if (path.endsWith(`/api/platform/payments/invoices/${INVOICE_ID}`) && method === "POST") {
          const body = JSON.parse(String(init.body));
          calls.push(body);
          return jsonResponse(201, {
            id: "95111111-1111-4111-8111-111111111111",
            tenantId: TENANT_ID,
            invoiceId: INVOICE_ID,
            source: "manual",
            paidAt: body.paidAt,
            amount: body.amount,
            currency: "RUB",
            bankReference: body.bankReference,
            importRowId: null,
            platformUserId: "platform-accountant",
            idempotencyKey: body.idempotencyKey,
            createdAt: "2026-08-21T12:00:00.000Z",
            invoiceStatus: "paid",
            confirmedAmount: "15000.00",
            remainingAmount: "0.00",
          });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/invoices/${INVOICE_ID}` });

    await user.type(await screen.findByLabelText("Банковский референс"), "BANK-FINAL");
    await user.click(screen.getByRole("button", { name: "Подтвердить оплату" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ amount: "10000.00", bankReference: "BANK-FINAL" });
  });

  it("keeps payment retries idempotent and requires an explicit manual activation decision", async () => {
    const api = installApi();
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/billing/${INVOICE_ID}` });

    expect(await screen.findByText("Оплата ещё не меняет подписку")).toBeDefined();
    await user.type(screen.getByLabelText("Банковский референс"), "BANK-42");
    await user.click(screen.getByRole("button", { name: "Подтвердить оплату" }));
    expect(await screen.findByRole("alert")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Повторить оплату" }));

    expect(await screen.findByRole("heading", { name: "Ожидает решения оператора" })).toBeDefined();
    const paymentBodies = api
      .calls()
      .slice(0, 2)
      .map((call) => call.body) as Array<{
      idempotencyKey: string;
    }>;
    expect(paymentBodies[0]).toEqual(paymentBodies[1]);

    await user.selectOptions(screen.getByLabelText("Как применить Производство"), "immediate");
    await user.type(screen.getByLabelText("Причина применения"), "Сверено с оплатой");
    await user.click(screen.getByRole("button", { name: "Применить выбранные строки" }));

    expect(api.calls().at(-1)?.body).toEqual({
      reason: "Сверено с оплатой",
      lines: [{ lineId: LINE_ID, activationPolicy: "immediate" }],
    });
  });

  it("shows ready HTML and PDF forms and opens their signed download URLs", async () => {
    installApi();
    const htmlTarget = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    const pdfTarget = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.fn().mockReturnValueOnce(htmlTarget).mockReturnValueOnce(pdfTarget);
    vi.stubGlobal("open", open);
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/invoices/${INVOICE_ID}` });

    expect(await screen.findByRole("heading", { name: "Печатные формы" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Открыть HTML" }));
    await user.click(screen.getByRole("button", { name: "Скачать PDF" }));

    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, "about:blank", "_blank");
    await waitFor(() =>
      expect(htmlTarget.location.replace).toHaveBeenCalledWith(
        `https://objects.example.invalid/invoices/${INVOICE_ID}.html?signature=redacted`,
      ),
    );
    expect(pdfTarget.location.replace).toHaveBeenCalledWith(
      `https://objects.example.invalid/invoices/${INVOICE_ID}.pdf?signature=redacted`,
    );
    expect(htmlTarget.opener).toBeNull();
    expect(pdfTarget.opener).toBeNull();
  });

  it("keeps an earlier ready revision available when the latest revision failed", async () => {
    installApi({
      initialDocuments: [
        ...readyDocuments,
        { ...failedHtmlDocument, id: "98111111-1111-4111-8111-111111111111", revision: 2 },
      ],
    });
    renderSaasApp({ initialEntry: `/invoices/${INVOICE_ID}` });

    expect(await screen.findByRole("heading", { name: "Версия 2" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Версия 1" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Открыть HTML" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Скачать PDF" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Повторить формирование" })).toBeDefined();
  });

  it("reports a blocked print-form window", async () => {
    installApi();
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/invoices/${INVOICE_ID}` });

    await user.click(await screen.findByRole("button", { name: "Открыть HTML" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Браузер заблокировал открытие печатной формы",
    );
  });

  it("keeps both document targets when HTML and PDF downloads resolve out of order", async () => {
    const api = installApi({ deferDownloads: true });
    const htmlTarget = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    const pdfTarget = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("open", vi.fn().mockReturnValueOnce(htmlTarget).mockReturnValueOnce(pdfTarget));
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/invoices/${INVOICE_ID}` });

    await user.click(await screen.findByRole("button", { name: "Открыть HTML" }));
    await user.click(screen.getByRole("button", { name: "Скачать PDF" }));
    api.resolveDownload(1);
    await waitFor(() => expect(pdfTarget.location.replace).toHaveBeenCalledOnce());
    api.resolveDownload(0);
    await waitFor(() => expect(htmlTarget.location.replace).toHaveBeenCalledOnce());
  });

  it("offers recovery when a document revision is stranded as pending", async () => {
    installApi({
      initialDocuments: (["html", "pdf"] as const).map((format, index) => ({
        id:
          index === 0
            ? "99111111-1111-4111-8111-111111111111"
            : "9a111111-1111-4111-8111-111111111111",
        revision: 2,
        format,
        status: "pending",
        contentType: null,
        byteSize: null,
        sha256: null,
        errorCode: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      })),
    });
    renderSaasApp({ initialEntry: `/invoices/${INVOICE_ID}` });

    expect((await screen.findAllByText("Формирование не завершено")).length).toBe(2);
    expect(screen.getByRole("button", { name: "Повторить формирование" })).toBeDefined();
  });

  it("refreshes a pending document revision until it becomes ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-21T10:00:01.000Z"));
    installApi({
      initialDocuments: (["html", "pdf"] as const).map((format, index) => ({
        id:
          index === 0
            ? "9d111111-1111-4111-8111-111111111111"
            : "9e111111-1111-4111-8111-111111111111",
        revision: 4,
        format,
        status: "pending",
        contentType: null,
        byteSize: null,
        sha256: null,
        errorCode: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      })),
      readyAfterDetailRequests: 1,
    });
    renderSaasApp({ initialEntry: `/invoices/${INVOICE_ID}` });

    expect((await screen.findAllByText("Формируется")).length).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(screen.getByRole("button", { name: "Открыть HTML" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Скачать PDF" })).toBeDefined();
  });

  it("marks an in-progress revision as recoverable when it becomes stale on an open page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-21T10:04:59.000Z"));
    installApi({
      initialDocuments: (["html", "pdf"] as const).map((format, index) => ({
        id:
          index === 0
            ? "9b111111-1111-4111-8111-111111111111"
            : "9c111111-1111-4111-8111-111111111111",
        revision: 3,
        format,
        status: "pending",
        contentType: null,
        byteSize: null,
        sha256: null,
        errorCode: null,
        createdAt: "2026-08-21T10:00:00.000Z",
        updatedAt: "2026-08-21T10:00:00.000Z",
      })),
    });
    renderSaasApp({ initialEntry: `/invoices/${INVOICE_ID}` });

    expect((await screen.findAllByText("Формируется")).length).toBe(2);
    expect(screen.queryByRole("button", { name: "Повторить формирование" })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1_100));
    expect(screen.getAllByText("Формирование не завершено")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Повторить формирование" })).toBeDefined();
    vi.useRealTimers();
  });

  it("reports a print-form generation failure instead of swallowing it", async () => {
    const api = installApi({ initialDocuments: [failedHtmlDocument], failRender: true });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/invoices/${INVOICE_ID}` });

    expect(await screen.findByText("HTML: не сформирован")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Повторить формирование" }));
    expect(screen.getByRole("alertdialog")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.calls()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Повторить формирование" }));
    await user.click(screen.getByRole("button", { name: "Сформировать новую версию" }));

    expect(
      (await screen.findAllByRole("alert")).some((alert) =>
        alert.textContent?.includes("Не удалось сформировать печатные формы"),
      ),
    ).toBe(true);
  });

  it("requests a signed invoice revision only after an explicit operator choice", async () => {
    const api = installApi({ initialDocuments: [failedHtmlDocument] });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/invoices/${INVOICE_ID}` });

    await user.click(await screen.findByRole("button", { name: "Повторить формирование" }));
    const signedPrint = screen.getByRole("checkbox", { name: "Добавить подпись и печать" });
    expect(signedPrint.hasAttribute("disabled")).toBe(false);
    await user.click(signedPrint);
    await user.click(screen.getByRole("button", { name: "Сформировать новую версию" }));

    await waitFor(() => expect(api.calls()).toHaveLength(1));
    expect(api.calls()[0]?.body).toEqual({ printVariant: "signed" });
  });
});

import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACCOUNTANT_ME, TENANT_ID, jsonResponse, renderSaasApp } from "./render.js";

const INVOICE_ID = "91111111-1111-4111-8111-111111111111";
const REQUEST_ID = "11111111-1111-4111-8111-111111111121";
const ACT_ID = "51111111-1111-4111-8111-111111111121";
const USER_ID = "61111111-1111-4111-8111-111111111121";
const NOW = "2026-08-21T10:00:00.000Z";

const invoice = {
  id: INVOICE_ID,
  tenantId: TENANT_ID,
  tenantName: "ООО Фабрика",
  number: "MRK-INV-000021",
  sellerBankAccountId: null,
  sourceOfferId: null,
  sourceRequestId: REQUEST_ID,
  status: "issued",
  issueDate: NOW,
  dueDate: "2026-08-28T10:00:00.000Z",
  currency: "RUB",
  sellerSnapshot: {
    kind: "sole_proprietor",
    fullName: "ИП Богатырёв Владислав Сергеевич",
    displayName: "ИП Богатырёв Владислав Сергеевич",
    inn: "234106228141",
  },
  buyerSnapshot: { legalName: "ООО Фабрика" },
  sellerBankAccountSnapshot: null,
  buyerBankAccountSnapshot: null,
  subtotal: "12500.00",
  vatTotal: "2500.00",
  total: "15000.00",
  applicationMode: "automatic",
  createdByPlatformUserId: USER_ID,
  issuedByPlatformUserId: USER_ID,
  issuedAt: NOW,
  paidAt: null,
  cancelledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const invoiceDetail = {
  ...invoice,
  lines: [
    {
      id: "92111111-1111-4111-8111-111111111111",
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      position: 1,
      kind: "service",
      catalogVersionId: "11111111-1111-4111-8111-111111111111",
      catalogKind: "service",
      nameRu: "Настройка интеграции",
      nameEn: "Integration setup",
      descriptionRu: null,
      descriptionEn: null,
      quantity: 1,
      unit: "услуга",
      catalogUnitPrice: "15000.00",
      agreedUnitPrice: "15000.00",
      vatRate: "20.00",
      vatIncluded: true,
      lineSubtotal: "12500.00",
      lineVat: "2500.00",
      lineTotal: "15000.00",
      activationPolicy: null,
      createdAt: NOW,
    },
  ],
  documents: [],
  payments: [],
  paymentSummary: {
    confirmedAmount: "0.00",
    remainingAmount: "15000.00",
    status: "issued",
  },
  application: { status: "not_paid", latestByLine: [], attempts: [] },
} as const;

function act(status: "draft" | "issued") {
  return {
    id: ACT_ID,
    tenantId: TENANT_ID,
    requestId: REQUEST_ID,
    invoiceId: INVOICE_ID,
    orderedServiceId: null,
    number: "MRK-ACT-000021",
    status,
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    createdByPlatformUserId: USER_ID,
    issuedByPlatformUserId: status === "issued" ? USER_ID : null,
    issuedAt: status === "issued" ? NOW : null,
    cancelledByPlatformUserId: null,
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    document:
      status === "issued"
        ? {
            id: "71111111-1111-4111-8111-111111111121",
            revision: 1,
            state: "ready",
            contentType: "application/pdf",
            byteSize: 4096,
            sha256: "a".repeat(64),
            uploadedByPlatformUserId: USER_ID,
            readyAt: NOW,
            createdAt: NOW,
            updatedAt: NOW,
          }
        : null,
  } as const;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("generated billing acts", () => {
  it("shows invoice and tenant names on the act detail instead of identifiers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}`)) {
          return jsonResponse(200, { ...act("issued"), requestId: null });
        }
        if (url.endsWith(`/api/platform/invoices/${INVOICE_ID}`)) {
          return jsonResponse(200, invoiceDetail);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderSaasApp({ initialEntry: `/billing-acts/${ACT_ID}` });

    expect(await screen.findByRole("heading", { name: "MRK-ACT-000021" })).toBeDefined();
    expect((await screen.findByRole("link", { name: "ООО Фабрика" })).getAttribute("href")).toBe(
      `/tenants/${TENANT_ID}`,
    );
    expect(screen.getByRole("link", { name: "MRK-INV-000021" }).getAttribute("href")).toBe(
      `/invoices/${INVOICE_ID}`,
    );
    expect(screen.queryByText(TENANT_ID)).toBeNull();
    expect(screen.queryByText(INVOICE_ID)).toBeNull();
  });

  it("restores the issued act content when its detail is opened directly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}`)) {
          return jsonResponse(200, { ...act("issued"), requestId: null });
        }
        if (url.endsWith(`/api/platform/invoices/${INVOICE_ID}`)) {
          return jsonResponse(200, invoiceDetail);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderSaasApp({ initialEntry: `/billing-acts/${ACT_ID}` });

    expect(await screen.findByRole("heading", { name: "Состав акта" })).toBeDefined();
    expect(screen.getByText("Настройка интеграции")).toBeDefined();
    expect(screen.getByText("1 услуга")).toBeDefined();
    expect(screen.getAllByText("15 000,00 ₽")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Печатная форма" })).toBeDefined();
    expect(screen.getByText("Чистый бланк")).toBeDefined();
    expect(screen.getByRole("button", { name: "Скачать PDF" })).toBeDefined();
  });

  it("downloads the ready act PDF from its detail page", async () => {
    const documentUrl = "https://objects.example.test/acts/MRK-ACT-000021.pdf";
    const target = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "open",
      vi.fn(() => target),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}`)) {
          return jsonResponse(200, { ...act("issued"), requestId: null });
        }
        if (url.endsWith(`/api/platform/invoices/${INVOICE_ID}`)) {
          return jsonResponse(200, invoiceDetail);
        }
        if (
          url.endsWith(
            `/api/platform/billing/acts/${ACT_ID}/documents/71111111-1111-4111-8111-111111111121/download`,
          )
        ) {
          return jsonResponse(200, { url: documentUrl });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    renderSaasApp({ initialEntry: `/billing-acts/${ACT_ID}` });
    await user.click(await screen.findByRole("button", { name: "Скачать PDF" }));

    await waitFor(() =>
      expect(requestedUrls).toContain(
        `/api/platform/billing/acts/${ACT_ID}/documents/71111111-1111-4111-8111-111111111121/download`,
      ),
    );
    await waitFor(() => expect(target.location.replace).toHaveBeenCalledWith(documentUrl));
    expect(target.opener).toBeNull();
  });

  it("shows an acts registry with business labels and links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
        if (url.endsWith("/api/platform/billing/acts")) {
          return jsonResponse(200, { items: [act("issued")] });
        }
        if (url.endsWith("/api/platform/invoices")) {
          return jsonResponse(200, { items: [invoice] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderSaasApp({ initialEntry: "/billing-acts" });

    expect(await screen.findByRole("heading", { name: "Акты" })).toBeDefined();
    expect((await screen.findByRole("link", { name: "MRK-ACT-000021" })).getAttribute("href")).toBe(
      `/billing-acts/${ACT_ID}`,
    );
    expect(screen.getByRole("link", { name: "ООО Фабрика" }).getAttribute("href")).toBe(
      `/tenants/${TENANT_ID}`,
    );
    expect(screen.getByRole("link", { name: "MRK-INV-000021" }).getAttribute("href")).toBe(
      `/invoices/${INVOICE_ID}`,
    );
    expect(screen.queryByText(INVOICE_ID)).toBeNull();
    expect(screen.queryByText(TENANT_ID)).toBeNull();
  });

  it("selects an invoice by number, previews its data, and issues a generated PDF", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push(init ? { url, init } : { url });
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
        if (url.endsWith("/api/platform/invoices") && method === "GET") {
          return jsonResponse(200, { items: [invoice] });
        }
        if (url.endsWith(`/api/platform/invoices/${INVOICE_ID}`) && method === "GET") {
          return jsonResponse(200, invoiceDetail);
        }
        if (url.endsWith("/api/platform/billing/acts") && method === "POST") {
          return jsonResponse(201, act("draft"));
        }
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}/issue`) && method === "POST") {
          return jsonResponse(201, act("issued"));
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    const user = userEvent.setup();

    renderSaasApp({ initialEntry: "/billing-acts/new" });

    await user.click(await screen.findByRole("combobox", { name: "Счёт-основание" }));
    await user.type(screen.getByRole("searchbox", { name: "Поиск по номеру или тенанту" }), "21");
    await user.click(screen.getByRole("option", { name: /MRK-INV-000021/ }));

    expect(await screen.findByText("Настройка интеграции")).toBeDefined();
    expect(screen.getByText("ООО Фабрика")).toBeDefined();
    expect(screen.getAllByText("15 000,00 ₽")).toHaveLength(2);
    expect(screen.getByText("MRK-ACT-000021")).toBeDefined();
    expect(screen.queryByLabelText("PDF акта")).toBeNull();
    expect(screen.queryByLabelText("Тенант")).toBeNull();
    expect(screen.queryByLabelText("Заявка")).toBeNull();

    expect(screen.getByLabelText("Начало периода").textContent).toContain("июля 2026");
    expect(screen.getByLabelText("Конец периода").textContent).toContain("июля 2026");
    const signedPrint = screen.getByRole("checkbox", { name: "Добавить подпись и печать" });
    expect(signedPrint.hasAttribute("disabled")).toBe(false);
    await user.click(signedPrint);
    await user.click(screen.getByRole("button", { name: "Выпустить акт" }));

    expect(await screen.findByText("Акт выпущен и PDF сформирован")).toBeDefined();
    const create = requests.find(
      ({ url, init }) => url.endsWith("/api/platform/billing/acts") && init?.method === "POST",
    );
    expect(JSON.parse(String(create?.init?.body))).toMatchObject({
      tenantId: TENANT_ID,
      requestId: REQUEST_ID,
      invoiceId: INVOICE_ID,
      number: "MRK-ACT-000021",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
    const issue = requests.find(({ url }) => url.endsWith(`/${ACT_ID}/issue`));
    expect(issue?.init?.body).not.toBeInstanceOf(FormData);
    expect(JSON.parse(String(issue?.init?.body))).toMatchObject({
      idempotencyKey: expect.stringMatching(/[0-9a-f-]{36}/),
      printVariant: "signed",
    });
    await waitFor(() =>
      expect(requests.filter(({ url }) => url.endsWith("/issue"))).toHaveLength(1),
    );
  });

  it("allows choosing the signed form without duplicating the server seller check", async () => {
    const invoiceWithAnotherSellerSnapshot = {
      ...invoiceDetail,
      sellerSnapshot: {
        ...invoiceDetail.sellerSnapshot,
        inn: "7700000000",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
        if (url.endsWith("/api/platform/invoices") && method === "GET") {
          return jsonResponse(200, { items: [invoice] });
        }
        if (url.endsWith(`/api/platform/invoices/${INVOICE_ID}`) && method === "GET") {
          return jsonResponse(200, invoiceWithAnotherSellerSnapshot);
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    const user = userEvent.setup();

    renderSaasApp({ initialEntry: "/billing-acts/new" });
    await user.click(await screen.findByRole("combobox", { name: "Счёт-основание" }));
    await user.click(screen.getByRole("option", { name: /MRK-INV-000021/ }));

    const signedPrint = await screen.findByRole("checkbox", {
      name: "Добавить подпись и печать",
    });
    expect(signedPrint.hasAttribute("disabled")).toBe(false);
    await user.click(signedPrint);
    expect(signedPrint.getAttribute("aria-checked")).toBe("true");
  });

  it("retries generation with the same issue operation and does not create a second act", async () => {
    const createBodies: string[] = [];
    const issueBodies: string[] = [];
    const legacyInvoice = { ...invoice, number: "INV-000021" };
    const legacyInvoiceDetail = { ...invoiceDetail, number: "INV-000021" };
    let issueAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
        if (url.endsWith("/api/platform/invoices") && method === "GET") {
          return jsonResponse(200, { items: [legacyInvoice] });
        }
        if (url.endsWith(`/api/platform/invoices/${INVOICE_ID}`) && method === "GET") {
          return jsonResponse(200, legacyInvoiceDetail);
        }
        if (url.endsWith("/api/platform/billing/acts") && method === "POST") {
          createBodies.push(String(init?.body));
          return jsonResponse(201, act("draft"));
        }
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}/issue`) && method === "POST") {
          issueBodies.push(String(init?.body));
          issueAttempts += 1;
          return issueAttempts === 1
            ? jsonResponse(503, { code: "storage_unavailable" })
            : jsonResponse(201, act("issued"));
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    const user = userEvent.setup();

    renderSaasApp({ initialEntry: "/billing-acts/new" });
    await user.click(await screen.findByRole("combobox", { name: "Счёт-основание" }));
    await user.click(screen.getByRole("option", { name: /INV-000021/ }));
    await screen.findByText("Настройка интеграции");
    await user.click(screen.getByRole("button", { name: "Выпустить акт" }));
    await user.click(await screen.findByRole("button", { name: "Продолжить выпуск черновика" }));

    expect(await screen.findByText("Акт выпущен и PDF сформирован")).toBeDefined();
    expect(createBodies).toHaveLength(1);
    expect(JSON.parse(createBodies[0] ?? "{}")).toMatchObject({ number: "MRK-ACT-000021" });
    expect(issueBodies).toHaveLength(2);
    expect(issueBodies[0]).toBe(issueBodies[1]);
  });

  it("keeps a named draft recoverable when issue permission is revoked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
        if (url.endsWith("/api/platform/invoices") && method === "GET") {
          return jsonResponse(200, { items: [invoice] });
        }
        if (url.endsWith(`/api/platform/invoices/${INVOICE_ID}`) && method === "GET") {
          return jsonResponse(200, invoiceDetail);
        }
        if (url.endsWith("/api/platform/billing/acts") && method === "POST") {
          return jsonResponse(201, act("draft"));
        }
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}/issue`) && method === "POST") {
          return jsonResponse(403, { code: "forbidden" });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    const user = userEvent.setup();
    const rendered = renderSaasApp({ initialEntry: "/billing-acts/new" });
    const invalidate = vi.spyOn(rendered.queryClient, "invalidateQueries");

    await user.click(await screen.findByRole("combobox", { name: "Счёт-основание" }));
    await user.click(screen.getByRole("option", { name: /MRK-INV-000021/ }));
    await screen.findByText("Настройка интеграции");
    await user.click(screen.getByRole("button", { name: "Выпустить акт" }));

    expect(await screen.findByRole("heading", { name: "Выпуск акта недоступен" })).toBeDefined();
    expect(screen.getByRole("link", { name: "MRK-ACT-000021" }).getAttribute("href")).toBe(
      `/billing-acts/${ACT_ID}`,
    );
    expect(screen.queryByText(ACT_ID)).toBeNull();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["platform", "me"] });
    expect(screen.queryByRole("button", { name: /выпуск|сверить|продолжить/i })).toBeNull();
  });
});

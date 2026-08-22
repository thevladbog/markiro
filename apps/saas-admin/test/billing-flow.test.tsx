import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNTANT_ME, TENANT_ID, jsonResponse, renderSaasApp } from "./render.js";

const INVOICE_ID = "91111111-1111-4111-8111-111111111111";
const LINE_ID = "92111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-08-21T10:00:00.000Z";

const invoiceBase = {
  id: INVOICE_ID,
  number: "INV-000021",
  tenantId: TENANT_ID,
  issueDate: "2026-08-21T10:00:00.000Z",
  dueDate: "2026-08-28T10:00:00.000Z",
  currency: "RUB",
  sellerSnapshot: { displayName: "Markiro" },
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
  documents: [],
  payment: null,
  application: { status: "not_paid", latestByLine: [], attempts: [] },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function installApi() {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let paymentAttempts = 0;
  let paid = false;
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
        return jsonResponse(
          200,
          paid
            ? {
                ...issuedDetail,
                status: "paid",
                paidAt: "2026-08-21T12:00:00.000Z",
                payment: {
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
            : issuedDetail,
        );
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
  return { calls: () => structuredClone(calls) };
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
});

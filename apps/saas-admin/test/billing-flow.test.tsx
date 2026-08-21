import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNTANT_ME, TENANT_ID, jsonResponse, renderSaasApp } from "./render.js";

const INVOICE_ID = "91111111-1111-4111-8111-111111111111";
const LINE_ID = "92111111-1111-4111-8111-111111111111";

const issuedDetail = {
  id: INVOICE_ID,
  number: "INV-000021",
  tenantId: TENANT_ID,
  status: "issued",
  issueDate: "2026-08-21T10:00:00.000Z",
  dueDate: "2026-08-28T10:00:00.000Z",
  total: "15000.00",
  subtotal: "12500.00",
  vatTotal: "2500.00",
  currency: "RUB",
  applicationMode: "automatic",
  paidAt: null,
  lines: [
    {
      id: LINE_ID,
      position: 1,
      kind: "plan",
      catalogVersionId: "11111111-1111-4111-8111-111111111111",
      nameRu: "Производство",
      nameEn: "Production",
      quantity: 1,
      unit: "месяц",
      agreedUnitPrice: "15000.00",
      lineTotal: "15000.00",
      activationPolicy: "manual",
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
                  paidAt: "2026-08-21T12:00:00.000Z",
                  amount: "15000.00",
                  currency: "RUB",
                  bankReference: "BANK-42",
                },
                application: {
                  status: "pending",
                  latestByLine: [
                    {
                      id: "94111111-1111-4111-8111-111111111111",
                      invoiceLineId: LINE_ID,
                      attempt: 1,
                      status: "pending",
                      kind: "plan",
                      source: "payment",
                      afterSnapshot: null,
                      errorCode: null,
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
          paidAt: body.paidAt,
          amount: body.amount,
          currency: "RUB",
          bankReference: body.bankReference,
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
  it("opens a dedicated invoice route from the billing register", async () => {
    installApi();
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: "/billing" });

    const link = await screen.findByRole("link", { name: "INV-000021" });
    expect(link.getAttribute("href")).toBe(`/billing/${INVOICE_ID}`);
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

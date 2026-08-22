import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACCOUNTANT_ME, jsonResponse, renderSaasApp, TENANT_ID } from "./render.js";

const MATCH_ID = "81111111-1111-4111-8111-111111111111";
const INVOICE_ID = "82111111-1111-4111-8111-111111111111";
const IMPORT_ID = "83111111-1111-4111-8111-111111111111";
const IMPORT_ROW_ID = "84111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-08-21T10:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("payments registry", () => {
  it("imports a file and resolves an unknown payer without exposing its full account", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const method = init.method ?? "GET";
        if (path.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
        if (path.endsWith("/api/platform/payments") && method === "GET") {
          return jsonResponse(200, { items: [] });
        }
        if (path.endsWith("/api/platform/payments/matches") && method === "GET") {
          return jsonResponse(200, { items: [unknownMatch()] });
        }
        if (path.endsWith("/api/platform/payments/imports") && method === "POST") {
          calls.push({ method, path, body: JSON.parse(String(init.body)) });
          return jsonResponse(201, {
            id: IMPORT_ID,
            source: "bank_import",
            sourceChecksum: "a".repeat(64),
            fileName: "bank.csv",
            parserVersion: "bank-csv-v1",
            status: "ready",
            rowCount: 1,
            errorCount: 0,
            createdByPlatformUserId: "user-1",
            createdAt: CREATED_AT,
          });
        }
        if (path.endsWith(`/api/platform/payments/matches/${MATCH_ID}`) && method === "PATCH") {
          const body = JSON.parse(String(init.body));
          calls.push({ method, path, body });
          return jsonResponse(200, {
            ...unknownMatch(),
            status: "matched",
            score: 100,
            reason: body.reason,
            decidedByPlatformUserId: "user-1",
            decidedAt: CREATED_AT,
          });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: "/payments" });

    expect(await screen.findByRole("heading", { name: "Платежи" })).toBeDefined();
    expect(await screen.findByText("Неизвестный счёт · •••• 9999")).toBeDefined();
    expect(document.body.textContent).not.toContain("40702810900000009999");
    expect(screen.getByRole("link", { name: "INV-700003" }).getAttribute("href")).toBe(
      `/invoices/${INVOICE_ID}`,
    );
    expect(screen.getByRole("link", { name: "Юридические данные" }).getAttribute("href")).toBe(
      `/tenants/${TENANT_ID}?tab=legal`,
    );

    const file = new File(
      ["amount,payer_account,purpose\n100.00,40702810900000009999,INV-700003"],
      "bank.csv",
      { type: "text/csv" },
    );
    await user.upload(screen.getByLabelText("Файл банковской выписки"), file);
    await user.click(screen.getByRole("button", { name: "Импортировать" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));

    await user.type(
      screen.getByLabelText("Причина решения REF-C"),
      "Проверено по банковской выписке",
    );
    await user.click(screen.getByRole("button", { name: "Подтвердить без добавления счёта" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PATCH",
        path: `/api/platform/payments/matches/${MATCH_ID}`,
        body: {
          decision: "matched",
          tenantId: TENANT_ID,
          invoiceId: INVOICE_ID,
          tenantBankAccountId: null,
          reason: "Проверено по банковской выписке",
        },
      }),
    );
  });
});

function unknownMatch() {
  return {
    id: MATCH_ID,
    importId: IMPORT_ID,
    importRowId: IMPORT_ROW_ID,
    sourceRowId: "1",
    operationDate: CREATED_AT,
    amount: "100.00",
    currency: "RUB",
    payerName: "ООО Плательщик",
    paymentPurpose: "Оплата INV-700003",
    bankReference: "REF-C",
    tenantId: TENANT_ID,
    invoiceId: INVOICE_ID,
    invoiceNumber: "INV-700003",
    status: "needs_review",
    score: 80,
    reason: "unknown_payer_account",
    tenantBankAccountId: null,
    payerAccountEvidence: { kind: "unknown", last4: "9999" },
    decidedByPlatformUserId: null,
    decidedAt: null,
    createdAt: CREATED_AT,
  } as const;
}

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
    expect(screen.getByText("Импорт, сверка и фиксация банковских оплат.")).toBeDefined();
    expect(await screen.findByText("Неизвестный счёт · •••• 9999")).toBeDefined();
    expect(document.body.textContent).not.toContain("40702810900000009999");
    expect(screen.getByRole("link", { name: "INV-700003" }).getAttribute("href")).toBe(
      `/invoices/${INVOICE_ID}`,
    );
    expect(screen.getByRole("link", { name: "Юридические данные" }).getAttribute("href")).toBe(
      `/tenants/${TENANT_ID}?tab=legal`,
    );
    expect(screen.getByRole("button", { name: "Файл банковской выписки" }).className).toContain(
      "mk-file-drop",
    );

    const file = new File(
      ["amount,payer_account,purpose\n100.00,40702810900000009999,INV-700003"],
      "bank.csv",
      { type: "text/csv" },
    );
    await user.upload(screen.getByTestId("file-drop-input"), file);
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

  it("accepts and decodes a Windows-1251 1C TXT statement before import", async () => {
    const calls: Array<{ fileName: string; content: string }> = [];
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
          return jsonResponse(200, { items: [] });
        }
        if (path.endsWith("/api/platform/payments/imports") && method === "POST") {
          calls.push(JSON.parse(String(init.body)) as { fileName: string; content: string });
          return jsonResponse(201, {
            id: IMPORT_ID,
            source: "bank_import",
            sourceChecksum: "b".repeat(64),
            fileName: "1c-bank.txt",
            parserVersion: "bank-1c-client-bank-exchange-v1",
            status: "ready",
            rowCount: 1,
            errorCount: 0,
            createdByPlatformUserId: "user-1",
            createdAt: CREATED_AT,
          });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const statement = [
      "1CClientBankExchange",
      "ВерсияФормата=1.03",
      "Кодировка=Windows",
      "СекцияДокумент=Платежное поручение",
      "Номер=42",
      "Дата=29.08.2026",
      "Сумма=15000.00",
      "Плательщик=ООО Фабрика",
      "ПлательщикСчет=40702810900000000001",
      "НазначениеПлатежа=Оплата по счету INV-000021",
      "КонецДокумента",
      "КонецФайла",
    ].join("\r\n");
    const file = new File([encodeWindows1251(statement)], "1c-bank.txt", {
      type: "text/plain",
    });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: "/payments" });

    await screen.findByRole("heading", { name: "Платежи" });
    await user.upload(screen.getByTestId("file-drop-input"), file);
    expect(screen.getByText("1c-bank.txt")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Импортировать" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ fileName: "1c-bank.txt" });
    expect(calls[0]?.content).toContain("Плательщик=ООО Фабрика");
    expect(calls[0]?.content).not.toContain("�");
  });
});

function encodeWindows1251(value: string): ArrayBuffer {
  const bytes = Uint8Array.from(
    [...value].map((character) => {
      const code = character.codePointAt(0) ?? 0x3f;
      if (code <= 0x7f) return code;
      if (code === 0x401) return 0xa8;
      if (code === 0x451) return 0xb8;
      if (code >= 0x410 && code <= 0x42f) return 0xc0 + code - 0x410;
      if (code >= 0x430 && code <= 0x44f) return 0xe0 + code - 0x430;
      return 0x3f;
    }),
  );
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

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

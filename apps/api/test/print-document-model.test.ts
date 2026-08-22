import { describe, expect, it } from "vitest";

import { toInvoicePrintModel } from "../src/modules/billing/print-document-model";

describe("print document model", () => {
  it("uses only the issued invoice snapshot and literal line values", () => {
    expect(
      toInvoicePrintModel({
        number: "INV-000001",
        status: "issued",
        issueDate: new Date("2026-08-12T00:00:00.000Z"),
        dueDate: new Date("2026-08-20T00:00:00.000Z"),
        sellerSnapshot: { legalName: "ООО Оператор" },
        buyerSnapshot: { legalName: "ООО Покупатель" },
        sellerBankAccountSnapshot: {
          settlementAccount: "40702810900000000001",
          bankName: "Банк продавца",
          correspondentAccount: "30101810400000000001",
        },
        buyerBankAccountSnapshot: {
          settlementAccount: "40702810900000000002",
          bankName: "Банк покупателя",
          correspondentAccount: "30101810400000000002",
        },
        subtotal: "100.00",
        vatTotal: "20.00",
        total: "120.00",
        lines: [
          {
            position: 1,
            nameRu: "Тариф",
            unit: "месяц",
            quantity: 1,
            agreedUnitPrice: "120.00",
            vatIncluded: true,
            lineTotal: "120.00",
          },
        ],
      }),
    ).toMatchObject({
      kind: "invoice",
      number: "INV-000001",
      seller: {
        legalName: "ООО Оператор",
        bankAccount: "40702810900000000001",
        bankName: "Банк продавца",
      },
      buyer: {
        legalName: "ООО Покупатель",
        bankAccount: "40702810900000000002",
        bankName: "Банк покупателя",
      },
      total: "120.00",
    });
  });
});

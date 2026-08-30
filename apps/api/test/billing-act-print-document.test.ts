import { describe, expect, it } from "vitest";

import {
  documentBarcodeValue,
  documentKindLabel,
  documentSubject,
} from "../src/modules/billing/print-document-layout";
import { toBillingActPrintModel } from "../src/modules/billing/print-document-model";
import { renderPrintPdf } from "../src/modules/billing/print-document-pdf";

describe("generated billing act document", () => {
  it("copies frozen invoice parties, lines, and totals into an act model", () => {
    const model = toBillingActPrintModel(
      {
        number: "ACT-000021",
        createdAt: new Date("2026-08-21T10:00:00.000Z"),
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
      },
      {
        number: "INV-000021",
        status: "issued",
        issueDate: new Date("2026-08-21T10:00:00.000Z"),
        dueDate: new Date("2026-08-28T10:00:00.000Z"),
        sellerSnapshot: { legalName: "ООО Маркиро", taxId: "9700000000" },
        buyerSnapshot: { legalName: "ООО Фабрика", taxId: "7700000000" },
        sellerBankAccountSnapshot: null,
        buyerBankAccountSnapshot: null,
        subtotal: "12500.00",
        vatTotal: "2500.00",
        total: "15000.00",
        lines: [
          {
            position: 1,
            nameRu: "Настройка интеграции",
            descriptionRu: null,
            unit: "услуга",
            quantity: 1,
            agreedUnitPrice: "15000.00",
            vatRate: "20.00",
            vatIncluded: true,
            lineTotal: "15000.00",
          },
        ],
      },
    );

    expect(model).toMatchObject({
      kind: "act",
      number: "ACT-000021",
      sourceNumber: "INV-000021",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      seller: { legalName: "ООО Маркиро", taxId: "9700000000" },
      buyer: { legalName: "ООО Фабрика", taxId: "7700000000" },
      lines: [{ name: "Настройка интеграции", lineTotal: "15000.00" }],
      total: "15000.00",
    });
    expect(documentKindLabel(model)).toBe("АКТ ОКАЗАННЫХ УСЛУГ");
    expect(documentSubject(model)).toBe("Акт оказанных услуг");
    expect(documentBarcodeValue(model)).toBe("ACT-ACT-000021");
  });

  it("renders identical bytes for an idempotent issue retry", async () => {
    const model = toBillingActPrintModel(
      {
        number: "ACT-000021",
        createdAt: new Date("2026-08-21T10:00:00.000Z"),
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
      },
      {
        number: "INV-000021",
        status: "issued",
        issueDate: new Date("2026-08-21T10:00:00.000Z"),
        dueDate: null,
        sellerSnapshot: { legalName: "ООО Маркиро" },
        buyerSnapshot: { legalName: "ООО Фабрика" },
        subtotal: "100.00",
        vatTotal: "0.00",
        total: "100.00",
        lines: [],
      },
    );

    const first = await renderPrintPdf(model);
    const retry = await renderPrintPdf(model);

    expect(first.equals(retry)).toBe(true);
  });
});

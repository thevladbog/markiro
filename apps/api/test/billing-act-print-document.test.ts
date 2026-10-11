import { describe, expect, it } from "vitest";

import { renderPrintHtml } from "../src/modules/billing/print-document-html";
import {
  documentBarcodeValue,
  documentKindLabel,
  documentSubject,
  documentVatBasis,
} from "../src/modules/billing/print-document-layout";
import { toBillingActPrintModel } from "../src/modules/billing/print-document-model";
import { renderPrintPdf } from "../src/modules/billing/print-document-pdf";

describe("generated billing act document", () => {
  it("copies frozen invoice parties, lines, and totals into an act model", () => {
    const model = toBillingActPrintModel(
      {
        number: "MRK-ACT-000021",
        createdAt: new Date("2026-08-21T10:00:00.000Z"),
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
      },
      {
        number: "MRK-INV-000021",
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
      [
        {
          entryId: "35f756bd-1145-4f87-a198-c7d40db33724",
          servicePeriodId: "3e9f04ed-265a-4af0-b950-daaf77171d18",
          sequence: 1,
          kind: "usage",
          classification: "customer_service",
          originalEntryId: null,
          workReference: "SUP-42",
          description: "Настройка интеграции",
          performedAt: "2026-07-14T09:00:00.000Z",
          postedAt: "2026-07-14T10:00:00.000Z",
          actualMinutes: 45,
          allowanceMinutes: 45,
        },
      ],
    );

    expect(model).toMatchObject({
      kind: "act",
      number: "MRK-ACT-000021",
      sourceNumber: "MRK-INV-000021",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      seller: { legalName: "ООО Маркиро", taxId: "9700000000" },
      buyer: { legalName: "ООО Фабрика", taxId: "7700000000" },
      lines: [{ name: "Настройка интеграции", lineTotal: "15000.00" }],
      serviceUsage: [
        {
          workReference: "SUP-42",
          description: "Настройка интеграции",
          actualMinutes: 45,
          allowanceMinutes: 45,
        },
      ],
      total: "15000.00",
    });
    expect(documentKindLabel(model)).toBe("АКТ ОКАЗАННЫХ УСЛУГ");
    expect(documentSubject(model)).toBe("Акт оказанных услуг");
    expect(documentBarcodeValue(model)).toBe("MRK-ACT-000021");
  });

  it("renders identical bytes for an idempotent issue retry", async () => {
    const model = toBillingActPrintModel(
      {
        number: "MRK-ACT-000021",
        createdAt: new Date("2026-08-21T10:00:00.000Z"),
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
      },
      {
        number: "MRK-INV-000021",
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

  it("keeps the frozen NPD seller basis and ОГРНИП in deterministic act bytes", async () => {
    const actFor = (regime: "npd" | "other") =>
      toBillingActPrintModel(
        {
          number: "MRK-ACT-000022",
          createdAt: new Date("2026-09-29T10:00:00.000Z"),
          periodStart: "2026-09-01",
          periodEnd: "2026-09-30",
        },
        {
          number: "MRK-INV-000022",
          status: "paid",
          issueDate: new Date("2026-09-01T10:00:00.000Z"),
          dueDate: null,
          sellerSnapshot: {
            kind: "sole_proprietor",
            fullName: "ИП Оператор",
            inn: "234106228141",
            kpp: null,
            ogrn: null,
            ogrnip: "324237500123456",
            taxPolicy: { kind: "without_vat", regime },
          },
          buyerSnapshot: {
            kind: "legal_entity",
            fullName: "ООО Фабрика",
            inn: "7812014560",
            kpp: "781201001",
            ogrn: "1027800000000",
            ogrnip: null,
          },
          subtotal: "15000.00",
          vatTotal: "0.00",
          total: "15000.00",
          lines: [
            {
              position: 1,
              commercialTerms: {
                version: 1,
                subject: "service",
                documentNameRu: "Настройка интеграции",
                documentNameEn: null,
                sellerPolicyRevision: 1,
                billingPeriod: null,
                billingTimezone: null,
                activationRule: null,
              },
              nameRu: "Настройка интеграции",
              descriptionRu: null,
              unit: "услуга",
              quantity: 1,
              agreedUnitPrice: "15000.00",
              vatRate: null,
              vatIncluded: false,
              lineTotal: "15000.00",
            },
          ],
        },
      );
    const model = actFor("npd");

    expect(documentVatBasis(model)).toBe(
      "Без НДС: Исполнитель применяет НПД; основание — часть 9 статьи 2 Федерального закона от 27.11.2018 № 422-ФЗ.",
    );
    expect(documentVatBasis(actFor("other"))).toBeNull();
    expect(renderPrintHtml(model)).toContain("ИНН 234106228141 · ОГРНИП 324237500123456");

    const first = await renderPrintPdf(model);
    const retry = await renderPrintPdf(actFor("npd"));

    expect(first.equals(retry)).toBe(true);
    expect(first.equals(await renderPrintPdf(actFor("other")))).toBe(false);
  });
});

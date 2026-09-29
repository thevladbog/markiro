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

  it("carries the frozen registration number kind and seller tax policy", () => {
    const model = toInvoicePrintModel({
      number: "INV-000002",
      status: "issued",
      issueDate: new Date("2026-09-29T09:00:00.000Z"),
      dueDate: null,
      sellerSnapshot: {
        kind: "sole_proprietor",
        fullName: "ИП Оператор",
        inn: "234106228141",
        kpp: null,
        ogrn: null,
        ogrnip: "324237500123456",
        taxPolicy: { kind: "without_vat", regime: "npd" },
      },
      buyerSnapshot: {
        kind: "legal_entity",
        fullName: "ООО Покупатель",
        inn: "7812014560",
        kpp: "781201001",
        ogrn: "1027800000000",
        ogrnip: null,
      },
      subtotal: "100.00",
      vatTotal: "0.00",
      total: "100.00",
      lines: [],
    });

    expect(model.seller).toMatchObject({
      registrationId: "324237500123456",
      registrationKind: "ogrnip",
      taxPolicy: { kind: "without_vat", regime: "npd" },
    });
    expect(model.buyer).toMatchObject({
      registrationId: "1027800000000",
      registrationKind: "ogrn",
      taxPolicy: null,
    });
  });

  it("keeps snapshots frozen before the tax policy was recorded without a tax basis", () => {
    const model = toInvoicePrintModel({
      number: "INV-000003",
      status: "issued",
      issueDate: new Date("2026-08-12T00:00:00.000Z"),
      dueDate: null,
      sellerSnapshot: { legalName: "ООО Оператор", registrationId: "1027700132195" },
      buyerSnapshot: {
        legalName: "ИП Покупатель",
        kind: "sole_proprietor",
        ogrnip: "324237500123456",
      },
      subtotal: "0.00",
      vatTotal: "0.00",
      total: "0.00",
      lines: [],
    });

    expect(model.seller).toMatchObject({ registrationKind: "ogrn", taxPolicy: null });
    expect(model.buyer).toMatchObject({ registrationKind: "ogrnip", taxPolicy: null });
  });
  it.each([
    ["unit", "шт."],
    ["hour", "час"],
    ["person", "чел."],
    ["person_day", "чел.-дн."],
    ["day", "дн."],
    ["project", "проект"],
    ["session", "сессия"],
    ["package", "пакет"],
    ["service", "услуга"],
    ["right", "право"],
    ["work", "работа"],
    ["месяц", "месяц"],
    ["license", "license"],
  ])("prints the stored line unit %s as %s", (stored, printed) => {
    const model = toInvoicePrintModel({
      number: "INV-000003",
      status: "issued",
      issueDate: new Date("2026-08-12T00:00:00.000Z"),
      dueDate: null,
      sellerSnapshot: { legalName: "ООО Оператор" },
      buyerSnapshot: { legalName: "ООО Покупатель" },
      subtotal: "100.00",
      vatTotal: "0.00",
      total: "100.00",
      lines: [
        {
          position: 1,
          nameRu: "Позиция",
          unit: stored,
          quantity: 1,
          agreedUnitPrice: "100.00",
          vatIncluded: false,
          lineTotal: "100.00",
        },
      ],
    });
    expect(model.lines[0]?.unit).toBe(printed);
  });
});

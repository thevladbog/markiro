import { describe, expect, it } from "vitest";

import { parseBankStatement } from "../src/modules/billing-payments/bank-statement-parser";

describe("bank statement parser", () => {
  it("keeps the existing CSV import format", () => {
    const parsed = parseBankStatement(
      [
        "amount,date,payer,payer_account,purpose,reference",
        "15000.00,2026-08-29,ООО Фабрика,40702810900000000001,Оплата INV-000021,42",
      ].join("\n"),
    );

    expect(parsed.parserVersion).toBe("bank-csv-v1");
    expect(parsed.rows[0]).toMatchObject({
      amount: "15000.00",
      payerName: "ООО Фабрика",
      payerAccount: "40702810900000000001",
      paymentPurpose: "Оплата INV-000021",
      bankReference: "42",
      parseError: null,
    });
  });

  it("parses a 1C ClientBankExchange TXT statement", () => {
    const parsed = parseBankStatement(
      [
        "1CClientBankExchange",
        "ВерсияФормата=1.03",
        "Кодировка=Windows",
        "ДатаНачала=29.08.2026",
        "ДатаКонца=29.08.2026",
        "РасчСчет=40702810123450000001",
        "СекцияДокумент=Платежное поручение",
        "Номер=42",
        "Дата=29.08.2026",
        "Сумма=15000.00",
        "Плательщик=ООО Фабрика",
        "ПлательщикСчет=40702810900000000001",
        "НазначениеПлатежа=Оплата по счету MRK-INV-000021",
        "КонецДокумента",
        "КонецФайла",
      ].join("\r\n"),
    );

    expect(parsed.parserVersion).toBe("bank-1c-client-bank-exchange-v1");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      sourceRowId: "1",
      amount: "15000.00",
      currency: "RUB",
      payerName: "ООО Фабрика",
      payerAccount: "40702810900000000001",
      paymentPurpose: "Оплата по счету MRK-INV-000021",
      bankReference: "42",
      parseError: null,
    });
    expect(parsed.rows[0]?.operationDate?.toISOString()).toBe("2026-08-29T00:00:00.000Z");
  });

  it("rejects content that is neither a supported CSV nor a 1C statement", () => {
    expect(() => parseBankStatement("arbitrary text without a bank format")).toThrow(
      "payment_import_unsupported_format",
    );
  });
});

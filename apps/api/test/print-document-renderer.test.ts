import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { renderPrintHtml } from "../src/modules/billing/print-document-html";
import { documentBarcodeValue } from "../src/modules/billing/print-document-layout";
import { formatOfferTermsText, renderPrintPdf } from "../src/modules/billing/print-document-pdf";
import type { PrintDocumentModel, PrintLine } from "../src/modules/billing/print-document-model";

const baseLine: PrintLine = {
  position: 1,
  name: "Лицензия Markiro — Производство",
  description: "Доступ к платформе на один месяц",
  unit: "месяц",
  quantity: 1,
  unitPrice: "12000.00",
  vatIncluded: true,
  lineTotal: "12000.00",
};

const baseInvoice: PrintDocumentModel = {
  kind: "invoice",
  number: "184",
  status: "issued",
  issuedOrPublishedAt: new Date("2026-08-24T14:40:00.000Z"),
  dueOrExpiresAt: new Date("2026-08-31T20:59:59.000Z"),
  seller: {
    legalName: "ИП Богатырёв Владислав Сергеевич",
    taxId: "000000000000",
    registrationId: "000000000000000",
    kpp: null,
    address: "Москва, ул. Примерная, 1",
    bankAccount: "40802810500001234567",
    bankName: "Банк АО «Точка»",
    bic: "044525104",
    correspondentAccount: "30101810745374525104",
    currency: "RUB",
  },
  buyer: {
    legalName: "ООО Покупатель",
    taxId: "7700000000",
    kpp: "770001001",
    registrationId: "1000000000000",
    address: "Москва, ул. Тестовая, 2",
  },
  lines: [baseLine],
  subtotal: "12000.00",
  vatTotal: "0.00",
  total: "12000.00",
  termsHtml: null,
};

const count = (value: string, needle: string) => value.split(needle).length - 1;
const countPdfPages = (pdf: Buffer) =>
  (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;

describe("print document HTML renderer", () => {
  it("ships the bundled Cyrillic fonts used by PDF output", () => {
    for (const file of ["IBMPlexSans-Regular.ttf", "IBMPlexSans-SemiBold.ttf"]) {
      const path = join(process.cwd(), "src/modules/billing/assets", file);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path).subarray(0, 4).toString("hex")).toBe("00010000");
    }
  });

  it("renders a deterministic Cyrillic legal invoice", () => {
    expect(
      renderPrintHtml({
        kind: "invoice",
        number: "INV-000001",
        status: "issued",
        issuedOrPublishedAt: new Date("2026-08-12T00:00:00.000Z"),
        dueOrExpiresAt: null,
        seller: { legalName: "ООО Оператор" },
        buyer: { legalName: "ООО Покупатель" },
        lines: [],
        subtotal: "0.00",
        vatTotal: "0.00",
        total: "0.00",
        termsHtml: null,
      }),
    ).toContain("ООО Оператор");
  });

  it("renders the approved invoice hierarchy without duplicate labels", () => {
    const html = renderPrintHtml(baseInvoice);
    const body = html.split("</head><body>")[1] ?? "";

    expect(count(body, "СЧЁТ НА ОПЛАТУ")).toBe(1);
    expect(html).toContain("№ 184 · 24.08.2026");
    expect(html).toContain("Лицензия и услуги платформы Markiro");
    expect(html).not.toContain("Основной расчётный счёт");
    expect(html).not.toContain("Оплатить по QR");
    expect(html).toContain('aria-label="QR-код для оплаты счёта"');
    expect(html).toContain('aria-label="Штрихкод формы"');
    expect(count(body, "Сформировано системой Markiro")).toBe(1);
  });

  it("renders the approved eight-module Markiro lockup in the print header", () => {
    const html = renderPrintHtml(baseInvoice);
    const logo = html.match(/<svg class="brand-logo brand-logo--markiro"[\s\S]*?<\/svg>/)?.[0];

    expect(logo).toBeDefined();
    expect(count(logo ?? "", "<rect ")).toBe(9);
    expect(logo).toContain('fill="#3DDC7A"');
    expect(logo).toContain(">маркиро</text>");
    expect(logo).toContain('viewBox="0 0 280 64"');

    const bundledLogo = readFileSync(
      join(process.cwd(), "src/modules/billing/assets/markiro-logo-on-light.svg"),
      "utf8",
    );
    const approvedLogo = readFileSync(
      join(process.cwd(), "../admin/src/assets/markiro-logo-on-light.svg"),
      "utf8",
    );
    expect(bundledLogo.trim()).toBe(approvedLogo.trim());
  });

  it("renders offer cooperation terms and its non-invoice notice", () => {
    const termsHtml =
      '<h2>Порядок оплаты</h2><p>Смотрите <a href="https://markiro.ru/terms">условия</a>.</p><table><thead><tr><th>Этап</th><th>Срок</th></tr></thead><tbody><tr><td>Запуск</td><td>5 дней</td></tr></tbody></table>';
    const html = renderPrintHtml({
      ...baseInvoice,
      kind: "offer",
      number: "КП-27",
      status: "published",
      termsHtml,
    });
    const body = html.split("</head><body>")[1] ?? "";

    expect(count(body, "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ")).toBe(1);
    expect(html).toContain("УСЛОВИЯ СОТРУДНИЧЕСТВА");
    expect(html).toContain("<h2>Порядок оплаты</h2>");
    expect(html).toContain('<a href="https://markiro.ru/terms">условия</a>');
    expect(html).toContain("<table><thead><tr><th>Этап</th><th>Срок</th></tr></thead>");
    expect(html).toContain("Не является счётом на оплату");
  });

  it("preserves offer headings, links, and table rows in PDF text", () => {
    expect(
      formatOfferTermsText(
        '<h2>Порядок оплаты</h2><p>Смотрите <a href="https://markiro.ru/terms">условия</a>.</p><table><thead><tr><th>Этап</th><th>Срок</th></tr></thead><tbody><tr><td>Запуск</td><td>5 дней</td></tr></tbody></table>',
      ),
    ).toBe(
      "Порядок оплаты\nСмотрите условия (https://markiro.ru/terms).\nЭтап\tСрок\nЗапуск\t5 дней",
    );
  });

  it("keeps the machine barcode ASCII-safe for Cyrillic offer numbers", () => {
    expect(documentBarcodeValue({ ...baseInvoice, kind: "offer", number: "КП-27" })).toBe(
      "OFR-0JrQny0yNw",
    );
  });

  it("renders a line comment below the item name in HTML", () => {
    const html = renderPrintHtml({
      kind: "invoice",
      number: "INV-000002",
      status: "issued",
      issuedOrPublishedAt: new Date("2026-08-12T00:00:00.000Z"),
      dueOrExpiresAt: null,
      seller: { legalName: "ООО Оператор" },
      buyer: { legalName: "ООО Покупатель" },
      lines: [
        {
          position: 1,
          name: "Настройка линии",
          description: "Включает выезд и первичную калибровку",
          unit: "услуга",
          quantity: 1,
          unitPrice: "100.00",
          vatIncluded: true,
          lineTotal: "100.00",
        },
      ],
      subtotal: "100.00",
      vatTotal: "0.00",
      total: "100.00",
      termsHtml: null,
    });

    expect(html).toContain(
      "<strong>Настройка линии</strong><small>Включает выезд и первичную калибровку</small>",
    );
    expect(html).toContain("td small{display:block;color:#666");
  });

  it("renders a valid PDF from the same model", async () => {
    const pdf = await renderPrintPdf({
      kind: "offer",
      number: "KP-000001",
      status: "published",
      issuedOrPublishedAt: new Date("2026-08-12T00:00:00.000Z"),
      dueOrExpiresAt: null,
      seller: { legalName: "ООО Оператор" },
      buyer: { legalName: "ООО Покупатель" },
      lines: [],
      subtotal: "0.00",
      vatTotal: "0.00",
      total: "0.00",
      termsHtml: null,
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.byteLength).toBeLessThan(10 * 1024 * 1024);
  });

  it("includes a line comment in the PDF output", async () => {
    const baseLine = {
      position: 1,
      name: "Настройка линии",
      unit: "услуга",
      quantity: 1,
      unitPrice: "100.00",
      vatIncluded: true,
      lineTotal: "100.00",
    };
    const base = {
      kind: "invoice" as const,
      number: "INV-000003",
      status: "issued",
      issuedOrPublishedAt: new Date("2026-08-12T00:00:00.000Z"),
      dueOrExpiresAt: null,
      seller: { legalName: "ООО Оператор" },
      buyer: { legalName: "ООО Покупатель" },
      lines: [baseLine],
      subtotal: "100.00",
      vatTotal: "0.00",
      total: "100.00",
      termsHtml: null,
    };
    const withoutComment = await renderPrintPdf(base);
    const withComment = await renderPrintPdf({
      ...base,
      lines: [
        {
          ...baseLine,
          description: "Включает выезд и первичную калибровку",
        },
      ],
    });

    expect(withComment.byteLength).not.toBe(withoutComment.byteLength);
  });

  it("keeps browser print furniture out while repeating document chrome", async () => {
    const lines = Array.from({ length: 15 }, (_, index) => ({
      ...baseLine,
      position: index + 1,
      name: `Позиция ${index + 1}`,
      description: `Комментарий к позиции ${index + 1}`,
    }));

    const model = { ...baseInvoice, lines };
    const html = renderPrintHtml(model);
    const pdf = await renderPrintPdf(model);

    expect(countPdfPages(pdf)).toBe(2);
    expect(html).toContain("@page{size:A4;margin:0}");
    expect(html).toContain(".document-header{position:fixed");
    expect(html).toContain('.document-id span::after{content:""}');
    expect(html).toContain(".document-footer{position:fixed");
    expect(html).not.toContain("counter(page)");
    expect(html).not.toContain("@top-left{");
    expect(html).not.toContain("@bottom-left{");
    expect(html).not.toContain("Лист 1 из 2");
    expect(count(html, "БАНКОВСКИЕ РЕКВИЗИТЫ")).toBe(1);
  });

  it("lets the renderers paginate maximum-size comments and cooperation terms", async () => {
    const longDescription = "Подробное описание услуги ".repeat(380).slice(0, 9_900);
    const longTerms = `<h2>Подробные условия</h2><p>${"Условие сотрудничества ".repeat(820).slice(0, 19_000)}</p>`;
    const model: PrintDocumentModel = {
      ...baseInvoice,
      kind: "offer",
      number: "КП-LONG",
      status: "published",
      lines: [{ ...baseLine, description: longDescription }],
      termsHtml: longTerms,
    };

    const html = renderPrintHtml(model);
    const pdf = await renderPrintPdf(model);

    expect(countPdfPages(pdf)).toBeGreaterThan(3);
    expect(html).toContain(longDescription);
    expect(html).toContain("Подробные условия");
    expect(html).toContain("@page{size:A4;margin:0}");
  });
});

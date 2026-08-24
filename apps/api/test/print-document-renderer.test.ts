import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { renderPrintHtml } from "../src/modules/billing/print-document-html";
import { renderPrintPdf } from "../src/modules/billing/print-document-pdf";

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
    const base = {
      kind: "invoice" as const,
      number: "INV-000003",
      status: "issued",
      issuedOrPublishedAt: new Date("2026-08-12T00:00:00.000Z"),
      dueOrExpiresAt: null,
      seller: { legalName: "ООО Оператор" },
      buyer: { legalName: "ООО Покупатель" },
      lines: [
        {
          position: 1,
          name: "Настройка линии",
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
    };
    const withoutComment = await renderPrintPdf(base);
    const withComment = await renderPrintPdf({
      ...base,
      lines: [
        {
          ...base.lines[0]!,
          description: "Включает выезд и первичную калибровку",
        },
      ],
    });

    expect(withComment.byteLength).not.toBe(withoutComment.byteLength);
  });
});

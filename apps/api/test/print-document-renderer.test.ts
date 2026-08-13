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
});

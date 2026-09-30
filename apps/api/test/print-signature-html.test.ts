import { SIGNED_PRINT_SELLER_TAX_ID } from "@markiro/platform-contracts";
import { describe, expect, it } from "vitest";

import { renderPrintHtml } from "../src/modules/billing/print-document-html";
import type { PrintDocumentModel } from "../src/modules/billing/print-document-model";

const model = (
  kind: PrintDocumentModel["kind"],
  contactName: string | null,
): PrintDocumentModel => ({
  kind,
  number: kind === "offer" ? "MRK-CO-000001" : "MRK-INV-000001",
  status: "issued",
  issuedOrPublishedAt: new Date("2026-09-30T00:00:00.000Z"),
  dueOrExpiresAt: null,
  seller: {
    legalName: "Индивидуальный предприниматель Богатырев Владислав Сергеевич",
    taxId: SIGNED_PRINT_SELLER_TAX_ID,
    contact: { name: contactName, email: null, phone: null },
  },
  buyer: { legalName: "ООО Покупатель" },
  lines: [],
  subtotal: "0.00",
  vatTotal: "0.00",
  total: "0.00",
  termsHtml: null,
});

const NAME = "Богатырев Владислав Сергеевич";
const SEALED_SLOT = /<div class="stamp stamp--sealed"><img class="legal-seal"[^>]*><\/div>/;

describe("signed print form signature block", () => {
  it.each(["offer", "invoice"] as const)(
    "prints the signer name and puts the %s seal into the right slot",
    (kind) => {
      const html = renderPrintHtml(model(kind, NAME), { printVariant: "signed" });
      expect(html).toContain('<span class="signer-name">В. С. Богатырев</span>');
      expect(html).toMatch(SEALED_SLOT);
      expect(html).not.toContain("МЕСТО ДЛЯ ПЕЧАТИ");
      expect(html.split('class="legal-seal"')).toHaveLength(2);
      expect(html.split('class="authorized-signature"')).toHaveLength(2);
      const block = html.match(/<div class="signature signature--signed">.*?<\/small>/s)?.[0] ?? "";
      expect(block).toContain('class="authorized-signature"');
      expect(block).not.toContain('class="legal-seal"');
    },
  );

  it("lays the signature over the signature field, before the slash", () => {
    const html = renderPrintHtml(model("offer", NAME), { printVariant: "signed" });
    expect(html).toMatch(
      /<span class="signature-field"><img class="authorized-signature"[^>]*>________________<\/span><span class="signature-slash"> \/ <\/span><span class="signer-name">/,
    );
  });

  it("puts the act seal at the edge of the executor column and keeps the customer block", () => {
    const html = renderPrintHtml(model("act", NAME), { printVariant: "signed" });
    expect(html).toContain('<section class="signing signing--act">');
    expect(html).not.toContain('class="stamp stamp--sealed"');
    const executor =
      html.match(/<div class="signature signature--signed">.*?<\/small>(.*?)<\/div>/s)?.[1] ?? "";
    expect(executor).toContain('<img class="legal-seal"');
    expect(html).toContain("ЗАКАЗЧИК");
    expect(html.split('class="legal-seal"')).toHaveLength(2);
  });

  it("keeps a blank decoding line when the contact has no name", () => {
    const html = renderPrintHtml(model("offer", null), { printVariant: "signed" });
    expect(html).not.toContain('class="signer-name"');
    expect(html).toContain('<span class="signature-slash"> / </span>____________________');
  });

  it("escapes the contact name", () => {
    // A single word is printed as entered (no initials), so the markup characters reach escape().
    const html = renderPrintHtml(model("offer", 'Иванов<b>x</b>"'), {
      printVariant: "signed",
    });
    expect(html).toContain('<span class="signer-name">Иванов&lt;b&gt;x&lt;/b&gt;&quot;</span>');
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("clean print form signature block", () => {
  it("is unchanged: blank line and the dashed stamp placeholder, no name and no images", () => {
    const html = renderPrintHtml(model("offer", NAME), { printVariant: "clean" });
    expect(html).toContain("<span>________________ / ____________________</span>");
    expect(html).toContain('<div class="stamp"><span>МЕСТО ДЛЯ ПЕЧАТИ</span></div>');
    expect(html).not.toContain('class="signer-name"');
    expect(html).not.toContain('class="legal-seal"');
    expect(html).not.toContain('class="authorized-signature"');
  });

  it("gives an act two equal signature columns", () => {
    const html = renderPrintHtml(model("act", NAME), { printVariant: "clean" });
    expect(html).toContain('<section class="signing signing--act">');
    expect(html).toContain("ИСПОЛНИТЕЛЬ");
    expect(html).toContain("ЗАКАЗЧИК");
  });
});

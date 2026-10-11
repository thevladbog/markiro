import { SIGNED_PRINT_SELLER_TAX_ID } from "@markiro/platform-contracts";
import { describe, expect, it } from "vitest";

import type { PrintDocumentModel } from "../src/modules/billing/print-document-model";
import { renderPrintPdf } from "../src/modules/billing/print-document-pdf";

const model = (
  kind: PrintDocumentModel["kind"],
  contactName: string | null,
): PrintDocumentModel => ({
  kind,
  number: "MRK-CO-000001",
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

describe("signed PDF print forms", () => {
  it.each(["offer", "invoice", "act"] as const)(
    "renders a signed %s and changes the bytes with the signer name",
    async (kind) => {
      const named = await renderPrintPdf(model(kind, "Богатырев Владислав Сергеевич"), {
        printVariant: "signed",
      });
      const anonymous = await renderPrintPdf(model(kind, null), { printVariant: "signed" });
      expect(named.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(named.equals(anonymous)).toBe(false);
    },
  );

  it.each(["offer", "invoice", "act"] as const)(
    "ignores the contact name in the clean %s variant",
    async (kind) => {
      const named = await renderPrintPdf(model(kind, "Богатырев Владислав Сергеевич"), {
        printVariant: "clean",
      });
      const anonymous = await renderPrintPdf(model(kind, null), { printVariant: "clean" });
      expect(named.equals(anonymous)).toBe(true);
    },
  );
});

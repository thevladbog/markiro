import { describe, expect, it } from "vitest";

import { normalizeOfferTerms } from "../src/modules/platform-offers/offer-terms";
import { createOfferSchema } from "../src/modules/platform-offers/dto";

describe("normalizeOfferTerms", () => {
  it("keeps the supported commercial formatting", () => {
    expect(
      normalizeOfferTerms(
        "# Условия\n\n**Оплата**\n\n- аванс\n\n| Этап | Срок |\n| --- | --- |\n| Запуск | 10 дней |\n\n[Договор](https://example.test)",
      ).html,
    ).toContain("<table>");
  });

  it("removes executable and unsupported source", () => {
    const result = normalizeOfferTerms(
      '<script>alert(1)</script>\n\n![logo](https://example.test/logo.png)\n\n[bad](javascript:alert(1))\n\n<iframe src="https://evil.test"></iframe>',
    );

    expect(result.html).not.toContain("script");
    expect(result.html).not.toContain("iframe");
    expect(result.html).not.toContain("img");
    expect(result.html).not.toContain("javascript:");
  });

  it("normalizes whitespace and preserves empty terms as null", () => {
    expect(normalizeOfferTerms("  \n\n ")).toEqual({ markdown: null, html: null });
    expect(normalizeOfferTerms("\nУсловия\n").markdown).toBe("Условия");
  });

  it("rejects terms longer than 20,000 characters", () => {
    expect(() => normalizeOfferTerms("x".repeat(20_001))).toThrow("offer_terms_too_long");
  });

  it("accepts nullable terms at the offer boundary", () => {
    const result = createOfferSchema.safeParse({
      tenantId: "tenant-1",
      expiresAt: null,
      termsMarkdown: null,
      lines: [
        {
          kind: "service",
          catalogVersionId: null,
          nameRu: "Внедрение",
          nameEn: "Implementation",
          quantity: 1,
          unit: "шт.",
          agreedUnitPrice: "100.00",
          vatRateBps: null,
          vatIncluded: false,
          activationPolicy: null,
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

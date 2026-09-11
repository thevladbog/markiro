import { describe, expect, it } from "vitest";
import { commercialIssuanceError } from "../src/pages/documents/commercialError.js";
describe("commercial issuance preview", () => {
  const terms = {
    version: 1 as const,
    subject: "software_license" as const,
    documentNameRu: "Лицензия",
    documentNameEn: null,
    sellerPolicyRevision: 2,
    billingPeriod: "year" as const,
    billingTimezone: "Europe/Moscow" as const,
    activationRule: "on_application" as const,
  };
  const line = {
    kind: "plan",
    quantity: 1,
    commercialTerms: terms,
    vatRate: null,
    vatIncluded: false,
  };
  const context = {
    sellerPolicyRevision: 2,
    taxPolicy: { kind: "without_vat" as const, regime: "npd" as const },
  };
  it("rejects missing seller policy and stale policy without rewriting frozen terms", () => {
    expect(commercialIssuanceError([line], { ...context, taxPolicy: null })).toBe(
      "seller_tax_policy_unconfigured",
    );
    expect(commercialIssuanceError([line], { ...context, sellerPolicyRevision: 3 })).toBe(
      "commercial_review_stale",
    );
    expect(line.commercialTerms).toEqual(terms);
  });
  it("distinguishes zero VAT from without VAT and validates plan quantity", () => {
    expect(commercialIssuanceError([line], context)).toBeNull();
    expect(
      commercialIssuanceError([{ ...line, vatRate: "0.00", vatIncluded: true }], context),
    ).toBe("seller_tax_policy_violation");
    expect(commercialIssuanceError([{ ...line, quantity: 2 }], context)).toBe(
      "commercial_plan_quantity_invalid",
    );
  });
});

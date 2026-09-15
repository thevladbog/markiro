import { describe, expect, it } from "vitest";
import {
  commercialLineTermsV4Schema,
  platformCommercialV2Contracts,
  platformCommercialV4Contracts,
  platformOfferWorkspaceV4Contracts,
} from "../src/index.js";

const terms = {
  version: 2 as const,
  subject: "service" as const,
  documentNameRu: "Поддержка",
  documentNameEn: "Support",
  sellerPolicyRevision: 1,
  billingPeriod: "month" as const,
  billingTimezone: "Europe/Moscow" as const,
  activationRule: "after_current" as const,
  serviceTerms: {
    cadence: "month" as const,
    includedMinutes: 180,
    carryover: "none" as const,
    excessPolicy: "external_approval" as const,
    scopeRu: "Поддержка",
    scopeEn: "Support",
    operatingHoursRu: null,
    operatingHoursEn: null,
    schedulingTermsRu: null,
    schedulingTermsEn: null,
  },
};

describe("commercial V4 snapshots", () => {
  it("accepts recurring service terms on offer and invoice lines", () => {
    const line = {
      kind: "service" as const,
      catalogVersionId: "21111111-1111-4111-8111-111111111111",
      nameRu: "Поддержка",
      nameEn: "Support",
      descriptionRu: null,
      descriptionEn: null,
      quantity: 1,
      unit: "month",
      agreedUnitPrice: "2000.00",
      vatRateBps: 2000,
      vatIncluded: true,
      priceOverrideReason: null,
      activationPolicy: null,
      commercialTerms: commercialLineTermsV4Schema.parse(terms),
    };
    const offer = { tenantId: "tenant-1", expiresAt: null, termsMarkdown: null, lines: [line] };
    expect(platformCommercialV4Contracts.offers.create.body.parse(offer).lines[0]).toMatchObject({
      commercialTerms: terms,
    });
    expect(platformCommercialV2Contracts.offers.create.body.safeParse(offer).success).toBe(false);
    const { priceOverrideReason: _priceOverrideReason, ...invoiceLine } = line;
    void _priceOverrideReason;
    expect(
      platformCommercialV4Contracts.invoices.create.body.parse({
        tenantId: "tenant-1",
        dueDate: null,
        applicationMode: "automatic",
        lines: [invoiceLine],
      }).lines[0],
    ).toMatchObject({ commercialTerms: terms });
    expect(platformOfferWorkspaceV4Contracts.workspace.response.safeParse).toBeTypeOf("function");
  });
});

import { describe, expect, it } from "vitest";

import type { CatalogVersionDto } from "../src/pages/catalog/api.js";
import { sourceOfferDraft } from "../src/pages/billing/sourceOfferDraft.js";

const catalogVersion = {
  id: "11111111-1111-4111-8111-111111111111",
  catalogItemId: "21111111-1111-4111-8111-111111111111",
  catalogItemCode: "plan-basic",
  kind: "plan",
  version: 3,
  status: "published",
  nameRu: "Базовый",
  nameEn: "Basic",
  descriptionRu: "Текущее описание",
  descriptionEn: "Current description",
  unit: "месяц",
  billingMode: "recurring",
  billingPeriod: "month",
  unitPrice: "120.00",
  vatRateBps: 2000,
  vatIncluded: true,
  publishedAt: "2026-08-01T00:00:00.000Z",
  publishedByPlatformUserId: "31111111-1111-4111-8111-111111111111",
  plan: {
    maxLines: null,
    maxStations: null,
    maxKiosks: null,
    maxCabinetUsers: null,
    labelEditorEnabled: false,
    publicApiEnabled: false,
    palletsEnabled: false,
    demoDurationDays: null,
  },
} satisfies CatalogVersionDto;

describe("sourceOfferDraft", () => {
  it("converts an agreed catalog snapshot into a literal custom invoice line", () => {
    const draft = sourceOfferDraft(
      {
        tenantId: "31111111-1111-4111-8111-111111111111",
        lines: [
          {
            id: "41111111-1111-4111-8111-111111111111",
            tenantId: "31111111-1111-4111-8111-111111111111",
            offerId: "51111111-1111-4111-8111-111111111111",
            position: 1,
            kind: "plan",
            catalogVersionId: catalogVersion.id,
            nameRu: "Согласованный тариф",
            nameEn: "Agreed plan",
            descriptionRu: "Особые условия",
            descriptionEn: "Special terms",
            quantity: 2,
            unit: "лицензия",
            catalogUnitPrice: "120.00",
            agreedUnitPrice: "49.50",
            priceOverrideReason: "Пилот",
            vatRate: null,
            vatIncluded: false,
            activationPolicy: "immediately",
            lineTotal: "99.00",
            createdAt: "2026-08-21T10:00:00.000Z",
          },
        ],
      },
      [catalogVersion],
    );

    expect(draft.lines).toEqual([
      expect.objectContaining({
        kind: "custom",
        catalogVersionId: null,
        nameRu: "Согласованный тариф",
        descriptionRu: "Особые условия",
        catalogUnitPrice: "120.00",
        agreedUnitPrice: "49.50",
        vatRateBps: null,
        vatIncluded: false,
      }),
    ]);
  });
});

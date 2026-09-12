import { describe, expect, it } from "vitest";

import type { CatalogVersionDto } from "../src/pages/catalog/api.js";
import { sourceOfferDraft } from "../src/pages/billing/sourceOfferDraft.js";
import { toInvoiceCreateInput } from "../src/pages/documents/documentDraft.js";

const catalogVersion = {
  id: "11111111-1111-4111-8111-111111111111",
  catalogItemId: "21111111-1111-4111-8111-111111111111",
  catalogItemCode: "plan-basic",
  documentNameRu: null,
  documentNameEn: null,
  subject: null,
  sellerPolicyRevision: null,
  lifecyclePolicyId: null,
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
    chzIntegrationEnabled: null,
    inventoryEnabled: null,
    commerceMlEnabled: null,
    handheldEnabled: null,
    demoDurationDays: null,
  },
} satisfies CatalogVersionDto;

describe("sourceOfferDraft", () => {
  it("preserves exact source text and maps legacy service and frozen addon intent to invoice representation", () => {
    const commercialTerms = {
      version: 1 as const,
      subject: "software_license" as const,
      documentNameRu: "Лицензия",
      documentNameEn: null,
      sellerPolicyRevision: 2,
      billingPeriod: "year" as const,
      billingTimezone: "Europe/Moscow" as const,
      activationRule: "after_current" as const,
    };
    const common = {
      id: "41111111-1111-4111-8111-111111111111",
      tenantId: "31111111-1111-4111-8111-111111111111",
      offerId: "51111111-1111-4111-8111-111111111111",
      position: 1,
      nameRu: "Лицензия",
      nameEn: "License",
      descriptionRu: "  Frozen text  ",
      descriptionEn: null,
      quantity: 2,
      unit: "year",
      catalogUnitPrice: null,
      agreedUnitPrice: "0.03",
      priceOverrideReason: null,
      vatRate: "20.00",
      vatIncluded: true,
      lineTotal: "0.06",
      createdAt: "2026-08-21T10:00:00.000Z",
    };
    const draft = sourceOfferDraft(
      {
        id: common.offerId,
        tenantId: common.tenantId,
        lines: [
          {
            ...common,
            kind: "addon",
            catalogVersionId: catalogVersion.id,
            activationPolicy: null,
            commercialTerms,
          },
          {
            ...common,
            id: "61111111-1111-4111-8111-111111111111",
            position: 2,
            kind: "service",
            catalogVersionId: null,
            activationPolicy: null,
            commercialTerms: null,
          },
        ],
      },
      [],
    );
    const input = toInvoiceCreateInput(draft);
    expect(input.lines[0]).toMatchObject({
      kind: "addon",
      quantity: 2,
      descriptionRu: "  Frozen text  ",
      activationPolicy: "after_current",
      commercialTerms,
    });
    expect(input.lines[1]).toMatchObject({
      kind: "custom",
      catalogVersionId: null,
      descriptionRu: "  Frozen text  ",
      activationPolicy: null,
    });
    expect(input.lines[1]).not.toHaveProperty("commercialTerms");
  });

  it("preserves the accepted offer and request provenance through invoice draft edits", () => {
    const offerId = "51111111-1111-4111-8111-111111111111";
    const requestId = "61111111-1111-4111-8111-111111111111";
    const draft = sourceOfferDraft(
      {
        id: offerId,
        tenantId: "31111111-1111-4111-8111-111111111111",
        sourceRequestId: requestId,
        lines: [
          {
            id: "41111111-1111-4111-8111-111111111111",
            tenantId: "31111111-1111-4111-8111-111111111111",
            offerId,
            position: 1,
            commercialTerms: null,
            kind: "plan",
            catalogVersionId: catalogVersion.id,
            nameRu: catalogVersion.nameRu,
            nameEn: catalogVersion.nameEn,
            descriptionRu: null,
            descriptionEn: null,
            quantity: 1,
            unit: catalogVersion.unit,
            catalogUnitPrice: catalogVersion.unitPrice,
            agreedUnitPrice: catalogVersion.unitPrice,
            priceOverrideReason: null,
            vatRate: "20.00",
            vatIncluded: true,
            activationPolicy: "immediately" as const,
            lineTotal: catalogVersion.unitPrice,
            createdAt: "2026-08-21T10:00:00.000Z",
          },
        ],
      },
      [catalogVersion],
    );

    expect(
      toInvoiceCreateInput({
        ...draft,
        date: "2026-09-30",
        lines: draft.lines.map((line) => ({ ...line, quantity: 2 })),
      }),
    ).toMatchObject({
      sourceOfferId: offerId,
      sourceRequestId: requestId,
      dueDate: "2026-09-30",
      lines: [{ quantity: 2 }],
    });
  });

  it("keeps direct invoice drafts free of source identifiers", () => {
    expect(
      toInvoiceCreateInput({
        tenantId: "31111111-1111-4111-8111-111111111111",
        applicationMode: "manual",
        date: "",
        lines: [],
      }),
    ).not.toHaveProperty("sourceOfferId");
  });

  it("keeps a catalog reference when only the operator comment differs", () => {
    const draft = sourceOfferDraft(
      {
        tenantId: "31111111-1111-4111-8111-111111111111",
        lines: [
          {
            id: "41111111-1111-4111-8111-111111111111",
            tenantId: "31111111-1111-4111-8111-111111111111",
            offerId: "51111111-1111-4111-8111-111111111111",
            position: 1,
            commercialTerms: null,
            kind: "plan",
            catalogVersionId: catalogVersion.id,
            nameRu: catalogVersion.nameRu,
            nameEn: catalogVersion.nameEn,
            descriptionRu: "Комментарий для конкретного клиента",
            descriptionEn: null,
            quantity: 1,
            unit: catalogVersion.unit,
            catalogUnitPrice: catalogVersion.unitPrice,
            agreedUnitPrice: catalogVersion.unitPrice,
            priceOverrideReason: null,
            vatRate: "20.00",
            vatIncluded: true,
            activationPolicy: "immediately" as const,
            lineTotal: catalogVersion.unitPrice,
            createdAt: "2026-08-21T10:00:00.000Z",
          },
        ],
      },
      [catalogVersion],
    );

    expect(draft.lines[0]).toMatchObject({
      kind: "plan",
      catalogVersionId: catalogVersion.id,
      descriptionRu: "Комментарий для конкретного клиента",
    });
  });

  it("preserves frozen catalog kind and reference when current catalog differs", () => {
    const draft = sourceOfferDraft(
      {
        tenantId: "31111111-1111-4111-8111-111111111111",
        lines: [
          {
            id: "41111111-1111-4111-8111-111111111111",
            tenantId: "31111111-1111-4111-8111-111111111111",
            offerId: "51111111-1111-4111-8111-111111111111",
            position: 1,
            commercialTerms: null,
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
            activationPolicy: "immediately" as const,
            lineTotal: "99.00",
            createdAt: "2026-08-21T10:00:00.000Z",
          },
        ],
      },
      [catalogVersion],
    );

    expect(draft.lines).toEqual([
      expect.objectContaining({
        kind: "plan",
        catalogVersionId: catalogVersion.id,
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

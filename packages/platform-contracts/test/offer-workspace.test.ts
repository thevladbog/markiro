import { describe, expect, it } from "vitest";

import {
  platformOfferWorkspaceContracts,
  platformOfferWorkspaceV2Contracts,
} from "../src/index.js";

const OFFER_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "tenant-offer-registry";
const FAMILY_ID = "21111111-1111-4111-8111-111111111111";

const draftOffer = {
  id: OFFER_ID,
  tenantId: TENANT_ID,
  familyId: FAMILY_ID,
  revision: 1,
  previousRevisionId: null,
  status: "draft",
  number: null,
  sellerBankAccountId: null,
  total: "120.00",
  expiresAt: null,
  termsMarkdown: null,
  publishedAt: null,
  publishedByPlatformUserId: null,
  paidAt: null,
  createdByPlatformUserId: "platform-accountant",
  createdAt: "2026-09-10T08:00:00.000Z",
  updatedAt: "2026-09-10T08:00:00.000Z",
} as const;

const line = {
  id: "31111111-1111-4111-8111-111111111111",
  tenantId: TENANT_ID,
  offerId: OFFER_ID,
  position: 1,
  kind: "service",
  catalogVersionId: null,
  nameRu: "Настройка",
  nameEn: "Setup",
  descriptionRu: null,
  descriptionEn: null,
  quantity: 1,
  unit: "услуга",
  catalogUnitPrice: null,
  agreedUnitPrice: "120.00",
  vatRate: null,
  vatIncluded: false,
  priceOverrideReason: null,
  activationPolicy: null,
  lineTotal: "120.00",
  createdAt: "2026-09-10T08:00:00.000Z",
} as const;

const sellerBankAccount = {
  id: "41111111-1111-4111-8111-111111111111",
  label: "Основной",
  settlementAccount: "40702810900000000001",
  bic: "044525225",
  bankName: "ПАО Банк",
  correspondentAccount: "30101810400000000225",
  currency: "RUB",
} as const;

describe("platform offer registry and workspace contracts", () => {
  it("defaults pagination while preserving literal search input", () => {
    expect(platformOfferWorkspaceContracts.registry.query.parse({})).toEqual({
      page: 1,
      limit: 25,
    });
    expect(
      platformOfferWorkspaceContracts.registry.query.parse({
        search: "%_ O'Reilly ",
        page: "2",
        limit: "50",
      }),
    ).toEqual({ search: "%_ O'Reilly ", page: 2, limit: 50 });
  });

  it("bounds page sizes, validates timestamps, orders the half-open interval, and rejects extras", () => {
    for (const query of [
      { limit: 26 },
      { limit: 0 },
      { limit: 101 },
      { page: 0 },
      { createdFrom: "2026-09-10" },
      { createdTo: "2026-09-10T10:00:00" },
      {
        createdFrom: "2026-09-11T00:00:00.000Z",
        createdTo: "2026-09-10T00:00:00.000Z",
      },
      { unexpected: true },
    ]) {
      expect(platformOfferWorkspaceContracts.registry.query.safeParse(query).success).toBe(false);
    }
    expect(
      platformOfferWorkspaceContracts.registry.query.safeParse({
        createdFrom: "2026-09-10T00:00:00.000Z",
        createdTo: "2026-09-10T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("accepts missing buyer profile data in a strict registry envelope", () => {
    const registry = platformOfferWorkspaceContracts.registry.response.parse({
      items: [
        {
          ...draftOffer,
          tenantName: "Factory",
          tenantSlug: "factory",
          buyerLegalName: null,
          buyerTaxId: null,
          lineSummary: ["Настройка", "Поддержка", "Интеграция"],
          lineCount: 4,
        },
      ],
      page: 1,
      limit: 25,
      total: 1,
    });

    expect(registry.items[0]).toMatchObject({
      buyerLegalName: null,
      buyerTaxId: null,
      lineSummary: ["Настройка", "Поддержка", "Интеграция"],
      lineCount: 4,
    });
    expect(
      platformOfferWorkspaceContracts.registry.response.safeParse({
        ...registry,
        privateSql: "must not leak",
      }).success,
    ).toBe(false);
  });

  it("reuses strict offer and document records in the workspace", () => {
    const workspace = {
      offer: { ...draftOffer, lines: [line] },
      tenant: { id: TENANT_ID, name: "Factory", slug: "factory" },
      parties: {
        seller: null,
        buyer: null,
        sellerBankAccount,
        buyerBankAccount: null,
      },
      revisions: [draftOffer],
      decision: null,
      documents: [],
      request: null,
      actions: {
        publish: false,
        cancel: false,
        revise: false,
        pay: false,
        createInvoice: false,
        addSignedVariant: false,
      },
    };

    expect(platformOfferWorkspaceContracts.workspace.response.parse(workspace)).toEqual(workspace);
    const current = {
      ...workspace,
      offer: {
        ...workspace.offer,
        lines: [
          {
            ...line,
            commercialTerms: {
              version: 1,
              subject: "service",
              documentNameRu: "Frozen service",
              documentNameEn: null,
              sellerPolicyRevision: 2,
              billingPeriod: null,
              billingTimezone: null,
              activationRule: null,
            },
          },
        ],
      },
    };
    expect(platformOfferWorkspaceV2Contracts.workspace.response.parse(current)).toEqual(current);
    expect(platformOfferWorkspaceContracts.workspace.response.safeParse(current).success).toBe(
      false,
    );
    expect(
      platformOfferWorkspaceV2Contracts.workspace.response.safeParse({
        ...current,
        privateKey: "hidden",
      }).success,
    ).toBe(false);

    expect(
      platformOfferWorkspaceContracts.workspace.response.safeParse({
        ...workspace,
        offer: { ...workspace.offer, objectKey: "private/offers/key" },
      }).success,
    ).toBe(false);
  });
});

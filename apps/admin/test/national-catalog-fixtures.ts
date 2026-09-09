import {
  catalogCapabilitiesSchema,
  importSessionSchema,
  importItemsResponseSchema,
} from "@markiro/platform-contracts";
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const sessionFixture = importSessionSchema.parse({
  id: id(1),
  revision: 0,
  mode: "own_catalog",
  state: "partial",
  loaded: 2,
  selected: 0,
  selectedItemIds: [],
  startedAt: "2026-09-09T00:00:00.000Z",
  throughAt: "2026-09-09T00:00:00.000Z",
  expiresAt: "2099-09-10T00:00:00.000Z",
  complete: false,
  reason: null,
});
export const capabilitiesFixture = catalogCapabilitiesSchema.parse({
  ownCatalog: true,
  gtinLookup: true,
  photos: true,
  connection: { state: "ready", reason: null },
  unavailableReason: { ownCatalog: null, gtinLookup: null, images: null },
});
export const itemsFixture = importItemsResponseSchema.parse({
  items: [
    {
      id: id(2),
      gtin14: "04006381333931",
      input: null,
      cardId: "card-1",
      name: "Молоко",
      brand: null,
      statusKeys: ["published"],
      selected: false,
      match: "new",
      productId: null,
      selectable: true,
      reason: null,
    },
  ],
  nextCursor: "page2",
});

import { importPrepareResponseSchema, importResultSchema } from "@markiro/platform-contracts";
export const previewFixture = importPrepareResponseSchema.parse({
  preparation: {
    id: id(10),
    requestId: id(11),
    state: "ready",
    total: 1,
    completed: 1,
    failures: [],
    nextRetryAt: null,
    reason: null,
    expiresAt: sessionFixture.expiresAt,
  },
  items: [
    {
      id: id(12),
      itemId: id(2),
      identity: { gtin14: "04006381333931", cardId: "card-1", name: "Молоко" },
      productId: null,
      expiresAt: sessionFixture.expiresAt,
      fields: [
        {
          id: id(13),
          label: "Название товара",
          labelKey: "name",
          before: null,
          after: "Молоко",
          applicable: true,
          reason: null,
          source: "national_catalog",
          selectedByDefault: true,
          requiresEntryIds: [],
        },
      ],
      photos: [],
      linkAction: "attach",
      categoryOptions: [],
      canApply: true,
      reason: null,
    },
  ],
});
export const resultFixture = importResultSchema.parse({
  operationId: id(20),
  state: "finished",
  items: [
    {
      previewId: id(12),
      productId: id(21),
      product: "applied",
      image: "failed",
      productReason: null,
      imageReason: "download_failed",
      reason: "download_failed",
    },
  ],
});

import { chzLinkDetailSchema } from "@markiro/platform-contracts";
import type { ProductDto } from "../src/pages/catalog/api.js";
export const linkFixture = chzLinkDetailSchema.parse({
  summary: {
    linkId: id(88),
    revision: 4,
    statusKeys: ["published"],
    rawStatus: "published",
    rawDetailedStatuses: [],
    lastSuccessAt: "2026-09-09T00:00:00.000Z",
    lastAttemptAt: "2026-09-09T00:00:00.000Z",
    refreshing: false,
    lastOutcome: "ok",
    hasChanges: false,
    lastErrorCode: null,
  },
  link: {
    id: id(88),
    revision: 4,
    cardId: "card-1",
    environment: "production",
    boundGtin14: "04006381333931",
    confirmedAt: "2026-09-08T00:00:00.000Z",
  },
});
export const productFixture: ProductDto = {
  id: id(99),
  gtin14: "04006381333931",
  name: "Молоко",
  productGroup: null,
  chzProductGroupCode: null,
  boxCapacity: null,
  palletCapacity: null,
  unitPrice: null,
  printName: null,
  egaisCode: null,
  shelfLifeDays: null,
  externalRef: null,
  status: "draft",
  archived: false,
  defaultCounterpartyId: null,
  createdAt: "2026-09-09T00:00:00.000Z",
};

/** Synthetic local normalized WebP; no provider/CDN bytes. */
export const photoFixtureBase64 =
  "UklGRtABAABXRUJQVlA4IMQBAACwDgCdASp4AHgAPm00mEckIyKhKhWZGIANiWcA1OTATP+ynyjg57xAWK6mrhcvK4uEOEJOeKcf68ccMaTvrvXuFK8HkwkvF9qI/5W9qQ4ziV0yXsdpwU1bSgSqpLThYrtGfCUP38EDWeNBmTKxkvTNs3vUY9k5uqRyhulTZIAA/vo8Ly0lehcyDUOF0mwMucDqrz8TB1AUgnCSKYyf6i0GiEISFpEah96xvzuKxlWPHGXpVerx9h049ZZZUPNCdLytMBUXTtqsdj3X2LIBRkGcpqUkQy8BR4bu61Q74IBFl2Q5EXUhYbNGgbBgkEzFdc/LtBHm+BUm7Io8DqEleiFF9NXysIZN3jIIrTXSlzWFjlq+s6fH/N/pvNfIPpzCGS/Vj1Mv0cYT+9r/c6bIj3/5SCP7A/cK/TnU34NI4hdSeP2/BIZUH6C+4mX08y/yPUxTadyZ/XrAVm1T4991HgkUgl1U6XqYApaTXt0I36QmwJL+RJATyfb6HuWUYvrnZu8sxmNLJAMk7H5haduYgcEiP3XoD0mwifGsmMRplQEM0d1W9m/o/xhYy1r6K++Nl3ErUqob73rOCKf7gdQ+afmAAAAAAA==";

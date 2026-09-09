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

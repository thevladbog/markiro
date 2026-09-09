import { describe, expect, it } from "vitest";

import {
  catalogCapabilitiesSchema,
  chzSummarySchema,
  IMPORT_GTIN_MAX_TOKENS,
  IMPORT_GTIN_TEXT_MAX_CHARS,
  importApplySchema,
  importDecisionSchema,
  importItemSchema,
  importItemsQuerySchema,
  importItemsResponseSchema,
  importPrepareResponseSchema,
  importPreparationRetrySchema,
  importPrepareSchema,
  importPreviewSchema,
  importResultSchema,
  importSelectionSchema,
  importSessionSchema,
  importStartSchema,
} from "../src/index.js";

const ID_1 = "00000000-0000-4000-8000-000000000001";
const ID_2 = "00000000-0000-4000-8000-000000000002";
const ID_3 = "00000000-0000-4000-8000-000000000003";
const UTC_DATE = "2026-09-08T12:30:00.000Z";

const ids = (count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      `00000000-0000-4000-8${String(index).padStart(3, "0")}-${String(index + 1).padStart(12, "0")}`,
  );

const validItem = {
  id: ID_1,
  gtin14: "04006381333931",
  input: "4006381333931",
  cardId: "provider-card-1",
  name: "Товар",
  brand: "Марка",
  statusKeys: ["published"],
  selected: true,
  match: "new",
  productId: null,
  selectable: true,
  reason: null,
} as const;

const validPreparation = {
  id: ID_1,
  requestId: ID_2,
  state: "ready",
  total: 1,
  completed: 1,
  failures: [],
  nextRetryAt: null,
  reason: null,
  expiresAt: UTC_DATE,
};

const validPreview = {
  id: ID_1,
  itemId: ID_2,
  productId: null,
  expiresAt: UTC_DATE,
  fields: [
    {
      id: ID_3,
      label: "Название",
      before: null,
      after: "Товар",
      applicable: true,
      reason: null,
      source: "national_catalog",
      selectedByDefault: true,
    },
  ],
  photos: [
    {
      candidateId: ID_3,
      previewPath: "/tenant/national-catalog/previews/3",
      state: "ready",
      primary: true,
      selectedByDefault: true,
      reason: null,
    },
  ],
  linkAction: "attach",
  categoryOptions: [{ optionId: ID_3, label: "Одежда", selected: true }],
  canApply: true,
  reason: null,
} as const;

describe("tenant National Catalog import input contracts", () => {
  it("accepts both start modes and rejects empty GTIN input and unknown fields", () => {
    expect(importStartSchema.safeParse({ mode: "own_catalog" }).success).toBe(true);
    expect(importStartSchema.safeParse({ mode: "gtins", text: "4006381333931" }).success).toBe(
      true,
    );
    expect(importStartSchema.safeParse({ mode: "gtins", text: " \n,;\t" }).success).toBe(false);
    expect(
      importStartSchema.safeParse({ mode: "own_catalog", environment: "sandbox" }).success,
    ).toBe(false);
  });

  it("enforces separate character and token limits for GTIN input", () => {
    expect(
      importStartSchema.safeParse({ mode: "gtins", text: "1".repeat(IMPORT_GTIN_TEXT_MAX_CHARS) })
        .success,
    ).toBe(true);

    const tooLong = importStartSchema.safeParse({
      mode: "gtins",
      text: "1".repeat(IMPORT_GTIN_TEXT_MAX_CHARS + 1),
    });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) {
      expect(tooLong.error.issues.map((issue) => issue.message)).toContain(
        "IMPORT_GTIN_TEXT_LIMIT_EXCEEDED",
      );
    }

    const atTokenLimit = Array.from({ length: IMPORT_GTIN_MAX_TOKENS }, () => "1").join(",");
    expect(importStartSchema.safeParse({ mode: "gtins", text: atTokenLimit }).success).toBe(true);
    const tooManyTokens = importStartSchema.safeParse({ mode: "gtins", text: `${atTokenLimit},1` });
    expect(tooManyTokens.success).toBe(false);
    if (!tooManyTokens.success) {
      expect(tooManyTokens.error.issues.map((issue) => issue.message)).toContain(
        "IMPORT_GTIN_TOKEN_LIMIT_EXCEEDED",
      );
    }
  });

  it("allows clearing selection and enforces unique selection limits", () => {
    expect(importSelectionSchema.safeParse({ expectedRevision: 0, itemIds: [] }).success).toBe(
      true,
    );
    expect(
      importSelectionSchema.safeParse({ expectedRevision: 1, itemIds: ids(100) }).success,
    ).toBe(true);
    expect(
      importSelectionSchema.safeParse({ expectedRevision: 1, itemIds: ids(101) }).success,
    ).toBe(false);
    expect(
      importSelectionSchema.safeParse({ expectedRevision: 1, itemIds: [ID_1, ID_1] }).success,
    ).toBe(false);
  });

  it("validates prepare limits, trimmed manual names, and one category choice per item", () => {
    expect(
      importPrepareSchema.parse({
        requestId: ID_3,
        itemIds: ids(100),
        manualNames: [{ itemId: ID_1, name: "  Товар  " }],
        categoryChoices: [],
      }).manualNames,
    ).toEqual([{ itemId: ID_1, name: "Товар" }]);
    expect(
      importPrepareSchema.safeParse({
        requestId: ID_3,
        itemIds: ids(101),
        manualNames: [],
        categoryChoices: [],
      }).success,
    ).toBe(false);
    expect(
      importPrepareSchema.safeParse({
        requestId: ID_3,
        itemIds: [ID_1],
        manualNames: [
          { itemId: ID_1, name: "Первый" },
          { itemId: ID_1, name: "Второй" },
        ],
        categoryChoices: [],
      }).success,
    ).toBe(false);
    expect(
      importPrepareSchema.safeParse({
        requestId: ID_3,
        itemIds: [ID_1],
        manualNames: [{ itemId: ID_1, name: ` ${"a".repeat(200)} ` }],
        categoryChoices: [],
      }).success,
    ).toBe(true);
    expect(
      importPrepareSchema.safeParse({
        requestId: ID_3,
        itemIds: [ID_1],
        manualNames: [{ itemId: ID_1, name: "a".repeat(201) }],
        categoryChoices: [],
      }).success,
    ).toBe(false);
    expect(
      importPrepareSchema.safeParse({
        requestId: ID_3,
        itemIds: [ID_1],
        manualNames: [{ itemId: ID_1, name: " ".repeat(3) }],
        categoryChoices: [],
      }).success,
    ).toBe(false);
    expect(
      importPrepareSchema.safeParse({
        requestId: ID_3,
        itemIds: [ID_1],
        manualNames: [],
        categoryChoices: [
          { itemId: ID_1, optionId: ID_2 },
          { itemId: ID_1, optionId: ID_3 },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a caller-controlled photo URL and duplicate accepted entry IDs", () => {
    expect(
      importDecisionSchema.safeParse({
        previewId: ID_1,
        acceptedEntryIds: [],
        linkAction: "attach",
        photo: { kind: "candidate", candidateId: ID_2, url: "https://attacker.example/photo" },
      }).success,
    ).toBe(false);
    expect(
      importDecisionSchema.safeParse({
        previewId: ID_1,
        acceptedEntryIds: [ID_2, ID_2],
        linkAction: "attach",
        photo: { kind: "keep" },
      }).success,
    ).toBe(false);
    expect(
      importDecisionSchema.safeParse({
        previewId: ID_1,
        acceptedEntryIds: ids(101),
        linkAction: "attach",
        photo: { kind: "keep" },
      }).success,
    ).toBe(true);
  });

  it("enforces 1-100 decisions and rejects repeated preview IDs", () => {
    const decision = (previewId: string) => ({
      previewId,
      acceptedEntryIds: [],
      linkAction: "attach" as const,
      photo: { kind: "keep" as const },
    });
    expect(importApplySchema.safeParse({ requestId: ID_1, decisions: [] }).success).toBe(false);
    expect(
      importApplySchema.safeParse({ requestId: ID_1, decisions: ids(100).map(decision) }).success,
    ).toBe(true);
    expect(
      importApplySchema.safeParse({ requestId: ID_1, decisions: ids(101).map(decision) }).success,
    ).toBe(false);
    expect(
      importApplySchema.safeParse({
        requestId: ID_1,
        decisions: [decision(ID_2), decision(ID_2)],
      }).success,
    ).toBe(false);
  });
});

describe("tenant National Catalog import output contracts", () => {
  it("validates normalized GTIN-14 values and strict item output", () => {
    expect(importItemSchema.safeParse(validItem).success).toBe(true);
    expect(importItemSchema.safeParse({ ...validItem, gtin14: "4006381333931" }).success).toBe(
      false,
    );
    expect(importItemSchema.safeParse({ ...validItem, gtin14: "04006381333930" }).success).toBe(
      false,
    );
    expect(importItemSchema.safeParse({ ...validItem, providerPayload: {} }).success).toBe(false);
  });

  it("accepts only UTC ISO timestamps in sessions, previews, and summaries", () => {
    const session = {
      id: ID_1,
      revision: 0,
      mode: "gtins",
      state: "ready",
      loaded: 1,
      selected: 1,
      selectedItemIds: [ID_1],
      startedAt: UTC_DATE,
      throughAt: UTC_DATE,
      expiresAt: UTC_DATE,
      complete: true,
      reason: null,
    } as const;
    expect(importSessionSchema.safeParse(session).success).toBe(true);
    expect(
      importSessionSchema.safeParse({ ...session, selectedItemIds: [ID_1, ID_1] }).success,
    ).toBe(false);
    expect(importSessionSchema.safeParse({ ...session, selectedItemIds: [] }).success).toBe(false);
    expect(
      importSessionSchema.safeParse({
        ...session,
        selected: 101,
        selectedItemIds: Array.from(
          { length: 101 },
          (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        ),
      }).success,
    ).toBe(false);
    expect(
      importSessionSchema.safeParse({ ...session, startedAt: "2026-09-08T15:30:00.000+03:00" })
        .success,
    ).toBe(false);
    expect(importPreviewSchema.safeParse(validPreview).success).toBe(true);
    expect(
      importPreviewSchema.safeParse({ ...validPreview, expiresAt: "2026-09-08 12:30:00" }).success,
    ).toBe(false);
    expect(
      chzSummarySchema.safeParse({
        linkId: ID_1,
        revision: 1,
        statusKeys: ["published"],
        rawStatus: "published",
        rawDetailedStatuses: [],
        lastSuccessAt: UTC_DATE,
        lastAttemptAt: null,
        refreshing: false,
        lastOutcome: "ok",
        hasChanges: false,
        lastErrorCode: null,
      }).success,
    ).toBe(true);
  });

  it("validates list, prepare, capability, query, and result envelopes deeply", () => {
    expect(
      importItemsResponseSchema.safeParse({ items: [validItem], nextCursor: null }).success,
    ).toBe(true);
    expect(
      importPrepareResponseSchema.safeParse({
        preparation: validPreparation,
        items: [validPreview],
      }).success,
    ).toBe(true);
    expect(
      importPrepareResponseSchema.safeParse({
        preparation: validPreparation,
        items: [{ ...validPreview, photos: [{ ...validPreview.photos[0], url: "https://x" }] }],
      }).success,
    ).toBe(false);
    expect(
      catalogCapabilitiesSchema.safeParse({
        ownCatalog: true,
        gtinLookup: true,
        photos: false,
        connection: { state: "ready", reason: null },
        unavailableReason: { ownCatalog: null, gtinLookup: null, images: "disabled" },
      }).success,
    ).toBe(true);
    expect(
      importItemsQuerySchema.safeParse({
        cursor: null,
        search: "рубашка",
        statuses: ["draft", "published"],
        includeArchived: false,
        limit: 100,
      }).success,
    ).toBe(true);
    expect(
      importResultSchema.safeParse({
        operationId: ID_1,
        state: "finished",
        items: [
          {
            previewId: ID_2,
            productId: ID_3,
            product: "applied",
            image: "unchanged",
            productReason: null,
            imageReason: null,
            reason: null,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      importResultSchema.safeParse({
        operationId: ID_1,
        state: "finished",
        items: [
          {
            previewId: ID_2,
            productId: ID_3,
            product: "applied",
            image: "unchanged",
            productReason: null,
            imageReason: null,
            reason: null,
            raw: {},
          },
        ],
      }).success,
    ).toBe(false);
  });
});

it("bounds session list queries before SQL", () => {
  const query = { cursor: null, search: "", statuses: [], includeArchived: false, limit: 100 };
  expect(importItemsQuerySchema.safeParse(query).success).toBe(true);
  expect(importItemsQuerySchema.safeParse({ ...query, limit: 101 }).success).toBe(false);
  expect(importItemsQuerySchema.safeParse({ ...query, search: "x".repeat(500) }).success).toBe(
    true,
  );
  expect(importItemsQuerySchema.safeParse({ ...query, search: "x".repeat(501) }).success).toBe(
    false,
  );
});

it("requires durable request identity and safe preparation/photo state", () => {
  expect(
    importPrepareSchema.safeParse({ itemIds: [ID_1], manualNames: [], categoryChoices: [] })
      .success,
  ).toBe(false);
  expect(
    importPrepareResponseSchema.safeParse({
      preparation: {
        ...validPreparation,
        state: "partial",
        completed: 0,
        failures: [{ itemId: ID_2, reason: "not_found", retryable: false }],
      },
      items: [],
    }).success,
  ).toBe(true);
  expect(
    importPrepareResponseSchema.safeParse({
      preparation: { ...validPreparation, requestHash: "secret" },
      items: [],
    }).success,
  ).toBe(false);
  expect(
    importPreviewSchema.safeParse({
      ...validPreview,
      photos: [
        {
          ...validPreview.photos[0],
          state: "failed",
          previewPath: null,
          reason: "invalid_barcode",
          selectedByDefault: false,
        },
      ],
    }).success,
  ).toBe(true);
  expect(
    importPreviewSchema.safeParse({
      ...validPreview,
      photos: [{ ...validPreview.photos[0], reason: "https://secret" }],
    }).success,
  ).toBe(false);
});

it("accepts only an explicit empty retry command", () => {
  expect(importPreparationRetrySchema.safeParse({}).success).toBe(true);
  expect(importPreparationRetrySchema.safeParse({ attempt: 0 }).success).toBe(false);
});

it("separates product and photo reasons without exposing actor or raw provider data in link detail", async () => {
  const { chzLinkDetailSchema } = await import("../src/tenant-national-catalog.js");
  const summary = {
    linkId: ID_1,
    revision: 1,
    statusKeys: ["published"],
    rawStatus: "published",
    rawDetailedStatuses: [],
    lastSuccessAt: UTC_DATE,
    lastAttemptAt: UTC_DATE,
    refreshing: false,
    lastOutcome: "ok",
    hasChanges: false,
    lastErrorCode: null,
  };
  const link = {
    id: ID_1,
    revision: 1,
    cardId: "720679",
    environment: "sandbox",
    boundGtin14: "04006381333931",
    confirmedAt: UTC_DATE,
  };
  expect(chzLinkDetailSchema.safeParse({ summary, link }).success).toBe(true);
  expect(
    chzLinkDetailSchema.safeParse({ summary, link: { ...link, confirmedBy: ID_2 } }).success,
  ).toBe(false);
  const result = {
    operationId: ID_1,
    state: "finished",
    items: [
      {
        previewId: ID_2,
        productId: ID_3,
        product: "applied",
        image: "failed",
        reason: "image_conflict",
        productReason: null,
        imageReason: "image_conflict",
      },
    ],
  };
  expect(importResultSchema.safeParse(result).success).toBe(true);
});

it("records an explicitly reviewed kept alternative without changing old keep decisions", () => {
  const old = {
    previewId: ID_1,
    acceptedEntryIds: [],
    linkAction: "attach",
    photo: { kind: "keep" },
  };
  expect(importDecisionSchema.parse(old)).toEqual(old);
  expect(
    importDecisionSchema.parse({ ...old, photo: { kind: "keep", reviewedCandidateId: ID_2 } })
      .photo,
  ).toEqual({ kind: "keep", reviewedCandidateId: ID_2 });
});

it("allows only safe compact refresh reasons", () => {
  const base = {
    linkId: ID_1,
    revision: 1,
    statusKeys: [],
    rawStatus: null,
    rawDetailedStatuses: [],
    lastSuccessAt: null,
    lastAttemptAt: null,
    refreshing: false,
    lastOutcome: "error",
    hasChanges: false,
    lastErrorCode: "card_lost_gtin",
  };
  expect(chzSummarySchema.safeParse(base).success).toBe(true);
  expect(
    chzSummarySchema.safeParse({ ...base, lastErrorCode: "https://private.example/token" }).success,
  ).toBe(false);
});

it("requires safe coherent capability connection and refusal reasons", () => {
  const valid = {
    ownCatalog: false,
    gtinLookup: false,
    photos: false,
    connection: { state: "missing", reason: "integration_missing" },
    unavailableReason: {
      ownCatalog: "disabled",
      gtinLookup: "connection_unavailable",
      images: "connection_unavailable",
    },
  };
  expect(catalogCapabilitiesSchema.safeParse(valid).success).toBe(true);
  for (const connection of [
    { state: "ready", reason: "token_unavailable" },
    { state: "missing", reason: null },
    { state: "blocked", reason: "integration_disabled" },
    { state: "ready", reason: null, url: "https://secret.invalid" },
  ])
    expect(catalogCapabilitiesSchema.safeParse({ ...valid, connection }).success).toBe(false);
  expect(catalogCapabilitiesSchema.safeParse({ ...valid, ownCatalog: true }).success).toBe(false);
});

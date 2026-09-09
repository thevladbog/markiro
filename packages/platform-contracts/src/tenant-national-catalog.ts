import { z } from "zod";

import { isValidGtin } from "@markiro/domain";

import { platformUuidSchema } from "./primitives.js";

export const IMPORT_GTIN_TEXT_MAX_CHARS = 1_500_000;
export const IMPORT_GTIN_MAX_TOKENS = 100_000;

const MAX_APPLY_ITEMS = 100;

function countImportTokens(text: string): number {
  const importTokenPattern = /[^\s,;]+/gu;
  let count = 0;
  while (importTokenPattern.exec(text) !== null) {
    count += 1;
    if (count > IMPORT_GTIN_MAX_TOKENS) break;
  }
  return count;
}

function addDuplicateIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: "Values must be unique" });
  }
}

const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nullableReasonSchema = z.string().min(1).nullable();
const utcDateTimeSchema = z.iso.datetime();
const normalizedGtin14Schema = z
  .string()
  .regex(/^\d{14}$/u)
  .refine(isValidGtin, { message: "Invalid GTIN-14 check digit" });

export const catalogEnvironmentSchema = z.enum(["production", "sandbox"]);
export type CatalogEnvironment = z.infer<typeof catalogEnvironmentSchema>;

export const chzStatusKeySchema = z.enum([
  "draft",
  "moderation",
  "errors",
  "unsigned",
  "published",
  "archived",
  "unknown",
]);
export type ChzStatusKey = z.infer<typeof chzStatusKeySchema>;

const ownCatalogStartSchema = z.object({ mode: z.literal("own_catalog") }).strict();
const gtinStartSchema = z
  .object({ mode: z.literal("gtins"), text: z.string() })
  .strict()
  .superRefine((value, context) => {
    if (value.text.length > IMPORT_GTIN_TEXT_MAX_CHARS) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "IMPORT_GTIN_TEXT_LIMIT_EXCEEDED",
      });
      return;
    }

    const tokenCount = countImportTokens(value.text);
    if (tokenCount === 0) {
      context.addIssue({ code: "custom", path: ["text"], message: "GTIN input is empty" });
    } else if (tokenCount > IMPORT_GTIN_MAX_TOKENS) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "IMPORT_GTIN_TOKEN_LIMIT_EXCEEDED",
      });
    }
  });

export const importStartSchema = z.union([ownCatalogStartSchema, gtinStartSchema]);
export type ImportStart = z.infer<typeof importStartSchema>;

export const importSessionStateSchema = z.enum([
  "queued",
  "loading",
  "ready",
  "partial",
  "blocked",
  "cancelled",
  "expired",
]);
export type ImportSessionState = z.infer<typeof importSessionStateSchema>;

export const importSessionSchema = z
  .object({
    id: platformUuidSchema,
    revision: nonNegativeIntegerSchema,
    mode: z.enum(["own_catalog", "gtins"]),
    state: importSessionStateSchema,
    loaded: nonNegativeIntegerSchema,
    selected: nonNegativeIntegerSchema.max(MAX_APPLY_ITEMS),
    selectedItemIds: z.array(platformUuidSchema).max(MAX_APPLY_ITEMS),
    startedAt: utcDateTimeSchema,
    throughAt: utcDateTimeSchema,
    expiresAt: utcDateTimeSchema,
    complete: z.boolean(),
    reason: nullableReasonSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.selectedItemIds, context, ["selectedItemIds"]);
    if (value.selected !== value.selectedItemIds.length)
      context.addIssue({
        code: "custom",
        path: ["selectedItemIds"],
        message: "Selection count does not match item IDs",
      });
  });
export type ImportSession = z.infer<typeof importSessionSchema>;

export const importItemSchema = z
  .object({
    id: platformUuidSchema,
    gtin14: normalizedGtin14Schema.nullable(),
    input: z.string().nullable(),
    cardId: z.string().nullable(),
    name: z.string().nullable(),
    brand: z.string().nullable(),
    statusKeys: z.array(chzStatusKeySchema),
    selected: z.boolean(),
    match: z.enum([
      "new",
      "existing",
      "linked",
      "other_link",
      "archived_local",
      "ambiguous",
      "invalid",
      "inaccessible",
      "not_found",
    ]),
    productId: platformUuidSchema.nullable(),
    selectable: z.boolean(),
    reason: nullableReasonSchema,
  })
  .strict();
export type ImportItem = z.infer<typeof importItemSchema>;

export const importSelectionSchema = z
  .object({
    expectedRevision: nonNegativeIntegerSchema,
    itemIds: z.array(platformUuidSchema).max(MAX_APPLY_ITEMS),
  })
  .strict()
  .superRefine((value, context) => addDuplicateIssue(value.itemIds, context, ["itemIds"]));
export type ImportSelection = z.infer<typeof importSelectionSchema>;

const manualNameSchema = z
  .object({ itemId: platformUuidSchema, name: z.string().trim().min(1).max(200) })
  .strict();
const categoryChoiceSchema = z
  .object({ itemId: platformUuidSchema, optionId: platformUuidSchema })
  .strict();

export const importPrepareSchema = z
  .object({
    requestId: platformUuidSchema,
    itemIds: z.array(platformUuidSchema).min(1).max(MAX_APPLY_ITEMS),
    manualNames: z.array(manualNameSchema).max(MAX_APPLY_ITEMS),
    categoryChoices: z.array(categoryChoiceSchema).max(MAX_APPLY_ITEMS),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.itemIds, context, ["itemIds"]);
    for (const choice of [...value.manualNames, ...value.categoryChoices]) {
      if (!value.itemIds.includes(choice.itemId))
        context.addIssue({ code: "custom", message: "Choice item is not requested" });
    }
    addDuplicateIssue(
      value.manualNames.map(({ itemId }) => itemId),
      context,
      ["manualNames"],
    );
    addDuplicateIssue(
      value.categoryChoices.map(({ itemId }) => itemId),
      context,
      ["categoryChoices"],
    );
  });
export type ImportPrepare = z.infer<typeof importPrepareSchema>;

const importFieldSchema = z
  .object({
    id: platformUuidSchema,
    label: z.string(),
    before: z.string().nullable(),
    after: z.string().nullable(),
    applicable: z.boolean(),
    reason: nullableReasonSchema,
    source: z.enum(["national_catalog", "manual"]),
    selectedByDefault: z.boolean(),
    requiresEntryIds: z.array(platformUuidSchema),
  })
  .strict();
export type ImportField = z.infer<typeof importFieldSchema>;

export const importPhotoReasonSchema = z.enum([
  "invalid_collection",
  "invalid_record",
  "invalid_url",
  "invalid_barcode",
  "unsupported_media",
  "barcode_mismatch",
  "download_failed",
  "image_conflict",
  "image_unavailable",
]);

export const importPhotoSchema = z
  .object({
    candidateId: platformUuidSchema,
    previewPath: z.string().nullable(),
    state: z.enum(["pending", "ready", "failed"]),
    primary: z.boolean(),
    selectedByDefault: z.boolean(),
    reason: importPhotoReasonSchema.nullable(),
  })
  .strict();
export type ImportPhoto = z.infer<typeof importPhotoSchema>;

const categoryOptionSchema = z
  .object({ optionId: platformUuidSchema, label: z.string(), selected: z.boolean() })
  .strict();

const importFieldsSchema = z.array(importFieldSchema).superRefine((fields, context) => {
  addDuplicateIssue(
    fields.map((field) => field.id),
    context,
    [],
  );
  const ids = new Set(fields.map((field) => field.id));
  fields.forEach((field, index) => {
    addDuplicateIssue(field.requiresEntryIds, context, [index, "requiresEntryIds"]);
    if (field.requiresEntryIds.some((id) => id === field.id || !ids.has(id)))
      context.addIssue({
        code: "custom",
        path: [index, "requiresEntryIds"],
        message: "Prerequisite must reference another field in this preview",
      });
  });
});

export const importPreviewSchema = z
  .object({
    id: platformUuidSchema,
    itemId: platformUuidSchema,
    identity: z
      .object({
        gtin14: normalizedGtin14Schema,
        cardId: z.string().min(1),
        name: z.string().nullable(),
      })
      .strict(),
    productId: platformUuidSchema.nullable(),
    expiresAt: utcDateTimeSchema,
    fields: importFieldsSchema,
    photos: z.array(importPhotoSchema),
    linkAction: z.enum(["attach", "keep", "replace"]),
    categoryOptions: z.array(categoryOptionSchema),
    canApply: z.boolean(),
    reason: nullableReasonSchema,
  })
  .strict();
export type ImportPreview = z.infer<typeof importPreviewSchema>;

const keepPhotoDecisionSchema = z
  .object({ kind: z.literal("keep"), reviewedCandidateId: z.uuid().optional() })
  .strict();
const candidatePhotoDecisionSchema = z
  .object({ kind: z.literal("candidate"), candidateId: platformUuidSchema })
  .strict();

export const importDecisionSchema = z
  .object({
    previewId: platformUuidSchema,
    acceptedEntryIds: z.array(platformUuidSchema),
    linkAction: z.enum(["attach", "keep", "replace"]),
    photo: z.discriminatedUnion("kind", [keepPhotoDecisionSchema, candidatePhotoDecisionSchema]),
  })
  .strict()
  .superRefine((value, context) =>
    addDuplicateIssue(value.acceptedEntryIds, context, ["acceptedEntryIds"]),
  );
export type ImportDecision = z.infer<typeof importDecisionSchema>;

export const importApplySchema = z
  .object({
    requestId: platformUuidSchema,
    decisions: z.array(importDecisionSchema).min(1).max(MAX_APPLY_ITEMS),
  })
  .strict()
  .superRefine((value, context) =>
    addDuplicateIssue(
      value.decisions.map(({ previewId }) => previewId),
      context,
      ["decisions"],
    ),
  );
export type ImportApply = z.infer<typeof importApplySchema>;

const importResultItemSchema = z
  .object({
    previewId: platformUuidSchema,
    productId: platformUuidSchema.nullable(),
    product: z.enum(["pending", "applied", "conflict", "failed", "cancelled"]),
    image: z.enum(["none", "pending", "applied", "unchanged", "failed"]),
    productReason: nullableReasonSchema,
    imageReason: nullableReasonSchema,
    reason: nullableReasonSchema,
  })
  .strict();

export const importApplyConflictSchema = z
  .object({
    statusCode: z.literal(409),
    error: z.literal("Conflict"),
    message: z.enum(["preview_expired", "environment_mismatch"]),
    previewIds: z.array(platformUuidSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => addDuplicateIssue(value.previewIds, context, ["previewIds"]));
export type ImportApplyConflict = z.infer<typeof importApplyConflictSchema>;

export const importResultSchema = z
  .object({
    operationId: platformUuidSchema,
    state: z.enum(["pending", "running", "finished", "cancelled"]),
    items: z.array(importResultItemSchema),
  })
  .strict();
export type ImportResult = z.infer<typeof importResultSchema>;

export const chzRefreshErrorCodeSchema = z.enum([
  "access_changed",
  "integration_unconfigured",
  "environment_mismatch",
  "refresh_disabled",
  "local_gtin_changed",
  "card_lost_gtin",
  "card_unavailable",
  "photo_unavailable",
  "request_failed",
  "request_timeout",
  "retry_exhausted",
  "quota_wait",
  "lease_busy",
  "token_unavailable",
  "provider_unavailable",
]);
export const chzSummarySchema = z
  .object({
    linkId: platformUuidSchema.nullable(),
    revision: nonNegativeIntegerSchema.nullable(),
    statusKeys: z.array(chzStatusKeySchema),
    rawStatus: z.string().nullable(),
    rawDetailedStatuses: z.array(z.string()),
    lastSuccessAt: utcDateTimeSchema.nullable(),
    lastAttemptAt: utcDateTimeSchema.nullable(),
    refreshing: z.boolean(),
    lastOutcome: z.enum(["ok", "error", "never"]),
    hasChanges: z.boolean(),
    lastErrorCode: chzRefreshErrorCodeSchema.nullable(),
  })
  .strict();
export type ChzSummary = z.infer<typeof chzSummarySchema>;

export const catalogConnectionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), reason: z.null() }).strict(),
  z.object({ state: z.literal("missing"), reason: z.literal("integration_missing") }).strict(),
  z
    .object({
      state: z.literal("blocked"),
      reason: z.enum(["integration_unavailable", "provider_unconfigured", "token_unavailable"]),
    })
    .strict(),
]);
const catalogUnavailableReasonSchema = z
  .enum(["disabled", "connection_unavailable", "image_policy_unavailable"])
  .nullable();
export const catalogCapabilitiesSchema = z
  .object({
    ownCatalog: z.boolean(),
    gtinLookup: z.boolean(),
    photos: z.boolean(),
    connection: catalogConnectionSchema,
    unavailableReason: z
      .object({
        ownCatalog: catalogUnavailableReasonSchema,
        gtinLookup: catalogUnavailableReasonSchema,
        images: catalogUnavailableReasonSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.unavailableReason.ownCatalog === "image_policy_unavailable" ||
      value.unavailableReason.gtinLookup === "image_policy_unavailable"
    )
      ctx.addIssue({ code: "custom", message: "Image policy only governs images" });
    for (const [enabled, reason] of [
      [value.ownCatalog, value.unavailableReason.ownCatalog],
      [value.gtinLookup, value.unavailableReason.gtinLookup],
      [value.photos, value.unavailableReason.images],
    ]) {
      if (
        enabled !== (reason === null) ||
        (enabled && value.connection.state !== "ready") ||
        (reason === "connection_unavailable" && value.connection.state === "ready") ||
        (reason === "image_policy_unavailable" && value.connection.state !== "ready")
      )
        ctx.addIssue({ code: "custom", message: "Capability and availability reason disagree" });
    }
  });
export type CatalogCapabilities = z.infer<typeof catalogCapabilitiesSchema>;

export const importItemsQuerySchema = z
  .object({
    cursor: z.string().nullable(),
    search: z.string().max(500),
    statuses: z.array(chzStatusKeySchema),
    includeArchived: z.boolean(),
    limit: z.number().int().min(1).max(MAX_APPLY_ITEMS),
  })
  .strict();
export type ImportItemsQuery = z.infer<typeof importItemsQuerySchema>;

export const importItemsResponseSchema = z
  .object({ items: z.array(importItemSchema), nextCursor: z.string().nullable() })
  .strict();
export type ImportItemsResponse = z.infer<typeof importItemsResponseSchema>;

export const importPreparationSchema = z
  .object({
    id: platformUuidSchema,
    requestId: platformUuidSchema,
    state: z.enum(["queued", "loading", "ready", "partial", "blocked", "failed"]),
    total: z.number().int().min(1).max(MAX_APPLY_ITEMS),
    completed: z.number().int().min(0).max(MAX_APPLY_ITEMS),
    failures: z
      .array(
        z
          .object({
            itemId: platformUuidSchema,
            reason: nullableReasonSchema.unwrap(),
            retryable: z.boolean(),
          })
          .strict(),
      )
      .max(MAX_APPLY_ITEMS),
    nextRetryAt: utcDateTimeSchema.nullable(),
    reason: nullableReasonSchema,
    expiresAt: utcDateTimeSchema,
  })
  .strict();
export type ImportPreparation = z.infer<typeof importPreparationSchema>;
export const importPreparationRetrySchema = z.object({}).strict();

export const importPrepareResponseSchema = z
  .object({
    preparation: importPreparationSchema,
    items: z.array(importPreviewSchema).max(MAX_APPLY_ITEMS),
  })
  .strict();
export type ImportPrepareResponse = z.infer<typeof importPrepareResponseSchema>;

export const chzLinkDetailSchema = z
  .object({
    summary: chzSummarySchema,
    link: z
      .object({
        id: platformUuidSchema,
        revision: nonNegativeIntegerSchema,
        cardId: z.string().min(1),
        environment: catalogEnvironmentSchema,
        boundGtin14: normalizedGtin14Schema,
        confirmedAt: utcDateTimeSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ChzLinkDetail = z.infer<typeof chzLinkDetailSchema>;

export const importSessionRetrySchema = z.object({}).strict();
export const importApplyRetrySchema = z
  .object({
    previewIds: z
      .array(platformUuidSchema)
      .min(1)
      .max(MAX_APPLY_ITEMS)
      .refine((values) => new Set(values).size === values.length, "Duplicate preview IDs"),
  })
  .strict();
export const chzLinkChangeSchema = z
  .object({ action: z.literal("remove"), expectedRevision: nonNegativeIntegerSchema })
  .strict();

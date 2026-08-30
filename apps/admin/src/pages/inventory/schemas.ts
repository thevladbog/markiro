import { z } from "zod";

import {
  INVENTORY_DOCUMENT_MIME_TYPE_PATTERN,
  INVENTORY_DOCUMENT_SOURCE_CATEGORIES,
  parseLabelTemplate,
} from "@markiro/domain";

export const INVENTORY_CHZ_STATUSES = [
  "EMITTED",
  "INTRODUCED",
  "APPLIED",
  "RETIRED",
  "WRITTEN_OFF",
  "DISAGGREGATION",
] as const;
export type InventoryChzStatus = (typeof INVENTORY_CHZ_STATUSES)[number];

export const inventoryModeSchema = z.enum(["check", "repack"]);
export type InventoryMode = z.infer<typeof inventoryModeSchema>;
export const inventoryStatusSchema = z.enum([
  "draft",
  "preparing",
  "ready",
  "cancelled",
  "running",
  "closed",
  "completed",
]);
export type InventoryStatus = z.infer<typeof inventoryStatusSchema>;

const uuid = z.string().uuid();
const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1 || year > 9999) return false;
    const parsed = new Date(0);
    parsed.setUTCFullYear(year, month - 1, day);
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  });
const dateTime = z.iso.datetime();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const nonnegativeInteger = z.number().int().nonnegative();

const labelTemplateSchema = z.strictObject({ id: uuid, name: z.string() });

interface InventoryResponseSemantics {
  mode: "check" | "repack";
  productionDateFrom: string;
  productionDateTo: string;
  boxLabelTemplateId: string | null;
  boxLabelTemplate: { id: string; name: string } | null;
}

function validateInventoryResponseSemantics(
  value: InventoryResponseSemantics,
  context: z.RefinementCtx,
): void {
  if (value.productionDateFrom > value.productionDateTo) {
    context.addIssue({
      code: "custom",
      path: ["productionDateTo"],
      message: "production date range is inverted",
    });
  }
  if (
    (value.mode === "repack" &&
      (value.boxLabelTemplateId === null || value.boxLabelTemplate === null)) ||
    (value.mode === "check" &&
      (value.boxLabelTemplateId !== null || value.boxLabelTemplate !== null))
  ) {
    context.addIssue({
      code: "custom",
      path: ["boxLabelTemplate"],
      message: "mode and box label template are inconsistent",
    });
  }
  if (value.boxLabelTemplate !== null && value.boxLabelTemplate.id !== value.boxLabelTemplateId) {
    context.addIssue({
      code: "custom",
      path: ["boxLabelTemplate", "id"],
      message: "box label template descriptor id does not match",
    });
  }
}

export const inventorySchema = z
  .strictObject({
    id: uuid,
    number: z.string().min(1),
    status: inventoryStatusSchema,
    mode: inventoryModeSchema,
    productId: uuid,
    gtin14: z.string().regex(/^[0-9]{14}$/),
    productName: z.string(),
    lineId: uuid,
    lineName: z.string(),
    productionDateFrom: civilDate,
    productionDateTo: civilDate,
    boxLabelTemplateId: uuid.nullable(),
    boxLabelTemplate: labelTemplateSchema.nullable(),
    activeSnapshotId: uuid.nullable(),
    resultRevision: nonnegativeInteger,
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .superRefine(validateInventoryResponseSemantics);

const importDiagnosticSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  rowNumber: z.number().int().positive().optional(),
});

export const inventoryImportSchema = z.strictObject({
  id: uuid,
  declaredStatus: z.enum(INVENTORY_CHZ_STATUSES),
  parsedStatus: z.enum(INVENTORY_CHZ_STATUSES).nullable(),
  result: z.enum(["succeeded", "failed"]),
  rowCount: nonnegativeInteger,
  errorCount: nonnegativeInteger,
  duplicateCount: nonnegativeInteger,
  sha256: digest,
  diagnostics: z.array(importDiagnosticSchema),
});

export const inventoryImportHistorySchema = inventoryImportSchema.extend({
  fileName: z.string().min(1),
  createdAt: dateTime,
});

export const inventorySnapshotInputsSchema = z.strictObject({
  EMITTED: uuid,
  INTRODUCED: uuid,
  APPLIED: uuid,
  RETIRED: uuid,
  WRITTEN_OFF: uuid,
  DISAGGREGATION: uuid,
});

export const inventorySnapshotCountsSchema = z.strictObject({
  emitted: nonnegativeInteger,
  introduced: nonnegativeInteger,
  applied: nonnegativeInteger,
  retired: nonnegativeInteger,
  writtenOff: nonnegativeInteger,
  disaggregation: nonnegativeInteger,
  protected: nonnegativeInteger,
  expected: nonnegativeInteger,
  packages: nonnegativeInteger,
  loose: nonnegativeInteger,
});

export const inventorySnapshotSchema = z.strictObject({
  id: uuid,
  inventoryId: uuid,
  revision: z.number().int().positive(),
  combinedDigest: digest,
  fixedAt: dateTime,
  inputs: inventorySnapshotInputsSchema,
  counts: inventorySnapshotCountsSchema,
});

const labelTemplateSpecSchema = z.unknown().transform((value, context) => {
  try {
    return parseLabelTemplate(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid label template spec" });
    return z.NEVER;
  }
});

export const stationInventoryManifestSchema = z
  .strictObject({
    inventoryId: uuid,
    inventoryNumber: z.string().min(1),
    snapshotId: uuid,
    snapshotRevision: z.literal(1),
    snapshotFixedAt: dateTime,
    combinedDigest: digest,
    contentDigest: digest,
    codeCount: nonnegativeInteger,
    productId: uuid,
    productName: z.string(),
    productPrintName: z.string().min(1).nullable(),
    egaisCode: z.string().min(1).nullable(),
    shelfLifeDays: z.number().int().positive().nullable(),
    gtin14: z.string().regex(/^[0-9]{14}$/),
    boxCapacity: z.number().int().positive(),
    mode: inventoryModeSchema,
    lineId: uuid,
    lineName: z.string(),
    productionDateFrom: civilDate,
    productionDateTo: civilDate,
    boxLabelTemplate: z
      .strictObject({ id: uuid, name: z.string(), spec: labelTemplateSpecSchema })
      .nullable(),
    limits: z.strictObject({
      codePageSize: z.literal(200),
      eventBatchSize: z.literal(100),
      progressPageSize: z.literal(200),
    }),
  })
  .superRefine((manifest, context) => {
    if (manifest.productionDateFrom > manifest.productionDateTo) {
      context.addIssue({
        code: "custom",
        path: ["productionDateTo"],
        message: "production date range is inverted",
      });
    }
    if (
      (manifest.mode === "check" && manifest.boxLabelTemplate !== null) ||
      (manifest.mode === "repack" && manifest.boxLabelTemplate === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["boxLabelTemplate"],
        message: "mode and box label template are inconsistent",
      });
    }
  });

const blockersSchema = z.strictObject({
  activeParticipantCount: nonnegativeInteger,
  pendingEventCount: nonnegativeInteger,
  participantOpenBoxCount: nonnegativeInteger,
  openRepackBoxCount: nonnegativeInteger,
  unresolvedPrintBoxCount: nonnegativeInteger,
});

export const inventoryDetailSchema = inventorySchema.safeExtend({
  blockers: blockersSchema,
  imports: z.array(inventoryImportHistorySchema),
  activeSnapshot: inventorySnapshotSchema.nullable(),
});

export const listInventoriesSchema = z.strictObject({ items: z.array(inventorySchema) });

export const CHZ_EXPORT_PREFLIGHT_CODES = [
  "INN_MISSING",
  "PRODUCT_GROUP_MISSING",
  "AGENT_NOT_PAIRED",
  "TOKEN_UNAVAILABLE",
] as const;
export type ChzExportPreflightCode = (typeof CHZ_EXPORT_PREFLIGHT_CODES)[number];

export const CHZ_EXPORT_RUN_STATES = ["queued", "ordered", "ready", "imported", "failed"] as const;
export type ChzExportRunState = (typeof CHZ_EXPORT_RUN_STATES)[number];

/**
 * Mirrors `CHZ_EXPORT_SAFE_ERROR_CODES` in
 * apps/api/src/modules/chz-exports/chz-export-runner.service.ts: the closed
 * set of `errorCode` values the runner writes that carry no ЧЗ-specific text,
 * so each one gets its own operator-facing copy under
 * `pages.inventory.chzExports.error.*` instead of falling back to the raw
 * code. Anything outside this set is an open-ended parser diagnostic code and
 * keeps using `errorCodeFallback`.
 */
export const CHZ_EXPORT_SAFE_ERROR_CODES = [
  "CHZ_TOKEN_UNAVAILABLE",
  "CHZ_ORDER_CONTEXT_MISSING",
  "CHZ_TASK_REJECTED",
  "CHZ_TASK_FAILED",
  "CHZ_TASK_TIMED_OUT",
  "CHZ_CREATE_ATTEMPTS_EXHAUSTED",
  "CHZ_DOWNLOAD_REJECTED",
  "CHZ_IMPORT_FAILED",
  "CHZ_JOB_RETRIES_EXHAUSTED",
] as const;
export type ChzExportSafeErrorCode = (typeof CHZ_EXPORT_SAFE_ERROR_CODES)[number];

export const chzExportRunSchema = z.strictObject({
  status: z.enum(INVENTORY_CHZ_STATUSES),
  state: z.enum(CHZ_EXPORT_RUN_STATES),
  attempts: nonnegativeInteger,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  importId: uuid.nullable(),
  orderedAt: dateTime.nullable(),
  completedAt: dateTime.nullable(),
});

export const chzExportStateSchema = z.strictObject({
  available: z.boolean(),
  blockedBy: z.array(z.enum(CHZ_EXPORT_PREFLIGHT_CODES)),
  runs: z.array(chzExportRunSchema),
});

const inventoryParticipantSchema = z.strictObject({
  deviceId: uuid,
  terminalName: z.string().min(1),
  operatorName: z.string().min(1),
  joinedAt: dateTime,
  leftAt: dateTime.nullable(),
  heartbeatAt: dateTime,
  state: z.enum(["active", "stale", "left"]),
  pendingEventCount: nonnegativeInteger,
  openBoxCount: nonnegativeInteger,
});

const inventoryLiveBoxSchema = z.strictObject({
  id: uuid,
  sscc: z.string().regex(/^\d{18}$/),
  terminalId: uuid,
  terminalName: z.string().min(1),
  productionDate: civilDate,
  state: z.enum(["open", "closed", "invalidated"]),
  printState: z.enum(["not_ready", "pending", "printing", "printed", "failed"]),
  itemCount: nonnegativeInteger,
});

const inventoryVerifiedBoxSchema = z.strictObject({
  eventId: uuid,
  sscc: z.string().regex(/^\d{18}$/),
  terminalId: uuid,
  terminalName: z.string().min(1),
  scannedAt: dateTime,
  affectedCodeCount: nonnegativeInteger,
});

const inventoryRecentEventSchema = z.strictObject({
  eventId: uuid,
  codeResultId: uuid.nullable(),
  kind: z.enum(["item", "known_box", "old_box"]),
  displayIdentity: z.string().min(1),
  authoritativeVerdict: z.string().min(1),
  terminalId: uuid,
  terminalName: z.string().min(1),
  scannedAt: dateTime,
  classification: z.enum(["expected", "protected", "ineligible", "unknown", "voided"]).nullable(),
  observedProductionDate: civilDate.nullable(),
});

export const inventoryProgressSchema = z.strictObject({
  inventoryId: uuid,
  snapshotId: uuid,
  status: inventoryStatusSchema,
  resultRevision: nonnegativeInteger,
  expectedCount: nonnegativeInteger,
  verifiedCount: nonnegativeInteger,
  missingCount: nonnegativeInteger,
  protectedCount: nonnegativeInteger,
  protectedFoundCount: nonnegativeInteger,
  ineligibleCount: nonnegativeInteger,
  unknownCount: nonnegativeInteger,
  dateMismatchCount: nonnegativeInteger,
  voidedCount: nonnegativeInteger,
  oldBoxCount: nonnegativeInteger,
  newBoxCount: nonnegativeInteger,
  invalidatedBoxCount: nonnegativeInteger,
  pendingEventCount: nonnegativeInteger,
  openBoxCount: nonnegativeInteger,
  boxTotal: nonnegativeInteger,
  boxesTruncated: z.boolean(),
  verifiedBoxTotal: nonnegativeInteger,
  verifiedBoxesTruncated: z.boolean(),
  participants: z.array(inventoryParticipantSchema),
  boxes: z.array(inventoryLiveBoxSchema),
  verifiedBoxes: z.array(inventoryVerifiedBoxSchema),
  recentEvents: z.array(inventoryRecentEventSchema),
});

export const inventoryCloseBlockerSchema = z.strictObject({
  code: z.enum([
    "ACTIVE_PARTICIPANT",
    "STALE_PARTICIPANT",
    "PENDING_OUTBOX",
    "PARTICIPANT_OPEN_BOX",
    "OPEN_REPACK_BOX",
    "INVALIDATED_REPACK_BOX",
    "UNRESOLVED_BOX_PRINT",
    "UNRESOLVED_DISCREPANCY",
  ]),
  count: z.number().int().positive(),
  participantId: uuid.nullable(),
  deviceId: uuid.nullable(),
  boxId: uuid.nullable(),
  discrepancyCategory: z.enum(["unknown", "ineligible", "date_mismatch", "voided"]).nullable(),
});

export const inventoryCloseResponseSchema = z.strictObject({
  inventoryId: uuid,
  status: z.literal("closed"),
  resultRevision: nonnegativeInteger,
  closedAt: dateTime,
  emergency: z.boolean(),
  blockers: z.array(inventoryCloseBlockerSchema),
});

export const inventoryClosePreviewResponseSchema = z.strictObject({
  inventoryId: uuid,
  status: z.literal("running"),
  resultRevision: nonnegativeInteger,
  blockers: z.array(inventoryCloseBlockerSchema),
});

export const inventoryCloseBlockedErrorSchema = z.strictObject({
  code: z.literal("INVENTORY_CLOSE_BLOCKED"),
  resultRevision: nonnegativeInteger,
  blockers: z.array(inventoryCloseBlockerSchema),
});

export const inventoryReopenResponseSchema = z.strictObject({
  inventoryId: uuid,
  status: z.literal("running"),
  resultRevision: z.number().int().positive(),
  invalidatedArtifactCount: nonnegativeInteger,
});

export const inventoryCompleteResponseSchema = z.strictObject({
  inventoryId: uuid,
  status: z.literal("completed"),
  resultRevision: nonnegativeInteger,
  completedAt: dateTime,
});

export const inventoryDocumentFormatSelectionSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  version: z.number().int().min(1).max(2_147_483_647),
});

export const createInventoryDocumentRunInputSchema = z.strictObject({
  selectedFormats: z
    .array(inventoryDocumentFormatSelectionSchema)
    .min(1)
    .max(32)
    .refine((formats) => new Set(formats.map((format) => format.id)).size === formats.length),
  idempotencyKey: uuid,
});

export const inventoryDocumentFormatSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  version: z.number().int().min(1).max(2_147_483_647),
  label: z.string().trim().min(1).max(200),
  extension: z.string().regex(/^[a-z0-9]{1,16}$/),
  mimeType: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(new RegExp(INVENTORY_DOCUMENT_MIME_TYPE_PATTERN)),
  // Флаг сервера: формат требует заполненного ИНН организации.
  requiresOrganizationInn: z.literal(true).optional(),
  requiredSourceCategories: z
    .array(z.enum(INVENTORY_DOCUMENT_SOURCE_CATEGORIES))
    .min(1)
    .max(INVENTORY_DOCUMENT_SOURCE_CATEGORIES.length)
    .refine((categories) => new Set(categories).size === categories.length),
  supportsParts: z.boolean(),
  availability: z.literal("available"),
});

export const inventoryDocumentFormatsResponseSchema = z.strictObject({
  items: z.array(inventoryDocumentFormatSchema),
});

export const inventoryDocumentArtifactSchema = z.strictObject({
  id: uuid,
  formatId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  formatVersion: z.number().int().min(1),
  partNumber: z.number().int().min(1),
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(128),
  rowCount: nonnegativeInteger,
  codeCount: nonnegativeInteger,
  boxCount: nonnegativeInteger,
  byteSize: z.number().int().min(0),
  sha256: digest,
  downloadedAt: dateTime.nullable(),
  invalidatedAt: dateTime.nullable(),
});

export const inventoryDocumentRunSchema = z.strictObject({
  id: uuid,
  inventoryId: uuid,
  resultRevision: nonnegativeInteger,
  selectedFormats: z.array(inventoryDocumentFormatSelectionSchema).min(1).max(32),
  status: z.enum(["queued", "processing", "ready", "failed"]),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
    .nullable(),
  sourceSnapshotStartedAt: dateTime.nullable(),
  sourceSnapshotCompletedAt: dateTime.nullable(),
  completedAt: dateTime.nullable(),
  attemptCount: nonnegativeInteger,
  createdAt: dateTime,
  artifacts: z.array(inventoryDocumentArtifactSchema),
});

export const inventoryDocumentRunsResponseSchema = z.strictObject({
  items: z.array(inventoryDocumentRunSchema),
});

export const inventoryDocumentDownloadSchema = z.strictObject({
  url: z.url(),
  filename: z.string().min(1).max(200),
  expiresInSeconds: z.literal(300),
});

const inventoryLateEventSchema = z.strictObject({
  id: uuid,
  batchId: z.string().min(1),
  deviceId: uuid,
  terminalName: z.string().min(1),
  eventCount: nonnegativeInteger,
  receivedAt: dateTime,
  closedRevision: nonnegativeInteger,
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  resolution: z.enum(["pending", "replayed", "discarded"]),
  resolvedAt: dateTime.nullable(),
  replayAvailable: z.boolean(),
});

export const inventoryLateEventsResponseSchema = z.strictObject({
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
  total: nonnegativeInteger,
  hasMore: z.boolean(),
  items: z.array(inventoryLateEventSchema),
});

export const inventoryLateEventsDiscardResponseSchema = z.strictObject({
  discardedCount: z.number().int().positive().max(100),
});

export const inventoryLateEventReplayResponseSchema = z.strictObject({
  lateEventId: uuid,
  resolution: z.literal("replayed"),
  result: z.strictObject({
    inventoryId: uuid,
    snapshotId: uuid,
    snapshotRevision: z.literal(1),
    batchId: z.string().min(1).max(128),
    payloadDigest: digest,
    sequenceCeiling: z.number().int().positive(),
    resultRevision: nonnegativeInteger,
    outcomes: z.array(
      z.strictObject({
        eventId: uuid,
        status: z.enum(["applied", "duplicate", "replay", "rejected", "quarantined"]),
        reasonCode: z.string().min(1),
        claimedCount: nonnegativeInteger,
        conflictCount: nonnegativeInteger,
        claims: z.array(z.unknown()),
      }),
    ),
  }),
});

export const INVENTORY_CORRECTION_ACTIONS = [
  "void_scan",
  "restore_scan",
  "change_date",
  "remove_item",
  "invalidate_box",
  "reprint",
] as const;

const inventoryEvidenceEventSchema = inventoryRecentEventSchema.extend({
  copyIdentity: z.string().nullable(),
  affectedCodeCount: nonnegativeInteger,
  discrepancyCodeCount: nonnegativeInteger,
  classifications: z.array(z.enum(["expected", "protected", "ineligible", "unknown", "voided"])),
  discrepancyCategories: z.array(z.enum(["ineligible", "unknown", "date_mismatch"])),
  actions: z.array(z.enum(["void_scan", "restore_scan", "change_date", "remove_item"])),
});

export const inventoryEvidenceResponseSchema = z.strictObject({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  total: nonnegativeInteger,
  hasMore: z.boolean(),
  allMatchingActions: z.array(z.enum(["void_scan", "restore_scan", "change_date", "remove_item"])),
  allMatchingAffectedCodeCount: nonnegativeInteger,
  items: z.array(inventoryEvidenceEventSchema),
});

export const inventoryEvidenceFilterSchema = z.strictObject({
  scope: z.enum(["all", "discrepancies"]),
  search: z.string().trim().min(1).max(128).optional(),
  kind: z.enum(["item", "known_box", "old_box"]).optional(),
  classification: z.enum(["expected", "protected", "ineligible", "unknown", "voided"]).optional(),
  discrepancyCategory: z.enum(["ineligible", "unknown", "date_mismatch"]).optional(),
});

const correctionReason = z
  .string()
  .trim()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 1024);
const correctionRequest = {
  reason: correctionReason,
  expectedResultRevision: nonnegativeInteger,
  idempotencyKey: uuid,
};
export const createInventoryCorrectionInputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("void_scan"),
    target: z.strictObject({ eventId: uuid }),
    ...correctionRequest,
  }),
  z.strictObject({
    action: z.literal("restore_scan"),
    target: z.strictObject({ eventId: uuid }),
    ...correctionRequest,
  }),
  z.strictObject({
    action: z.literal("change_date"),
    target: z.strictObject({ codeResultId: uuid }),
    observedProductionDate: civilDate,
    ...correctionRequest,
  }),
  z.strictObject({
    action: z.literal("remove_item"),
    target: z.strictObject({ codeResultId: uuid }),
    ...correctionRequest,
  }),
  z.strictObject({
    action: z.literal("invalidate_box"),
    target: z.strictObject({ repackBoxId: uuid }),
    ...correctionRequest,
  }),
  z.strictObject({
    action: z.literal("reprint"),
    target: z.strictObject({ repackBoxId: uuid }),
    ...correctionRequest,
  }),
]);

export const inventoryCorrectionSchema = z.strictObject({
  id: uuid,
  action: z.enum(INVENTORY_CORRECTION_ACTIONS),
  reason: z.string().min(1).max(1024),
  target: z.strictObject({
    eventId: uuid.nullable(),
    codeResultId: uuid.nullable(),
    repackBoxId: uuid.nullable(),
  }),
  beforeProjectionDigest: digest,
  afterProjectionDigest: digest,
  resultRevision: nonnegativeInteger,
  createdAt: dateTime,
});

const uniqueUuidArray = z
  .array(uuid)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length);
const uniqueOptionalUuidArray = z.array(uuid).refine((ids) => new Set(ids).size === ids.length);
export const inventoryCorrectionBatchSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("explicit"), eventIds: uniqueUuidArray }),
  z.strictObject({
    mode: z.literal("all_matching"),
    filter: inventoryEvidenceFilterSchema,
    excludedEventIds: uniqueOptionalUuidArray,
  }),
]);
const correctionBatchRequest = {
  selection: inventoryCorrectionBatchSelectionSchema,
  reason: correctionReason,
  expectedResultRevision: nonnegativeInteger,
  idempotencyKey: uuid,
};
export const createInventoryCorrectionBatchInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("void_scan"), ...correctionBatchRequest }),
  z.strictObject({
    action: z.literal("change_date"),
    observedProductionDate: civilDate,
    ...correctionBatchRequest,
  }),
]);

export const inventoryCorrectionBatchSchema = z.strictObject({
  id: uuid,
  action: z.enum(["void_scan", "change_date"]),
  selectedEventCount: z.number().int().positive(),
  affectedCodeCount: z.number().int().positive(),
  resultRevision: z.number().int().positive(),
  createdAt: dateTime,
});

export const createInventoryInputSchema = z
  .strictObject({
    productId: uuid,
    lineId: uuid,
    mode: inventoryModeSchema,
    productionDateFrom: civilDate,
    productionDateTo: civilDate,
    boxLabelTemplateId: uuid.nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.productionDateFrom > value.productionDateTo) {
      context.addIssue({
        code: "custom",
        path: ["productionDateTo"],
        message: "production date range is inverted",
      });
    }
    if (value.mode === "check" && value.boxLabelTemplateId != null) {
      context.addIssue({
        code: "custom",
        path: ["boxLabelTemplateId"],
        message: "check mode cannot use a box template",
      });
    }
    if (value.mode === "repack" && value.boxLabelTemplateId == null) {
      context.addIssue({
        code: "custom",
        path: ["boxLabelTemplateId"],
        message: "repack mode requires a box template",
      });
    }
  });

export type Inventory = z.infer<typeof inventorySchema>;
export type InventoryDetail = z.infer<typeof inventoryDetailSchema>;
export type InventoryImport = z.infer<typeof inventoryImportSchema>;
export type InventoryImportHistory = z.infer<typeof inventoryImportHistorySchema>;
export type InventorySnapshot = z.infer<typeof inventorySnapshotSchema>;
export type InventorySnapshotInputs = z.infer<typeof inventorySnapshotInputsSchema>;
export type CreateInventoryInput = z.infer<typeof createInventoryInputSchema>;
export type InventoryProgress = z.infer<typeof inventoryProgressSchema>;
export type InventoryCloseResponse = z.infer<typeof inventoryCloseResponseSchema>;
export type InventoryClosePreviewResponse = z.infer<typeof inventoryClosePreviewResponseSchema>;
export type InventoryCloseBlocker = z.infer<typeof inventoryCloseBlockerSchema>;
export type InventoryReopenResponse = z.infer<typeof inventoryReopenResponseSchema>;
export type InventoryCompleteResponse = z.infer<typeof inventoryCompleteResponseSchema>;
export type InventoryDocumentFormatSelection = z.infer<
  typeof inventoryDocumentFormatSelectionSchema
>;
export type CreateInventoryDocumentRunInput = z.infer<typeof createInventoryDocumentRunInputSchema>;
export type InventoryDocumentFormat = z.infer<typeof inventoryDocumentFormatSchema>;
export type InventoryDocumentArtifact = z.infer<typeof inventoryDocumentArtifactSchema>;
export type InventoryDocumentRun = z.infer<typeof inventoryDocumentRunSchema>;
export type InventoryDocumentDownload = z.infer<typeof inventoryDocumentDownloadSchema>;
export type InventoryLateEvent = z.infer<typeof inventoryLateEventSchema>;
export type InventoryLateEventsResponse = z.infer<typeof inventoryLateEventsResponseSchema>;
export type InventoryLateEventReplayResponse = z.infer<
  typeof inventoryLateEventReplayResponseSchema
>;
export type InventoryParticipant = z.infer<typeof inventoryParticipantSchema>;
export type InventoryLiveBox = z.infer<typeof inventoryLiveBoxSchema>;
export type InventoryRecentEvent = z.infer<typeof inventoryRecentEventSchema>;
export type InventoryEvidenceEvent = z.infer<typeof inventoryEvidenceEventSchema>;
export type InventoryEvidenceResponse = z.infer<typeof inventoryEvidenceResponseSchema>;
export type InventoryEvidenceFilter = z.infer<typeof inventoryEvidenceFilterSchema>;
export type CreateInventoryCorrectionInput = z.infer<typeof createInventoryCorrectionInputSchema>;
export type InventoryCorrectionBatchSelection = z.infer<
  typeof inventoryCorrectionBatchSelectionSchema
>;
export type CreateInventoryCorrectionBatchInput = z.infer<
  typeof createInventoryCorrectionBatchInputSchema
>;
export type InventoryCorrectionBatch = z.infer<typeof inventoryCorrectionBatchSchema>;
export type ChzExportRun = z.infer<typeof chzExportRunSchema>;
export type ChzExportState = z.infer<typeof chzExportStateSchema>;
export type InventoryCorrection = z.infer<typeof inventoryCorrectionSchema>;

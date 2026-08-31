import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

import {
  INVENTORY_CHZ_STATUSES,
  type InventoryChzStatus,
  type InventoryEventBatchResponse,
} from "@markiro/domain";

export type {
  StationInventoryLabelTemplateDescriptor,
  StationInventoryManifest,
} from "./station-inventory.dto";

export const INVENTORY_MODES = ["check", "repack"] as const;
export type InventoryMode = (typeof INVENTORY_MODES)[number];

export const INVENTORY_LIFECYCLE_STATUSES = [
  "draft",
  "preparing",
  "ready",
  "cancelled",
  "running",
  "closed",
  "completed",
] as const;
export type InventoryLifecycleStatus = (typeof INVENTORY_LIFECYCLE_STATUSES)[number];

export function inventoryCivilDateSchema(
  field: "productionDateFrom" | "productionDateTo" | "observedProductionDate",
) {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${field} must be YYYY-MM-DD`)
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
    }, `${field} must be a real calendar date`);
}

const productionDateFromSchema = inventoryCivilDateSchema("productionDateFrom");
const productionDateToSchema = inventoryCivilDateSchema("productionDateTo");

export const createInventorySchema = z.strictObject({
  productId: z.string().uuid(),
  lineId: z.string().uuid(),
  mode: z.enum(INVENTORY_MODES),
  productionDateFrom: productionDateFromSchema,
  productionDateTo: productionDateToSchema,
  boxLabelTemplateId: z.string().uuid().nullable().optional(),
});
export type CreateInventoryDto = z.infer<typeof createInventorySchema>;

export const updateInventorySchema = z.strictObject({
  productId: z.string().uuid().optional(),
  lineId: z.string().uuid().optional(),
  mode: z.enum(INVENTORY_MODES).optional(),
  productionDateFrom: productionDateFromSchema.optional(),
  productionDateTo: productionDateToSchema.optional(),
  boxLabelTemplateId: z.string().uuid().nullable().optional(),
});
export type UpdateInventoryDto = z.infer<typeof updateInventorySchema>;

export const inventoryImportStatusSchema = z.enum(INVENTORY_CHZ_STATUSES);
export const inventoryIdSchema = z.string().uuid();

export interface InventoryLabelTemplateDto {
  id: string;
  name: string;
}

export interface InventoryDto {
  id: string;
  number: string;
  status: InventoryLifecycleStatus;
  mode: InventoryMode;
  productId: string;
  gtin14: string;
  productName: string;
  lineId: string;
  lineName: string;
  productionDateFrom: string;
  productionDateTo: string;
  boxLabelTemplateId: string | null;
  boxLabelTemplate: InventoryLabelTemplateDto | null;
  activeSnapshotId: string | null;
  resultRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryBlockerProjectionDto {
  activeParticipantCount: number;
  pendingEventCount: number;
  participantOpenBoxCount: number;
  openRepackBoxCount: number;
  unresolvedPrintBoxCount: number;
}

export interface InventoryDetailDto extends InventoryDto {
  blockers: InventoryBlockerProjectionDto;
  imports: InventoryImportHistoryDto[];
  activeSnapshot: InventorySnapshotDto | null;
}

export const INVENTORY_CLOSE_BLOCKER_CODES = [
  "ACTIVE_PARTICIPANT",
  "STALE_PARTICIPANT",
  "PENDING_OUTBOX",
  "PARTICIPANT_OPEN_BOX",
  "OPEN_REPACK_BOX",
  "INVALIDATED_REPACK_BOX",
  "UNRESOLVED_BOX_PRINT",
  "UNRESOLVED_DISCREPANCY",
] as const;
export type InventoryCloseBlockerCode = (typeof INVENTORY_CLOSE_BLOCKER_CODES)[number];

export const INVENTORY_REQUIRED_DISCREPANCY_CATEGORIES = [
  "unknown",
  "ineligible",
  "date_mismatch",
  "voided",
] as const;
export type InventoryRequiredDiscrepancyCategory =
  (typeof INVENTORY_REQUIRED_DISCREPANCY_CATEGORIES)[number];

/**
 * Why a repack box is invalidated. `claim_lost` is the scan-conflict outcome the
 * operator can still return to work from the terminal; `admin` is the irreversible
 * `invalidate_box` correction made from the cabinet.
 */
export const INVENTORY_BOX_INVALIDATION_SOURCES = ["claim_lost", "admin"] as const;
export type InventoryBoxInvalidationSource = (typeof INVENTORY_BOX_INVALIDATION_SOURCES)[number];

export interface InventoryCloseBlockerDto {
  code: InventoryCloseBlockerCode;
  count: number;
  participantId: string | null;
  deviceId: string | null;
  boxId: string | null;
  discrepancyCategory: InventoryRequiredDiscrepancyCategory | null;
  invalidationSource: InventoryBoxInvalidationSource | null;
}

export interface InventoryCloseDto {
  inventoryId: string;
  status: "closed";
  resultRevision: number;
  closedAt: string;
  emergency: boolean;
  blockers: InventoryCloseBlockerDto[];
}

export interface InventoryClosePreviewDto {
  inventoryId: string;
  status: "running";
  resultRevision: number;
  blockers: InventoryCloseBlockerDto[];
}

export interface InventoryReopenDto {
  inventoryId: string;
  status: "running";
  resultRevision: number;
  invalidatedArtifactCount: number;
}

export interface InventoryCompleteDto {
  inventoryId: string;
  status: "completed";
  resultRevision: number;
  completedAt: string;
}

export interface InventoryLateEventsDiscardDto {
  discardedCount: number;
}

export interface InventoryLateEventReplayDto {
  lateEventId: string;
  resolution: "replayed";
  result: InventoryEventBatchResponse;
}

const boundedLifecycleReasonSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 4096, {
    message: "reason exceeds 4096 UTF-8 bytes",
  });

export const closeInventorySchema = z.strictObject({});
export type CloseInventoryDto = z.infer<typeof closeInventorySchema>;
export const emergencyCloseInventorySchema = z.strictObject({
  reason: boundedLifecycleReasonSchema,
  acknowledgeBlockers: z.literal(true),
});
export type EmergencyCloseInventoryDto = z.infer<typeof emergencyCloseInventorySchema>;
export const reopenInventorySchema = z.strictObject({});
export type ReopenInventoryDto = z.infer<typeof reopenInventorySchema>;
export const replayInventoryLateEventSchema = z.strictObject({});
export type ReplayInventoryLateEventDto = z.infer<typeof replayInventoryLateEventSchema>;
export const completeInventorySchema = z.strictObject({
  documentsDownloadedAndChecked: z.literal(true),
});
export type CompleteInventoryDto = z.infer<typeof completeInventorySchema>;

export const inventoryDocumentFormatSelectionSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  version: z.number().int().min(1).max(2_147_483_647),
});
export const createInventoryDocumentRunSchema = z.strictObject({
  selectedFormats: z
    .array(inventoryDocumentFormatSelectionSchema)
    .min(1)
    .max(32)
    .superRefine((formats, context) => {
      if (new Set(formats.map((format) => format.id)).size !== formats.length) {
        context.addIssue({ code: "custom", message: "selectedFormats ids must be unique" });
      }
    }),
  idempotencyKey: z.string().uuid(),
});
export type CreateInventoryDocumentRunDto = z.infer<typeof createInventoryDocumentRunSchema>;
export const retryInventoryDocumentRunSchema = z.strictObject({});
export type RetryInventoryDocumentRunDto = z.infer<typeof retryInventoryDocumentRunSchema>;

const nullableDateTimeStringSchema = z.iso.datetime().nullable();
export const inventoryDocumentArtifactResponseSchema = z.strictObject({
  id: z.string().uuid(),
  formatId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  formatVersion: z.number().int().min(1),
  partNumber: z.number().int().min(1),
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(128),
  rowCount: z.number().int().min(0),
  codeCount: z.number().int().min(0),
  boxCount: z.number().int().min(0),
  byteSize: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  downloadedAt: nullableDateTimeStringSchema,
  invalidatedAt: nullableDateTimeStringSchema,
});
export type InventoryDocumentArtifactDto = z.infer<typeof inventoryDocumentArtifactResponseSchema>;

export const inventoryDocumentRunResponseSchema = z.strictObject({
  id: z.string().uuid(),
  inventoryId: z.string().uuid(),
  resultRevision: z.number().int().min(0),
  selectedFormats: z.array(inventoryDocumentFormatSelectionSchema).min(1).max(32),
  status: z.enum(["queued", "processing", "ready", "failed"]),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
    .nullable(),
  sourceSnapshotStartedAt: nullableDateTimeStringSchema,
  sourceSnapshotCompletedAt: nullableDateTimeStringSchema,
  completedAt: nullableDateTimeStringSchema,
  attemptCount: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  artifacts: z.array(inventoryDocumentArtifactResponseSchema),
});
export type InventoryDocumentRunDto = z.infer<typeof inventoryDocumentRunResponseSchema>;

export const inventoryDocumentRunsResponseSchema = z.strictObject({
  items: z.array(inventoryDocumentRunResponseSchema),
});
export type InventoryDocumentRunsResponseDto = z.infer<typeof inventoryDocumentRunsResponseSchema>;

export const inventoryDocumentDownloadResponseSchema = z.strictObject({
  url: z.url(),
  filename: z.string().min(1).max(200),
  expiresInSeconds: z.literal(300),
});
export type InventoryDocumentDownloadDto = z.infer<typeof inventoryDocumentDownloadResponseSchema>;
export const discardInventoryLateEventsSchema = z.strictObject({
  lateEventIds: z
    .array(z.string().uuid())
    .min(1)
    .max(100)
    .superRefine((ids, context) => {
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: "custom", message: "lateEventIds must be unique" });
      }
    }),
  reason: boundedLifecycleReasonSchema,
});
export type DiscardInventoryLateEventsDto = z.infer<typeof discardInventoryLateEventsSchema>;

export const listInventoryLateEventsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListInventoryLateEventsQueryDto = z.infer<typeof listInventoryLateEventsQuerySchema>;

export interface InventoryLateEventDto {
  id: string;
  batchId: string;
  deviceId: string;
  terminalName: string;
  eventCount: number;
  receivedAt: string;
  closedRevision: number;
  reason: string;
  resolution: "pending" | "replayed" | "discarded";
  resolvedAt: string | null;
  replayAvailable: boolean;
}

export interface ListInventoryLateEventsResponseDto {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  items: InventoryLateEventDto[];
}

export interface ListInventoriesResponseDto {
  items: InventoryDto[];
}

export interface InventoryImportDiagnosticDto {
  code: string;
  rowNumber?: number;
}

export interface InventoryImportDto {
  id: string;
  declaredStatus: InventoryChzStatus;
  parsedStatus: InventoryChzStatus | null;
  result: "succeeded" | "failed";
  rowCount: number;
  errorCount: number;
  duplicateCount: number;
  sha256: string;
  diagnostics: InventoryImportDiagnosticDto[];
}

export interface InventoryImportHistoryDto extends InventoryImportDto {
  fileName: string;
  createdAt: string;
}

const selectedInventoryImportsSchema = z
  .strictObject({
    EMITTED: z.string().uuid(),
    INTRODUCED: z.string().uuid(),
    APPLIED: z.string().uuid(),
    RETIRED: z.string().uuid(),
    WRITTEN_OFF: z.string().uuid(),
    DISAGGREGATION: z.string().uuid(),
  })
  .superRefine((imports, context) => {
    const seen = new Map<string, InventoryChzStatus>();
    for (const status of INVENTORY_CHZ_STATUSES) {
      const importId = imports[status];
      const previousStatus = seen.get(importId);
      if (previousStatus !== undefined) {
        context.addIssue({
          code: "custom",
          message: `Import is already selected for ${previousStatus}`,
          path: [status],
        });
      } else {
        seen.set(importId, status);
      }
    }
  });

export const fixInventorySnapshotSchema = z.strictObject({
  imports: selectedInventoryImportsSchema,
});
export type FixInventorySnapshotDto = z.infer<typeof fixInventorySnapshotSchema>;
export type InventorySnapshotInputSelectionDto = FixInventorySnapshotDto["imports"];

export interface InventorySnapshotCountsDto {
  emitted: number;
  introduced: number;
  applied: number;
  retired: number;
  writtenOff: number;
  disaggregation: number;
  protected: number;
  expected: number;
  packages: number;
  loose: number;
}

export interface InventorySnapshotDto {
  id: string;
  inventoryId: string;
  revision: number;
  combinedDigest: string;
  fixedAt: string;
  inputs: InventorySnapshotInputSelectionDto;
  counts: InventorySnapshotCountsDto;
}

export const INVENTORY_DISCREPANCY_CATEGORIES = [
  "missing",
  "protected",
  "ineligible",
  "unknown",
  "date_mismatch",
  "voided",
  "invalidated_box",
] as const;
export type InventoryDiscrepancyCategory = (typeof INVENTORY_DISCREPANCY_CATEGORIES)[number];

export const listInventoryDiscrepanciesQuerySchema = z.strictObject({
  category: z.enum(INVENTORY_DISCREPANCY_CATEGORIES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListInventoryDiscrepanciesQueryDto = z.infer<
  typeof listInventoryDiscrepanciesQuerySchema
>;

export interface InventoryProgressDto {
  inventoryId: string;
  snapshotId: string;
  status: InventoryLifecycleStatus;
  resultRevision: number;
  expectedCount: number;
  verifiedCount: number;
  missingCount: number;
  protectedCount: number;
  protectedFoundCount: number;
  ineligibleCount: number;
  unknownCount: number;
  dateMismatchCount: number;
  voidedCount: number;
  oldBoxCount: number;
  newBoxCount: number;
  invalidatedBoxCount: number;
  pendingEventCount: number;
  openBoxCount: number;
  boxTotal: number;
  boxesTruncated: boolean;
  verifiedBoxTotal: number;
  verifiedBoxesTruncated: boolean;
  participants: InventoryParticipantDto[];
  boxes: InventoryLiveBoxDto[];
  verifiedBoxes: InventoryVerifiedBoxDto[];
  recentEvents: InventoryRecentEventDto[];
}

export type InventoryParticipantState = "active" | "stale" | "left";

export interface InventoryParticipantDto {
  deviceId: string;
  terminalName: string;
  operatorName: string;
  joinedAt: string;
  leftAt: string | null;
  heartbeatAt: string;
  state: InventoryParticipantState;
  pendingEventCount: number;
  openBoxCount: number;
}

export interface InventoryLiveBoxDto {
  id: string;
  sscc: string;
  terminalId: string;
  terminalName: string;
  productionDate: string;
  state: "open" | "closed" | "invalidated";
  invalidationSource: InventoryBoxInvalidationSource | null;
  printState: "not_ready" | "pending" | "printing" | "printed" | "failed";
  itemCount: number;
}

export interface InventoryVerifiedBoxDto {
  eventId: string;
  sscc: string;
  terminalId: string;
  terminalName: string;
  scannedAt: string;
  affectedCodeCount: number;
}

export interface InventoryRecentEventDto {
  eventId: string;
  codeResultId: string | null;
  kind: "item" | "known_box" | "old_box";
  displayIdentity: string;
  authoritativeVerdict: string;
  terminalId: string;
  terminalName: string;
  scannedAt: string;
  classification: "expected" | "protected" | "ineligible" | "unknown" | "voided" | null;
  observedProductionDate: string | null;
}

export const INVENTORY_EVIDENCE_CLASSIFICATIONS = [
  "expected",
  "protected",
  "ineligible",
  "unknown",
  "voided",
] as const;
export const INVENTORY_EVIDENCE_KINDS = ["item", "known_box", "old_box"] as const;
export const INVENTORY_ACTIONABLE_DISCREPANCY_CATEGORIES = [
  "ineligible",
  "unknown",
  "date_mismatch",
] as const;
export const listInventoryEvidenceQuerySchema = z.strictObject({
  scope: z.enum(["all", "discrepancies"]).default("all"),
  search: z.string().trim().min(1).max(128).optional(),
  kind: z.enum(INVENTORY_EVIDENCE_KINDS).optional(),
  classification: z.enum(INVENTORY_EVIDENCE_CLASSIFICATIONS).optional(),
  discrepancyCategory: z.enum(INVENTORY_ACTIONABLE_DISCREPANCY_CATEGORIES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListInventoryEvidenceQueryDto = z.infer<typeof listInventoryEvidenceQuerySchema>;

export type InventoryEvidenceAction = "void_scan" | "restore_scan" | "change_date" | "remove_item";
export interface InventoryEvidenceEventDto extends InventoryRecentEventDto {
  copyIdentity: string | null;
  affectedCodeCount: number;
  discrepancyCodeCount: number;
  classifications: Array<"expected" | "protected" | "ineligible" | "unknown" | "voided">;
  discrepancyCategories: Array<"ineligible" | "unknown" | "date_mismatch">;
  actions: InventoryEvidenceAction[];
}

export interface ListInventoryEvidenceResponseDto {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  allMatchingActions: InventoryEvidenceAction[];
  allMatchingAffectedCodeCount: number;
  items: InventoryEvidenceEventDto[];
}

export interface InventoryDiscrepancyWinnerDto {
  terminalId: string;
  terminalName: string;
  scannedAt: string;
}

export interface InventoryDiscrepancyDto {
  category: InventoryDiscrepancyCategory;
  displayIdentity: string;
  codeHash: string | null;
  sscc: string | null;
  found: boolean;
  sourceStatus: InventoryChzStatus | null;
  sourceProductionDate: string | null;
  observedProductionDate: string | null;
  winner: InventoryDiscrepancyWinnerDto | null;
}

export interface ListInventoryDiscrepanciesResponseDto {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  items: InventoryDiscrepancyDto[];
}

export const INVENTORY_CORRECTION_ACTIONS = [
  "void_scan",
  "restore_scan",
  "change_date",
  "remove_item",
  "invalidate_box",
  "reprint",
] as const;
export type InventoryCorrectionAction = (typeof INVENTORY_CORRECTION_ACTIONS)[number];

const correctionReasonSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 1024, {
    message: "reason exceeds 1024 UTF-8 bytes",
  });
const correctionRequestShape = {
  reason: correctionReasonSchema,
  expectedResultRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(1).max(128),
};
const eventCorrectionTargetSchema = z.strictObject({ eventId: z.string().uuid() });
const resultCorrectionTargetSchema = z.strictObject({ codeResultId: z.string().uuid() });
const boxCorrectionTargetSchema = z.strictObject({ repackBoxId: z.string().uuid() });

export const createInventoryCorrectionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("void_scan"),
    target: eventCorrectionTargetSchema,
    ...correctionRequestShape,
  }),
  z.strictObject({
    action: z.literal("restore_scan"),
    target: eventCorrectionTargetSchema,
    ...correctionRequestShape,
  }),
  z.strictObject({
    action: z.literal("change_date"),
    target: resultCorrectionTargetSchema,
    observedProductionDate: inventoryCivilDateSchema("observedProductionDate"),
    ...correctionRequestShape,
  }),
  z.strictObject({
    action: z.literal("remove_item"),
    target: resultCorrectionTargetSchema,
    ...correctionRequestShape,
  }),
  z.strictObject({
    action: z.literal("invalidate_box"),
    target: boxCorrectionTargetSchema,
    ...correctionRequestShape,
  }),
  z.strictObject({
    action: z.literal("reprint"),
    target: boxCorrectionTargetSchema,
    ...correctionRequestShape,
  }),
]);
export type CreateInventoryCorrectionDto = z.infer<typeof createInventoryCorrectionSchema>;

export interface InventoryCorrectionTargetDto {
  eventId: string | null;
  codeResultId: string | null;
  repackBoxId: string | null;
}

export interface InventoryCorrectionDto {
  id: string;
  action: InventoryCorrectionAction;
  reason: string;
  target: InventoryCorrectionTargetDto;
  beforeProjectionDigest: string;
  afterProjectionDigest: string;
  resultRevision: number;
  createdAt: string;
}

const uniqueUuidArray = z
  .array(z.string().uuid())
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, "eventIds must be unique");
const uniqueOptionalUuidArray = z
  .array(z.string().uuid())
  .refine((ids) => new Set(ids).size === ids.length, "excludedEventIds must be unique");
const inventoryEvidenceBatchFilterSchema = z.strictObject({
  scope: z.enum(["all", "discrepancies"]),
  search: z.string().trim().min(1).max(128).optional(),
  kind: z.enum(INVENTORY_EVIDENCE_KINDS).optional(),
  classification: z.enum(INVENTORY_EVIDENCE_CLASSIFICATIONS).optional(),
  discrepancyCategory: z.enum(INVENTORY_ACTIONABLE_DISCREPANCY_CATEGORIES).optional(),
});
const inventoryCorrectionBatchSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("explicit"), eventIds: uniqueUuidArray }),
  z.strictObject({
    mode: z.literal("all_matching"),
    filter: inventoryEvidenceBatchFilterSchema,
    excludedEventIds: uniqueOptionalUuidArray,
  }),
]);
const correctionBatchRequestShape = {
  selection: inventoryCorrectionBatchSelectionSchema,
  reason: correctionReasonSchema,
  expectedResultRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(1).max(128),
};
export const createInventoryCorrectionBatchSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("void_scan"), ...correctionBatchRequestShape }),
  z.strictObject({
    action: z.literal("change_date"),
    observedProductionDate: inventoryCivilDateSchema("observedProductionDate"),
    ...correctionBatchRequestShape,
  }),
]);
export type CreateInventoryCorrectionBatchDto = z.infer<
  typeof createInventoryCorrectionBatchSchema
>;

export interface InventoryCorrectionBatchDto {
  id: string;
  action: "void_scan" | "change_date";
  selectedEventCount: number;
  affectedCodeCount: number;
  resultRevision: number;
  createdAt: string;
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateSchema = { type: "string", format: "date" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

export const createInventoryDocumentRunOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["selectedFormats", "idempotencyKey"],
  properties: {
    selectedFormats: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "version"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
          version: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
        },
      },
    },
    idempotencyKey: uuidSchema,
  },
};

export const retryInventoryDocumentRunOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

export const inventoryDocumentArtifactOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "formatId",
    "formatVersion",
    "partNumber",
    "filename",
    "mimeType",
    "rowCount",
    "codeCount",
    "boxCount",
    "byteSize",
    "sha256",
    "downloadedAt",
    "invalidatedAt",
  ],
  properties: {
    id: uuidSchema,
    formatId: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
    formatVersion: { type: "integer", minimum: 1 },
    partNumber: { type: "integer", minimum: 1 },
    filename: { type: "string", minLength: 1, maxLength: 200 },
    mimeType: { type: "string", minLength: 1, maxLength: 128 },
    rowCount: { type: "integer", minimum: 0 },
    codeCount: { type: "integer", minimum: 0 },
    boxCount: { type: "integer", minimum: 0 },
    byteSize: { type: "integer", minimum: 0 },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    downloadedAt: { ...dateTimeSchema, nullable: true },
    invalidatedAt: { ...dateTimeSchema, nullable: true },
  },
};

export const inventoryDocumentRunOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "inventoryId",
    "resultRevision",
    "selectedFormats",
    "status",
    "errorCode",
    "sourceSnapshotStartedAt",
    "sourceSnapshotCompletedAt",
    "completedAt",
    "attemptCount",
    "createdAt",
    "artifacts",
  ],
  properties: {
    id: uuidSchema,
    inventoryId: uuidSchema,
    resultRevision: { type: "integer", minimum: 0 },
    selectedFormats: createInventoryDocumentRunOpenApiSchema.properties!.selectedFormats!,
    status: { type: "string", enum: ["queued", "processing", "ready", "failed"] },
    errorCode: { type: "string", nullable: true, pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
    sourceSnapshotStartedAt: { ...dateTimeSchema, nullable: true },
    sourceSnapshotCompletedAt: { ...dateTimeSchema, nullable: true },
    completedAt: { ...dateTimeSchema, nullable: true },
    attemptCount: { type: "integer", minimum: 0 },
    createdAt: dateTimeSchema,
    artifacts: { type: "array", items: inventoryDocumentArtifactOpenApiSchema },
  },
};

export const inventoryDocumentRunsOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: inventoryDocumentRunOpenApiSchema } },
};

export const inventoryDocumentDownloadOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["url", "filename", "expiresInSeconds"],
  properties: {
    url: { type: "string", format: "uri" },
    filename: { type: "string", minLength: 1, maxLength: 200 },
    expiresInSeconds: { type: "integer", enum: [300] },
  },
};

function correctionRequestOpenApiBranch(
  action: InventoryCorrectionAction,
  targetProperty: "eventId" | "codeResultId" | "repackBoxId",
  includesObservedDate = false,
): SchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "action",
      "target",
      "reason",
      "expectedResultRevision",
      "idempotencyKey",
      ...(includesObservedDate ? ["observedProductionDate"] : []),
    ],
    properties: {
      action: { type: "string", enum: [action] },
      target: {
        type: "object",
        additionalProperties: false,
        required: [targetProperty],
        properties: { [targetProperty]: uuidSchema },
      },
      reason: {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        "x-maxUtf8Bytes": 1024,
      } as SchemaObject & { "x-maxUtf8Bytes": number },
      expectedResultRevision: { type: "integer", minimum: 0 },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
      ...(includesObservedDate ? { observedProductionDate: dateSchema } : {}),
    },
  };
}

export const createInventoryCorrectionOpenApiSchema: SchemaObject = {
  oneOf: [
    correctionRequestOpenApiBranch("void_scan", "eventId"),
    correctionRequestOpenApiBranch("restore_scan", "eventId"),
    correctionRequestOpenApiBranch("change_date", "codeResultId", true),
    correctionRequestOpenApiBranch("remove_item", "codeResultId"),
    correctionRequestOpenApiBranch("invalidate_box", "repackBoxId"),
    correctionRequestOpenApiBranch("reprint", "repackBoxId"),
  ],
  discriminator: { propertyName: "action" },
};

export const inventoryCorrectionOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "action",
    "reason",
    "target",
    "beforeProjectionDigest",
    "afterProjectionDigest",
    "resultRevision",
    "createdAt",
  ],
  properties: {
    id: uuidSchema,
    action: { type: "string", enum: [...INVENTORY_CORRECTION_ACTIONS] },
    reason: { type: "string" },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["eventId", "codeResultId", "repackBoxId"],
      properties: {
        eventId: { ...uuidSchema, nullable: true },
        codeResultId: { ...uuidSchema, nullable: true },
        repackBoxId: { ...uuidSchema, nullable: true },
      },
    },
    beforeProjectionDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    afterProjectionDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    resultRevision: { type: "integer", minimum: 1 },
    createdAt: dateTimeSchema,
  },
};

const inventoryCorrectionBatchSelectionOpenApiSchema: SchemaObject = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "eventIds"],
      properties: {
        mode: { type: "string", enum: ["explicit"] },
        eventIds: { type: "array", minItems: 1, uniqueItems: true, items: uuidSchema },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "filter", "excludedEventIds"],
      properties: {
        mode: { type: "string", enum: ["all_matching"] },
        filter: {
          type: "object",
          additionalProperties: false,
          required: ["scope"],
          properties: {
            scope: { type: "string", enum: ["all", "discrepancies"] },
            search: { type: "string", minLength: 1, maxLength: 128 },
            kind: { type: "string", enum: [...INVENTORY_EVIDENCE_KINDS] },
            classification: {
              type: "string",
              enum: [...INVENTORY_EVIDENCE_CLASSIFICATIONS],
            },
            discrepancyCategory: {
              type: "string",
              enum: [...INVENTORY_ACTIONABLE_DISCREPANCY_CATEGORIES],
            },
          },
        },
        excludedEventIds: { type: "array", uniqueItems: true, items: uuidSchema },
      },
    },
  ],
  discriminator: { propertyName: "mode" },
};

function correctionBatchRequestOpenApiBranch(action: "void_scan" | "change_date"): SchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "action",
      "selection",
      "reason",
      "expectedResultRevision",
      "idempotencyKey",
      ...(action === "change_date" ? ["observedProductionDate"] : []),
    ],
    properties: {
      action: { type: "string", enum: [action] },
      selection: inventoryCorrectionBatchSelectionOpenApiSchema,
      reason: {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        "x-maxUtf8Bytes": 1024,
      } as SchemaObject & { "x-maxUtf8Bytes": number },
      expectedResultRevision: { type: "integer", minimum: 0 },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
      ...(action === "change_date" ? { observedProductionDate: dateSchema } : {}),
    },
  };
}

export const createInventoryCorrectionBatchOpenApiSchema: SchemaObject = {
  oneOf: [
    correctionBatchRequestOpenApiBranch("void_scan"),
    correctionBatchRequestOpenApiBranch("change_date"),
  ],
  discriminator: { propertyName: "action" },
};

export const inventoryCorrectionBatchOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "action",
    "selectedEventCount",
    "affectedCodeCount",
    "resultRevision",
    "createdAt",
  ],
  properties: {
    id: uuidSchema,
    action: { type: "string", enum: ["void_scan", "change_date"] },
    selectedEventCount: { type: "integer", minimum: 1 },
    affectedCodeCount: { type: "integer", minimum: 1 },
    resultRevision: { type: "integer", minimum: 1 },
    createdAt: dateTimeSchema,
  },
};

const emptyMutationOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {},
};

export const closeInventoryOpenApiSchema = emptyMutationOpenApiSchema;
export const reopenInventoryOpenApiSchema = emptyMutationOpenApiSchema;
export const emergencyCloseInventoryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["reason", "acknowledgeBlockers"],
  properties: {
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 4096,
      "x-maxUtf8Bytes": 4096,
    } as SchemaObject & { "x-maxUtf8Bytes": number },
    acknowledgeBlockers: { type: "boolean", enum: [true] },
  },
};
export const completeInventoryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["documentsDownloadedAndChecked"],
  properties: { documentsDownloadedAndChecked: { type: "boolean", enum: [true] } },
};

const inventoryCloseBlockerOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "code",
    "count",
    "participantId",
    "deviceId",
    "boxId",
    "discrepancyCategory",
    "invalidationSource",
  ],
  properties: {
    code: { type: "string", enum: [...INVENTORY_CLOSE_BLOCKER_CODES] },
    count: { type: "integer", minimum: 1 },
    participantId: { ...uuidSchema, nullable: true },
    deviceId: { ...uuidSchema, nullable: true },
    boxId: { ...uuidSchema, nullable: true },
    discrepancyCategory: {
      type: "string",
      enum: [...INVENTORY_REQUIRED_DISCREPANCY_CATEGORIES],
      nullable: true,
    },
    invalidationSource: {
      type: "string",
      enum: [...INVENTORY_BOX_INVALIDATION_SOURCES],
      nullable: true,
    },
  },
};

export const inventoryCloseOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["inventoryId", "status", "resultRevision", "closedAt", "emergency", "blockers"],
  properties: {
    inventoryId: uuidSchema,
    status: { type: "string", enum: ["closed"] },
    resultRevision: { type: "integer", minimum: 0 },
    closedAt: dateTimeSchema,
    emergency: { type: "boolean" },
    blockers: { type: "array", items: inventoryCloseBlockerOpenApiSchema },
  },
};

export const inventoryCloseBlockedOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code", "resultRevision", "blockers"],
  properties: {
    code: { type: "string", enum: ["INVENTORY_CLOSE_BLOCKED"] },
    resultRevision: { type: "integer", minimum: 0 },
    blockers: { type: "array", items: inventoryCloseBlockerOpenApiSchema },
  },
};

export const inventoryClosePreviewOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["inventoryId", "status", "resultRevision", "blockers"],
  properties: {
    inventoryId: uuidSchema,
    status: { type: "string", enum: ["running"] },
    resultRevision: { type: "integer", minimum: 0 },
    blockers: { type: "array", items: inventoryCloseBlockerOpenApiSchema },
  },
};

export const inventoryReopenOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["inventoryId", "status", "resultRevision", "invalidatedArtifactCount"],
  properties: {
    inventoryId: uuidSchema,
    status: { type: "string", enum: ["running"] },
    resultRevision: { type: "integer", minimum: 1 },
    invalidatedArtifactCount: { type: "integer", minimum: 0 },
  },
};

export const inventoryCompleteOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["inventoryId", "status", "resultRevision", "completedAt"],
  properties: {
    inventoryId: uuidSchema,
    status: { type: "string", enum: ["completed"] },
    resultRevision: { type: "integer", minimum: 0 },
    completedAt: dateTimeSchema,
  },
};

export const inventoryCompletionUnavailableOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code", "requiredTask"],
  properties: {
    code: { type: "string", enum: ["INVENTORY_DOCUMENT_ARTIFACTS_UNAVAILABLE"] },
    requiredTask: { type: "integer", enum: [8] },
  },
};

const inventoryLateEventOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "batchId",
    "deviceId",
    "terminalName",
    "eventCount",
    "receivedAt",
    "closedRevision",
    "reason",
    "resolution",
    "resolvedAt",
    "replayAvailable",
  ],
  properties: {
    id: uuidSchema,
    batchId: { type: "string" },
    deviceId: uuidSchema,
    terminalName: { type: "string" },
    eventCount: { type: "integer", minimum: 0 },
    receivedAt: dateTimeSchema,
    closedRevision: { type: "integer", minimum: 0 },
    reason: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
    resolution: { type: "string", enum: ["pending", "replayed", "discarded"] },
    resolvedAt: { ...dateTimeSchema, nullable: true },
    replayAvailable: { type: "boolean" },
  },
};

export const listInventoryLateEventsOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["page", "pageSize", "total", "hasMore", "items"],
  properties: {
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100 },
    total: { type: "integer", minimum: 0 },
    hasMore: { type: "boolean" },
    items: { type: "array", items: inventoryLateEventOpenApiSchema },
  },
};

export const discardInventoryLateEventsOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["lateEventIds", "reason"],
  properties: {
    lateEventIds: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: uuidSchema,
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 4096,
      "x-maxUtf8Bytes": 4096,
    } as SchemaObject & { "x-maxUtf8Bytes": number },
  },
};

export const inventoryLateEventsDiscardOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["discardedCount"],
  properties: { discardedCount: { type: "integer", minimum: 1, maximum: 100 } },
};

export function inventoryLateEventReplayOpenApiSchema(resultSchema: SchemaObject): SchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["lateEventId", "resolution", "result"],
    properties: {
      lateEventId: uuidSchema,
      resolution: { type: "string", enum: ["replayed"] },
      result: resultSchema,
    },
  };
}

export const createInventoryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["productId", "lineId", "mode", "productionDateFrom", "productionDateTo"],
  properties: {
    productId: uuidSchema,
    lineId: uuidSchema,
    mode: { type: "string", enum: [...INVENTORY_MODES] },
    productionDateFrom: dateSchema,
    productionDateTo: dateSchema,
    boxLabelTemplateId: { ...uuidSchema, nullable: true },
  },
};

export const updateInventoryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {
    productId: uuidSchema,
    lineId: uuidSchema,
    mode: { type: "string", enum: [...INVENTORY_MODES] },
    productionDateFrom: dateSchema,
    productionDateTo: dateSchema,
    boxLabelTemplateId: { ...uuidSchema, nullable: true },
  },
};

export const inventoryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "number",
    "status",
    "mode",
    "productId",
    "gtin14",
    "productName",
    "lineId",
    "lineName",
    "productionDateFrom",
    "productionDateTo",
    "boxLabelTemplateId",
    "boxLabelTemplate",
    "activeSnapshotId",
    "resultRevision",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: uuidSchema,
    number: { type: "string" },
    status: { type: "string", enum: [...INVENTORY_LIFECYCLE_STATUSES] },
    mode: { type: "string", enum: [...INVENTORY_MODES] },
    productId: uuidSchema,
    gtin14: { type: "string", pattern: "^[0-9]{14}$" },
    productName: { type: "string" },
    lineId: uuidSchema,
    lineName: { type: "string" },
    productionDateFrom: dateSchema,
    productionDateTo: dateSchema,
    boxLabelTemplateId: { ...uuidSchema, nullable: true },
    boxLabelTemplate: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: ["id", "name"],
      properties: {
        id: uuidSchema,
        name: { type: "string" },
      },
    },
    activeSnapshotId: { ...uuidSchema, nullable: true },
    resultRevision: { type: "integer", minimum: 0 },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
};

const inventoryBlockerProjectionOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "activeParticipantCount",
    "pendingEventCount",
    "participantOpenBoxCount",
    "openRepackBoxCount",
    "unresolvedPrintBoxCount",
  ],
  properties: {
    activeParticipantCount: { type: "integer", minimum: 0 },
    pendingEventCount: { type: "integer", minimum: 0 },
    participantOpenBoxCount: { type: "integer", minimum: 0 },
    openRepackBoxCount: { type: "integer", minimum: 0 },
    unresolvedPrintBoxCount: { type: "integer", minimum: 0 },
  },
};

export const listInventoriesOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: inventoryOpenApiSchema } },
};

export const inventoryImportOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "declaredStatus",
    "parsedStatus",
    "result",
    "rowCount",
    "errorCount",
    "duplicateCount",
    "sha256",
    "diagnostics",
  ],
  properties: {
    id: uuidSchema,
    declaredStatus: { type: "string", enum: [...INVENTORY_CHZ_STATUSES] },
    parsedStatus: { type: "string", enum: [...INVENTORY_CHZ_STATUSES], nullable: true },
    result: { type: "string", enum: ["succeeded", "failed"] },
    rowCount: { type: "integer", minimum: 0 },
    errorCount: { type: "integer", minimum: 0 },
    duplicateCount: { type: "integer", minimum: 0 },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: {
          code: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
          rowNumber: { type: "integer", minimum: 1 },
        },
      },
    },
  },
};

const inventorySnapshotInputProperties = Object.fromEntries(
  INVENTORY_CHZ_STATUSES.map((status) => [status, uuidSchema]),
);

export const fixInventorySnapshotOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["imports"],
  properties: {
    imports: {
      type: "object",
      additionalProperties: false,
      required: [...INVENTORY_CHZ_STATUSES],
      properties: inventorySnapshotInputProperties,
    },
  },
};

const inventorySnapshotCountProperties = {
  emitted: { type: "integer", minimum: 0 },
  introduced: { type: "integer", minimum: 0 },
  applied: { type: "integer", minimum: 0 },
  retired: { type: "integer", minimum: 0 },
  writtenOff: { type: "integer", minimum: 0 },
  disaggregation: { type: "integer", minimum: 0 },
  protected: { type: "integer", minimum: 0 },
  expected: { type: "integer", minimum: 0 },
  packages: { type: "integer", minimum: 0 },
  loose: { type: "integer", minimum: 0 },
} satisfies Record<keyof InventorySnapshotCountsDto, SchemaObject>;

export const inventorySnapshotOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "inventoryId", "revision", "combinedDigest", "fixedAt", "inputs", "counts"],
  properties: {
    id: uuidSchema,
    inventoryId: uuidSchema,
    revision: { type: "integer", minimum: 1 },
    combinedDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    fixedAt: dateTimeSchema,
    inputs: {
      type: "object",
      additionalProperties: false,
      required: [...INVENTORY_CHZ_STATUSES],
      properties: inventorySnapshotInputProperties,
    },
    counts: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(inventorySnapshotCountProperties),
      properties: inventorySnapshotCountProperties,
    },
  },
};

const inventoryImportHistoryOpenApiSchema: SchemaObject = {
  ...inventoryImportOpenApiSchema,
  required: [...(inventoryImportOpenApiSchema.required ?? []), "fileName", "createdAt"],
  properties: {
    ...inventoryImportOpenApiSchema.properties,
    fileName: { type: "string" },
    createdAt: dateTimeSchema,
  },
};

export const inventoryDetailOpenApiSchema: SchemaObject = {
  ...inventoryOpenApiSchema,
  required: [...(inventoryOpenApiSchema.required ?? []), "blockers", "imports", "activeSnapshot"],
  properties: {
    ...inventoryOpenApiSchema.properties,
    blockers: inventoryBlockerProjectionOpenApiSchema,
    imports: { type: "array", items: inventoryImportHistoryOpenApiSchema },
    activeSnapshot: { ...inventorySnapshotOpenApiSchema, nullable: true },
  },
};

const inventoryCountProperties = {
  expectedCount: { type: "integer", minimum: 0 },
  verifiedCount: { type: "integer", minimum: 0 },
  missingCount: { type: "integer", minimum: 0 },
  protectedCount: { type: "integer", minimum: 0 },
  protectedFoundCount: { type: "integer", minimum: 0 },
  ineligibleCount: { type: "integer", minimum: 0 },
  unknownCount: { type: "integer", minimum: 0 },
  dateMismatchCount: { type: "integer", minimum: 0 },
  voidedCount: { type: "integer", minimum: 0 },
  oldBoxCount: { type: "integer", minimum: 0 },
  newBoxCount: { type: "integer", minimum: 0 },
  invalidatedBoxCount: { type: "integer", minimum: 0 },
  pendingEventCount: { type: "integer", minimum: 0 },
  openBoxCount: { type: "integer", minimum: 0 },
  boxTotal: { type: "integer", minimum: 0 },
  verifiedBoxTotal: { type: "integer", minimum: 0 },
} satisfies Record<
  Exclude<
    keyof InventoryProgressDto,
    | "inventoryId"
    | "snapshotId"
    | "status"
    | "resultRevision"
    | "participants"
    | "boxes"
    | "verifiedBoxes"
    | "recentEvents"
    | "boxesTruncated"
    | "verifiedBoxesTruncated"
  >,
  SchemaObject
>;

const inventoryParticipantOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "deviceId",
    "terminalName",
    "operatorName",
    "joinedAt",
    "leftAt",
    "heartbeatAt",
    "state",
    "pendingEventCount",
    "openBoxCount",
  ],
  properties: {
    deviceId: uuidSchema,
    terminalName: { type: "string" },
    operatorName: { type: "string" },
    joinedAt: dateTimeSchema,
    leftAt: { ...dateTimeSchema, nullable: true },
    heartbeatAt: dateTimeSchema,
    state: { type: "string", enum: ["active", "stale", "left"] },
    pendingEventCount: { type: "integer", minimum: 0 },
    openBoxCount: { type: "integer", minimum: 0 },
  },
};

const inventoryLiveBoxOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "sscc",
    "terminalId",
    "terminalName",
    "productionDate",
    "state",
    "invalidationSource",
    "printState",
    "itemCount",
  ],
  properties: {
    id: uuidSchema,
    sscc: { type: "string", pattern: "^[0-9]{18}$" },
    terminalId: uuidSchema,
    terminalName: { type: "string" },
    productionDate: dateSchema,
    state: { type: "string", enum: ["open", "closed", "invalidated"] },
    invalidationSource: {
      type: "string",
      enum: [...INVENTORY_BOX_INVALIDATION_SOURCES],
      nullable: true,
    },
    printState: {
      type: "string",
      enum: ["not_ready", "pending", "printing", "printed", "failed"],
    },
    itemCount: { type: "integer", minimum: 0 },
  },
};

const inventoryVerifiedBoxOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["eventId", "sscc", "terminalId", "terminalName", "scannedAt", "affectedCodeCount"],
  properties: {
    eventId: uuidSchema,
    sscc: { type: "string", pattern: "^[0-9]{18}$" },
    terminalId: uuidSchema,
    terminalName: { type: "string" },
    scannedAt: dateTimeSchema,
    affectedCodeCount: { type: "integer", minimum: 0 },
  },
};

const inventoryRecentEventOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "eventId",
    "codeResultId",
    "kind",
    "displayIdentity",
    "authoritativeVerdict",
    "terminalId",
    "terminalName",
    "scannedAt",
    "classification",
    "observedProductionDate",
  ],
  properties: {
    eventId: uuidSchema,
    codeResultId: { ...uuidSchema, nullable: true },
    kind: { type: "string", enum: ["item", "known_box", "old_box"] },
    displayIdentity: { type: "string" },
    authoritativeVerdict: { type: "string" },
    terminalId: uuidSchema,
    terminalName: { type: "string" },
    scannedAt: dateTimeSchema,
    classification: {
      type: "string",
      enum: ["expected", "protected", "ineligible", "unknown", "voided"],
      nullable: true,
    },
    observedProductionDate: { ...dateSchema, nullable: true },
  },
};

const inventoryEvidenceEventOpenApiSchema: SchemaObject = {
  ...inventoryRecentEventOpenApiSchema,
  required: [
    ...(inventoryRecentEventOpenApiSchema.required ?? []),
    "copyIdentity",
    "affectedCodeCount",
    "discrepancyCodeCount",
    "classifications",
    "discrepancyCategories",
    "actions",
  ],
  properties: {
    ...inventoryRecentEventOpenApiSchema.properties,
    copyIdentity: { type: "string", nullable: true },
    affectedCodeCount: { type: "integer", minimum: 0 },
    discrepancyCodeCount: { type: "integer", minimum: 0 },
    classifications: {
      type: "array",
      items: {
        type: "string",
        enum: ["expected", "protected", "ineligible", "unknown", "voided"],
      },
      uniqueItems: true,
    },
    discrepancyCategories: {
      type: "array",
      items: {
        type: "string",
        enum: ["ineligible", "unknown", "date_mismatch"],
      },
      uniqueItems: true,
    },
    actions: {
      type: "array",
      items: {
        type: "string",
        enum: ["void_scan", "restore_scan", "change_date", "remove_item"],
      },
      uniqueItems: true,
    },
  },
};

export const listInventoryEvidenceOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "page",
    "pageSize",
    "total",
    "hasMore",
    "allMatchingActions",
    "allMatchingAffectedCodeCount",
    "items",
  ],
  properties: {
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100 },
    total: { type: "integer", minimum: 0 },
    hasMore: { type: "boolean" },
    allMatchingActions: {
      type: "array",
      items: {
        type: "string",
        enum: ["void_scan", "restore_scan", "change_date", "remove_item"],
      },
      uniqueItems: true,
    },
    allMatchingAffectedCodeCount: { type: "integer", minimum: 0 },
    items: { type: "array", items: inventoryEvidenceEventOpenApiSchema },
  },
};

export const inventoryProgressOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "inventoryId",
    "snapshotId",
    "status",
    "resultRevision",
    ...Object.keys(inventoryCountProperties),
    "boxesTruncated",
    "verifiedBoxesTruncated",
    "participants",
    "boxes",
    "verifiedBoxes",
    "recentEvents",
  ],
  properties: {
    inventoryId: uuidSchema,
    snapshotId: uuidSchema,
    status: { type: "string", enum: [...INVENTORY_LIFECYCLE_STATUSES] },
    resultRevision: { type: "integer", minimum: 0 },
    ...inventoryCountProperties,
    boxesTruncated: { type: "boolean" },
    verifiedBoxesTruncated: { type: "boolean" },
    participants: { type: "array", items: inventoryParticipantOpenApiSchema },
    boxes: { type: "array", items: inventoryLiveBoxOpenApiSchema },
    verifiedBoxes: { type: "array", items: inventoryVerifiedBoxOpenApiSchema },
    recentEvents: { type: "array", items: inventoryRecentEventOpenApiSchema },
  },
};

const inventoryDiscrepancyWinnerOpenApiSchema: SchemaObject = {
  type: "object",
  nullable: true,
  additionalProperties: false,
  required: ["terminalId", "terminalName", "scannedAt"],
  properties: {
    terminalId: uuidSchema,
    terminalName: { type: "string" },
    scannedAt: dateTimeSchema,
  },
};

const inventoryDiscrepancyOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "category",
    "displayIdentity",
    "codeHash",
    "sscc",
    "found",
    "sourceStatus",
    "sourceProductionDate",
    "observedProductionDate",
    "winner",
  ],
  properties: {
    category: { type: "string", enum: [...INVENTORY_DISCREPANCY_CATEGORIES] },
    displayIdentity: { type: "string" },
    codeHash: { type: "string", pattern: "^[0-9a-f]{64}$", nullable: true },
    sscc: { type: "string", pattern: "^[0-9]{18}$", nullable: true },
    found: { type: "boolean" },
    sourceStatus: { type: "string", enum: [...INVENTORY_CHZ_STATUSES], nullable: true },
    sourceProductionDate: { ...dateSchema, nullable: true },
    observedProductionDate: { ...dateSchema, nullable: true },
    winner: inventoryDiscrepancyWinnerOpenApiSchema,
  },
};

export const listInventoryDiscrepanciesOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["page", "pageSize", "total", "hasMore", "items"],
  properties: {
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100 },
    total: { type: "integer", minimum: 0 },
    hasMore: { type: "boolean" },
    items: { type: "array", items: inventoryDiscrepancyOpenApiSchema },
  },
};

import { z } from "zod";

import { parseLabelTemplate } from "@markiro/domain";

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
  "running",
  "closed",
  "completed",
]);

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
  participants: z.array(inventoryParticipantSchema),
  boxes: z.array(inventoryLiveBoxSchema),
  recentEvents: z.array(inventoryRecentEventSchema),
});

export const INVENTORY_CORRECTION_ACTIONS = [
  "void_scan",
  "restore_scan",
  "change_date",
  "remove_item",
  "invalidate_box",
  "reprint",
] as const;

const inventoryCorrectionTargetSchema = z
  .strictObject({
    eventId: uuid.optional(),
    codeResultId: uuid.optional(),
    repackBoxId: uuid.optional(),
  })
  .refine((target) => Object.values(target).filter(Boolean).length === 1, {
    message: "exactly one correction target is required",
  });

export const createInventoryCorrectionInputSchema = z
  .strictObject({
    action: z.enum(INVENTORY_CORRECTION_ACTIONS),
    target: inventoryCorrectionTargetSchema,
    reason: z.string().trim().min(1).max(1024),
    expectedResultRevision: nonnegativeInteger,
    idempotencyKey: uuid,
    observedProductionDate: civilDate.optional(),
  })
  .superRefine((input, context) => {
    const targetMatches =
      ((input.action === "void_scan" || input.action === "restore_scan") &&
        input.target.eventId !== undefined) ||
      ((input.action === "change_date" || input.action === "remove_item") &&
        input.target.codeResultId !== undefined) ||
      ((input.action === "invalidate_box" || input.action === "reprint") &&
        input.target.repackBoxId !== undefined);
    if (!targetMatches) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "target does not match action",
      });
    }
    if ((input.action === "change_date") !== (input.observedProductionDate !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["observedProductionDate"],
        message: "observedProductionDate is required only for change_date",
      });
    }
  });

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
export type InventoryParticipant = z.infer<typeof inventoryParticipantSchema>;
export type InventoryLiveBox = z.infer<typeof inventoryLiveBoxSchema>;
export type InventoryRecentEvent = z.infer<typeof inventoryRecentEventSchema>;
export type CreateInventoryCorrectionInput = z.infer<typeof createInventoryCorrectionInputSchema>;
export type InventoryCorrection = z.infer<typeof inventoryCorrectionSchema>;

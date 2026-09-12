import { z } from "zod";
import { platformTimestampSchema, platformUuidSchema } from "./primitives.js";

const positiveRevisionSchema = z.number().int().positive();
const nonnegativeCountSchema = z.number().int().nonnegative();
const deviceReplacementNameSchema = z.string().trim().min(1).max(200);
const deviceReplacementKindSchema = z.enum(["station", "handheld"]);

export const deviceReplacementTargetSchema = z
  .object({
    name: deviceReplacementNameSchema,
    kind: deviceReplacementKindSchema,
  })
  .strict();

export const deviceReplacementPreviewRequestSchema = z
  .object({
    requestId: platformUuidSchema,
    target: deviceReplacementTargetSchema,
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const deviceReplacementConfirmSchema = z
  .object({
    requestId: platformUuidSchema,
    previewId: platformUuidSchema,
  })
  .strict();

export const deviceReplacementCancelSchema = z
  .object({
    requestId: platformUuidSchema,
    expectedRevision: positiveRevisionSchema,
  })
  .strict();

const replacementSourceSchema = z
  .object({
    deviceId: platformUuidSchema,
    name: deviceReplacementNameSchema,
    kind: deviceReplacementKindSchema,
    lineId: platformUuidSchema.nullable(),
    assignmentId: platformUuidSchema,
    revision: positiveRevisionSchema,
    state: z.enum(["assigned", "released"]),
    slotOccupied: z.boolean(),
    pairedAt: platformTimestampSchema.nullable(),
    lastSeenAt: platformTimestampSchema.nullable(),
    revokedAt: platformTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.state === "released" && source.slotOccupied) {
      context.addIssue({
        code: "custom",
        path: ["slotOccupied"],
        message: "A released source cannot occupy a slot",
      });
    }
    if (source.state === "assigned" && !source.slotOccupied) {
      context.addIssue({
        code: "custom",
        path: ["slotOccupied"],
        message: "An assigned source must occupy a slot",
      });
    }
  });

const fixedUnavailableReasons = [
  "transfer_not_available",
  "local_data_unknown",
  "source_authority_transition_required",
] as const;

const unavailableReasonSchema = z.enum([
  ...fixedUnavailableReasons,
  "handheld_unavailable",
  "capacity_unavailable",
  "lifecycle_policy_not_ready",
]);

const replacementExecutionSchema = z
  .object({
    available: z.literal(false),
    reasons: z
      .array(unavailableReasonSchema)
      .min(fixedUnavailableReasons.length)
      .max(unavailableReasonSchema.options.length)
      .refine((reasons) => new Set(reasons).size === reasons.length, "Reasons must be unique")
      .refine(
        (reasons) => fixedUnavailableReasons.every((reason) => reasons.includes(reason)),
        "Every replacement must state the fixed unavailable reasons",
      ),
  })
  .strict();

export const deviceReplacementObservationSchema = z
  .object({
    source: replacementSourceSchema,
    target: deviceReplacementTargetSchema,
    usage: nonnegativeCountSchema,
    limit: nonnegativeCountSchema.nullable(),
    preparationSlotDelta: z.literal(0),
    expectedTransferSlotDelta: z.union([z.literal(0), z.literal(1)]),
    knownServerWork: z
      .object({
        activeShifts: nonnegativeCountSchema,
        activeInventories: nonnegativeCountSchema,
        printJobs: nonnegativeCountSchema,
        quarantineBatches: nonnegativeCountSchema,
      })
      .strict(),
    localData: z
      .object({
        journals: z.literal("unknown"),
        outbox: z.literal("unknown"),
        printWork: z.literal("unknown"),
      })
      .strict(),
    execution: replacementExecutionSchema,
  })
  .strict()
  .superRefine((observation, context) => {
    const expectedDelta = observation.source.slotOccupied ? 0 : 1;
    if (observation.expectedTransferSlotDelta !== expectedDelta) {
      context.addIssue({
        code: "custom",
        path: ["expectedTransferSlotDelta"],
        message: "Expected transfer delta must match source occupancy",
      });
    }
  });

export const deviceReplacementPreviewSchema = z
  .object({
    id: platformUuidSchema,
    requestId: platformUuidSchema,
    sourceDeviceId: platformUuidSchema,
    createdAt: platformTimestampSchema,
    expiresAt: platformTimestampSchema,
    observation: deviceReplacementObservationSchema,
  })
  .strict()
  .superRefine((preview, context) => {
    const previewDuration = Date.parse(preview.expiresAt) - Date.parse(preview.createdAt);
    if (previewDuration <= 0 || previewDuration > 5 * 60 * 1_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Preview expiry must be within five minutes after creation",
      });
    }
    if (preview.sourceDeviceId !== preview.observation.source.deviceId) {
      context.addIssue({
        code: "custom",
        path: ["sourceDeviceId"],
        message: "Preview source must match its observation",
      });
    }
  });

export const deviceReplacementPreparationSchema = z
  .object({
    id: platformUuidSchema,
    sourceDeviceId: platformUuidSchema,
    revision: positiveRevisionSchema,
    state: z.enum(["prepared", "cancelled"]),
    preparedAt: platformTimestampSchema,
    cancelledAt: platformTimestampSchema.nullable(),
    observation: deviceReplacementObservationSchema,
  })
  .strict()
  .superRefine((preparation, context) => {
    if (preparation.sourceDeviceId !== preparation.observation.source.deviceId) {
      context.addIssue({
        code: "custom",
        path: ["sourceDeviceId"],
        message: "Preparation source must match its observation",
      });
    }
    if (preparation.state === "prepared" && preparation.cancelledAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["cancelledAt"],
        message: "A prepared replacement cannot have a cancellation timestamp",
      });
    }
    if (preparation.state === "cancelled" && preparation.cancelledAt === null) {
      context.addIssue({
        code: "custom",
        path: ["cancelledAt"],
        message: "A cancelled replacement requires a cancellation timestamp",
      });
    }
    if (
      preparation.cancelledAt !== null &&
      Date.parse(preparation.cancelledAt) < Date.parse(preparation.preparedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["cancelledAt"],
        message: "Cancellation cannot precede preparation",
      });
    }
  });

export const deviceReplacementReceiptSchema = z
  .object({
    requestId: platformUuidSchema,
    preparation: deviceReplacementPreparationSchema,
  })
  .strict();

export const deviceReplacementListSchema = z
  .object({
    canPrepare: z.boolean(),
    items: z.array(
      z
        .object({
          preparation: deviceReplacementPreparationSchema,
          needsReview: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export type DeviceReplacementTarget = z.output<typeof deviceReplacementTargetSchema>;
export type DeviceReplacementPreviewRequest = z.output<
  typeof deviceReplacementPreviewRequestSchema
>;
export type DeviceReplacementConfirm = z.output<typeof deviceReplacementConfirmSchema>;
export type DeviceReplacementCancel = z.output<typeof deviceReplacementCancelSchema>;
export type DeviceReplacementObservation = z.output<typeof deviceReplacementObservationSchema>;
export type DeviceReplacementPreview = z.output<typeof deviceReplacementPreviewSchema>;
export type DeviceReplacementPreparation = z.output<typeof deviceReplacementPreparationSchema>;
export type DeviceReplacementReceipt = z.output<typeof deviceReplacementReceiptSchema>;
export type DeviceReplacementList = z.output<typeof deviceReplacementListSchema>;

export const cabinetDeviceReplacementContracts = {
  list: {
    method: "GET",
    path: "/device-licensing/replacements",
    response: deviceReplacementListSchema,
  },
  preview: {
    method: "POST",
    path: "/device-licensing/:deviceId/replacements/preview",
    status: 200,
    body: deviceReplacementPreviewRequestSchema,
    response: deviceReplacementPreviewSchema,
  },
  confirm: {
    method: "POST",
    path: "/device-licensing/:deviceId/replacements/confirm",
    status: 200,
    body: deviceReplacementConfirmSchema,
    response: deviceReplacementReceiptSchema,
  },
  cancel: {
    method: "POST",
    path: "/device-licensing/replacements/:preparationId/cancel",
    status: 200,
    body: deviceReplacementCancelSchema,
    response: deviceReplacementReceiptSchema,
  },
} as const;

export const platformDeviceReplacementContracts = {
  list: {
    method: "GET",
    path: "/platform/tenants/:tenantId/device-licensing/replacements",
    response: deviceReplacementListSchema,
  },
  preview: {
    method: "POST",
    path: "/platform/tenants/:tenantId/device-licensing/:deviceId/replacements/preview",
    status: 200,
    body: deviceReplacementPreviewRequestSchema,
    response: deviceReplacementPreviewSchema,
  },
  confirm: {
    method: "POST",
    path: "/platform/tenants/:tenantId/device-licensing/:deviceId/replacements/confirm",
    status: 200,
    body: deviceReplacementConfirmSchema,
    response: deviceReplacementReceiptSchema,
  },
  cancel: {
    method: "POST",
    path: "/platform/tenants/:tenantId/device-licensing/replacements/:preparationId/cancel",
    status: 200,
    body: deviceReplacementCancelSchema,
    response: deviceReplacementReceiptSchema,
  },
} as const;

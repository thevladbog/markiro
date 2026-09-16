import { z } from "zod";
import { platformTimestampSchema, platformUuidSchema } from "./primitives.js";

const positiveRevisionSchema = z.number().int().positive();
const nonnegativeCountSchema = z.number().int().nonnegative();
const positiveEpochSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const boundedTextSchema = z.string().trim().min(1).max(1_000);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const oneTimePairingCodeSchema = z.string().regex(/^\d{8}$/);
const deviceReplacementNameSchema = z.string().trim().min(1).max(200);
const deviceReplacementKindSchema = z.enum(["station", "handheld"]);
export const deviceReplacementPreparationStateSchema = z.enum([
  "prepared",
  "draining",
  "ready",
  "executing",
  "completed",
  "cancelled",
]);

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
    available: z.boolean(),
    reasons: z
      .array(unavailableReasonSchema)
      .max(unavailableReasonSchema.options.length)
      .refine((reasons) => new Set(reasons).size === reasons.length, "Reasons must be unique"),
  })
  .strict()
  .superRefine((execution, context) => {
    if (execution.available && execution.reasons.length !== 0)
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "An available replacement cannot have unavailable reasons",
      });
    if (
      !execution.available &&
      !fixedUnavailableReasons.every((reason) => execution.reasons.includes(reason))
    )
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "Every unavailable replacement must state the fixed unavailable reasons",
      });
  });

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

const deviceReplacementReadinessProjectionSchema = z
  .object({
    intentId: platformUuidSchema,
    credentialEpoch: positiveEpochSchema,
    receivedAt: platformTimestampSchema.nullable(),
    eligibility: z.discriminatedUnion("status", [
      z.object({ status: z.literal("eligible"), reasons: z.tuple([]) }).strict(),
      z
        .object({
          status: z.literal("blocked"),
          reasons: z.array(z.string().trim().min(1).max(128)).min(1).max(32),
        })
        .strict(),
    ]),
  })
  .strict();

const deviceReplacementRecoveryStateSchema = z.enum([
  "not_required",
  "required",
  "draining",
  "completed",
  "evidence_unavailable",
]);

const deviceReplacementExecutionProjectionSchema = z
  .object({
    mode: z.enum(["normal", "emergency"]),
    targetDeviceId: platformUuidSchema,
    executedAt: platformTimestampSchema,
    newWorkAllowedAt: platformTimestampSchema,
    recoveryState: deviceReplacementRecoveryStateSchema,
  })
  .strict();

const deviceReplacementRecoveryProjectionSchema = z
  .object({
    state: deviceReplacementRecoveryStateSchema,
    closedAt: platformTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((recovery, context) => {
    if (recovery.state === "completed" || recovery.state === "evidence_unavailable") {
      if (recovery.closedAt === null)
        context.addIssue({
          code: "custom",
          path: ["closedAt"],
          message: "A closed recovery state requires a close timestamp",
        });
    } else if (recovery.closedAt !== null)
      context.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "An open recovery state cannot have a close timestamp",
      });
  });

export const deviceReplacementPreparationSchema = z
  .object({
    id: platformUuidSchema,
    sourceDeviceId: platformUuidSchema,
    revision: positiveRevisionSchema,
    state: deviceReplacementPreparationStateSchema,
    preparedAt: platformTimestampSchema,
    cancelledAt: platformTimestampSchema.nullable(),
    observation: deviceReplacementObservationSchema,
    execution: deviceReplacementExecutionProjectionSchema.nullable().optional(),
    readiness: deviceReplacementReadinessProjectionSchema.nullable().optional(),
    recovery: deviceReplacementRecoveryProjectionSchema.nullable().optional(),
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
    if (preparation.state !== "cancelled" && preparation.cancelledAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["cancelledAt"],
        message: "Only a cancelled replacement can have a cancellation timestamp",
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
    if (preparation.state === "completed" && !preparation.execution) {
      context.addIssue({
        code: "custom",
        path: ["execution"],
        message: "A completed replacement requires an execution projection",
      });
    }
    if (
      (preparation.state === "draining" || preparation.state === "ready") &&
      !preparation.readiness
    ) {
      context.addIssue({
        code: "custom",
        path: ["readiness"],
        message: "An active drain requires a readiness projection",
      });
    }
    if (preparation.state === "executing" && !preparation.execution) {
      context.addIssue({
        code: "custom",
        path: ["execution"],
        message: "An executing replacement requires an execution projection",
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

const deviceReplacementRevisionRequestShape = {
  requestId: platformUuidSchema,
  expectedRevision: positiveRevisionSchema,
} as const;

export const deviceReplacementDrainRequestSchema = z
  .object(deviceReplacementRevisionRequestShape)
  .strict();

export const deviceReplacementExecutionPreviewRequestSchema = z
  .object(deviceReplacementRevisionRequestShape)
  .strict();

export const deviceReplacementExecuteRequestSchema = z.discriminatedUnion("mode", [
  z
    .object({
      ...deviceReplacementRevisionRequestShape,
      previewId: platformUuidSchema,
      mode: z.literal("normal"),
    })
    .strict(),
  z
    .object({
      ...deviceReplacementRevisionRequestShape,
      previewId: platformUuidSchema,
      mode: z.literal("emergency"),
    })
    .strict(),
]);

export const deviceReplacementEmergencyPreviewRequestSchema = z
  .object({ ...deviceReplacementRevisionRequestShape, reason: boundedTextSchema })
  .strict();

export const deviceReplacementRecoveryCodeRequestSchema = z
  .object(deviceReplacementRevisionRequestShape)
  .strict();

export const deviceReplacementRecoveryCloseRequestSchema = z
  .object({ ...deviceReplacementRevisionRequestShape, reason: boundedTextSchema })
  .strict();

const deviceReplacementEligibilityReasonSchema = z.enum([
  "pending_scans",
  "pending_inventories",
  "pending_shift_closures",
  "pending_product_labels",
  "pending_boxes",
  "pending_exceptions",
  "conflicts",
  "unknown_prints",
  "active_tasks",
  "installed_grants",
  "client_upgrade_required",
  "credential_epoch_mismatch",
  "facts_changed",
  "report_stale",
]);

const deviceReplacementReadinessChannelSchema = z.enum([
  "scans",
  "inventories",
  "shiftClosures",
  "productLabels",
  "boxes",
  "exceptions",
  "conflicts",
  "unknownPrints",
]);
const deviceReplacementReadinessMeasurementSchema = z.union([
  nonnegativeCountSchema,
  z.literal("unsupported"),
]);

export const deviceReplacementReadinessEligibilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("eligible"), reasons: z.tuple([]) }).strict(),
  z
    .object({
      status: z.literal("blocked"),
      reasons: z
        .array(deviceReplacementEligibilityReasonSchema)
        .min(1)
        .max(deviceReplacementEligibilityReasonSchema.options.length)
        .refine((reasons) => new Set(reasons).size === reasons.length, "Reasons must be unique"),
    })
    .strict(),
]);

const deviceReplacementActiveTaskSchema = z
  .object({
    taskId: platformUuidSchema,
    kind: z.enum(["shift", "inventory"]),
  })
  .strict();

const deviceReplacementInstalledGrantSchema = z
  .object({
    grantId: platformUuidSchema,
  })
  .strict();

const deviceReplacementPendingSchema = z
  .object({
    scans: deviceReplacementReadinessMeasurementSchema,
    inventories: deviceReplacementReadinessMeasurementSchema,
    shiftClosures: deviceReplacementReadinessMeasurementSchema,
    productLabels: deviceReplacementReadinessMeasurementSchema,
    boxes: deviceReplacementReadinessMeasurementSchema,
    exceptions: deviceReplacementReadinessMeasurementSchema,
  })
  .strict();

export const deviceReplacementReadinessRequestSchema = z
  .object({
    requestId: platformUuidSchema,
    intentId: platformUuidSchema,
    credentialEpoch: positiveEpochSchema,
    reportSequence: nonnegativeCountSchema,
    clientBuild: z.string().trim().min(1).max(100),
    storageRevision: positiveEpochSchema,
    pending: deviceReplacementPendingSchema,
    conflicts: deviceReplacementReadinessMeasurementSchema,
    unknownPrints: deviceReplacementReadinessMeasurementSchema,
    activeTasks: z
      .array(deviceReplacementActiveTaskSchema)
      .max(1_000)
      .refine(
        (tasks) =>
          new Set(tasks.map((task) => `${task.kind}:${task.taskId}`)).size === tasks.length,
        "Active tasks must be unique",
      ),
    installedGrants: z
      .array(deviceReplacementInstalledGrantSchema)
      .max(1_000)
      .refine(
        (grants) => new Set(grants.map((grant) => grant.grantId)).size === grants.length,
        "Installed grants must be unique",
      ),
    journal: z.object({ digest: digestSchema, highestSequence: nonnegativeCountSchema }).strict(),
  })
  .strict();

export const deviceReplacementReadinessResponseSchema = z
  .object({
    requestId: platformUuidSchema,
    intentId: platformUuidSchema,
    receivedAt: platformTimestampSchema,
    unsupportedChannels: z
      .array(deviceReplacementReadinessChannelSchema)
      .max(deviceReplacementReadinessChannelSchema.options.length)
      .refine(
        (channels) => new Set(channels).size === channels.length,
        "Unsupported channels must be unique",
      ),
    eligibility: deviceReplacementReadinessEligibilitySchema,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.unsupportedChannels.length === 0) return;
    if (response.eligibility.status === "eligible") {
      context.addIssue({
        code: "custom",
        path: ["eligibility"],
        message: "Unsupported required channels block readiness",
      });
      return;
    }
    if (!response.eligibility.reasons.includes("client_upgrade_required"))
      context.addIssue({
        code: "custom",
        path: ["eligibility", "reasons"],
        message: "Unsupported required channels require a client upgrade reason",
      });
  });

export const deviceReplacementExecutionPreviewSchema = z.discriminatedUnion("mode", [
  z
    .object({
      id: platformUuidSchema,
      requestId: platformUuidSchema,
      preparationId: platformUuidSchema,
      expectedRevision: positiveRevisionSchema,
      mode: z.literal("normal"),
      asOf: platformTimestampSchema,
      expiresAt: platformTimestampSchema,
      digest: digestSchema,
      newWorkAllowedAt: platformTimestampSchema,
    })
    .strict(),
  z
    .object({
      id: platformUuidSchema,
      requestId: platformUuidSchema,
      preparationId: platformUuidSchema,
      expectedRevision: positiveRevisionSchema,
      mode: z.literal("emergency"),
      asOf: platformTimestampSchema,
      expiresAt: platformTimestampSchema,
      digest: digestSchema,
      newWorkAllowedAt: platformTimestampSchema,
    })
    .strict(),
]);

export const deviceReplacementDrainResponseSchema = deviceReplacementReceiptSchema;
export const deviceReplacementExecutionPreviewResponseSchema =
  deviceReplacementExecutionPreviewSchema;
export const deviceReplacementExecuteResponseSchema = deviceReplacementReceiptSchema;
export const deviceReplacementEmergencyPreviewResponseSchema =
  deviceReplacementExecutionPreviewSchema;
export const deviceReplacementRecoveryCodeResponseSchema = z
  .object({
    requestId: platformUuidSchema,
    preparation: deviceReplacementPreparationSchema,
    code: oneTimePairingCodeSchema,
    expiresAt: platformTimestampSchema,
  })
  .strict();
export const deviceReplacementRecoveryCloseResponseSchema = deviceReplacementReceiptSchema;

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
export type DeviceReplacementDrainRequest = z.output<typeof deviceReplacementDrainRequestSchema>;
export type DeviceReplacementExecutionPreviewRequest = z.output<
  typeof deviceReplacementExecutionPreviewRequestSchema
>;
export type DeviceReplacementExecuteRequest = z.output<
  typeof deviceReplacementExecuteRequestSchema
>;
export type DeviceReplacementEmergencyPreviewRequest = z.output<
  typeof deviceReplacementEmergencyPreviewRequestSchema
>;
export type DeviceReplacementRecoveryCodeRequest = z.output<
  typeof deviceReplacementRecoveryCodeRequestSchema
>;
export type DeviceReplacementRecoveryCodeResponse = z.output<
  typeof deviceReplacementRecoveryCodeResponseSchema
>;
export type DeviceReplacementRecoveryCloseRequest = z.output<
  typeof deviceReplacementRecoveryCloseRequestSchema
>;
export type DeviceReplacementReadinessRequest = z.output<
  typeof deviceReplacementReadinessRequestSchema
>;
export type DeviceReplacementReadinessResponse = z.output<
  typeof deviceReplacementReadinessResponseSchema
>;

export const cabinetDeviceReplacementContracts = {
  drain: {
    method: "POST",
    path: "/device-licensing/replacements/:preparationId/drain",
    status: 200,
    body: deviceReplacementDrainRequestSchema,
    response: deviceReplacementDrainResponseSchema,
  },
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
  drain: {
    method: "POST",
    path: "/platform/tenants/:tenantId/device-licensing/replacements/:preparationId/drain",
    status: 200,
    body: deviceReplacementDrainRequestSchema,
    response: deviceReplacementDrainResponseSchema,
  },
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

/** Null means this authenticated source has no current drain; response is always HTTP 200. */
export const deviceReplacementCurrentIntentResponseSchema = z
  .object({
    intentId: platformUuidSchema,
    preparationId: platformUuidSchema,
    credentialEpoch: positiveEpochSchema,
    preparationRevision: positiveRevisionSchema,
    requestedAt: platformTimestampSchema,
    expiresAt: platformTimestampSchema,
  })
  .strict()
  .refine(
    (intent) => Date.parse(intent.expiresAt) > Date.parse(intent.requestedAt),
    "Intent expiry must follow its request",
  )
  .nullable();
export type DeviceReplacementCurrentIntentResponse = z.output<
  typeof deviceReplacementCurrentIntentResponseSchema
>;

/** Only an explicit newer closure for the saved intent can release a native drain. */
export const deviceReplacementIntentClosureSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(["cancelled", "closed"]),
    intentId: platformUuidSchema,
    preparationId: platformUuidSchema,
    credentialEpoch: positiveEpochSchema,
    preparationRevision: positiveRevisionSchema,
    closedAt: platformTimestampSchema,
  })
  .strict();
export type DeviceReplacementIntentClosure = z.output<typeof deviceReplacementIntentClosureSchema>;
export const deviceReplacementIntentProjectionSchema = z.union([
  z.object({ version: z.literal(1), state: z.literal("none") }).strict(),
  z
    .object({
      version: z.literal(1),
      state: z.literal("active"),
      intent: deviceReplacementCurrentIntentResponseSchema.unwrap(),
    })
    .strict(),
  deviceReplacementIntentClosureSchema,
]);
export type DeviceReplacementIntentProjection = z.output<
  typeof deviceReplacementIntentProjectionSchema
>;
export const deviceReplacementIntentProjectionQuerySchema = z
  .object({ knownIntentId: platformUuidSchema.optional() })
  .strict();
export const deviceReplacementClosureAcknowledgementRequestSchema = z
  .object({ requestId: platformUuidSchema, tombstone: deviceReplacementIntentClosureSchema })
  .strict();
export type DeviceReplacementClosureAcknowledgementRequest = z.output<
  typeof deviceReplacementClosureAcknowledgementRequestSchema
>;
export const deviceReplacementClosureAcknowledgementResponseSchema = z
  .object({
    requestId: platformUuidSchema,
    tombstone: deviceReplacementIntentClosureSchema,
    acknowledgedAt: platformTimestampSchema,
  })
  .strict();
export type DeviceReplacementClosureAcknowledgementResponse = z.output<
  typeof deviceReplacementClosureAcknowledgementResponseSchema
>;

export const stationDeviceReplacementContracts = {
  currentIntentV1: {
    method: "GET",
    path: "/station/device-replacement-intent/v1",
    query: deviceReplacementIntentProjectionQuerySchema,
    response: deviceReplacementIntentProjectionSchema,
  },
  acknowledgeClosure: {
    method: "POST",
    path: "/station/device-replacement-intent/v1/acknowledge",
    status: 200,
    body: deviceReplacementClosureAcknowledgementRequestSchema,
    response: deviceReplacementClosureAcknowledgementResponseSchema,
  },
  currentIntent: {
    method: "GET",
    path: "/station/device-replacement-intent",
    response: deviceReplacementCurrentIntentResponseSchema,
  },
  report: {
    method: "POST",
    path: "/station/device-replacement-readiness",
    status: 200,
    body: deviceReplacementReadinessRequestSchema,
    response: deviceReplacementReadinessResponseSchema,
  },
} as const;

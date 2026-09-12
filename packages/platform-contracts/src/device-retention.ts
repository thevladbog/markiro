import { z } from "zod";
import { entitlementSnapshotV1Schema } from "./entitlements.js";
import { platformTimestampSchema, platformUuidSchema } from "./primitives.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(2_147_483_647);
const deviceIds = z
  .array(platformUuidSchema)
  .refine((ids) => new Set(ids).size === ids.length, "Device IDs must be unique");
export const deviceRetentionDeviceReasonSchema = z.enum([
  "device_inconsistent",
  "device_released",
  "handheld_unavailable",
]);
export const deviceRetentionExecutionReasonSchema = z.enum([
  "enforcement_not_enabled",
  "local_data_unknown",
  "lifecycle_policy_not_ready",
  "capacity_unavailable",
  "handheld_unavailable",
]);
export const deviceRetentionServiceStatusSchema = z.enum([
  "ordered",
  "in_progress",
  "completed",
  "cancelled",
]);

export const deviceRetentionBoundarySchema = z
  .object({
    key: z.string().regex(/^[0-9a-f]{64}$/),
    effectiveAt: platformTimestampSchema,
  })
  .strict();
export const deviceRetentionDeviceSchema = z
  .object({
    deviceId: platformUuidSchema,
    name: z.string().trim().min(1).max(200),
    kind: z.enum(["station", "handheld"]),
    assignmentId: platformUuidSchema,
    revision: revision.min(1),
    state: z.enum(["reserved", "assigned"]),
    eligible: z.boolean(),
    reasons: z
      .array(deviceRetentionDeviceReasonSchema)
      .refine((reasons) => new Set(reasons).size === reasons.length, "Reasons must be unique"),
    knownServerWork: z
      .object({
        activeShifts: count,
        activeInventories: count,
        printJobs: count,
        quarantineBatches: count,
      })
      .strict(),
    localData: z
      .object({
        journals: z.literal("unknown"),
        outbox: z.literal("unknown"),
        printWork: z.literal("unknown"),
      })
      .strict(),
  })
  .strict();
export const deviceRetentionObservationSchema = z
  .object({
    boundary: deviceRetentionBoundarySchema,
    current: entitlementSnapshotV1Schema,
    future: entitlementSnapshotV1Schema,
    devices: z
      .array(deviceRetentionDeviceSchema)
      .refine(
        (devices) => new Set(devices.map((device) => device.deviceId)).size === devices.length,
        "Observed device IDs must be unique",
      ),
    services: z.array(
      z
        .object({
          id: platformUuidSchema,
          nameRu: z.string().min(1).max(300),
          nameEn: z.string().min(1).max(300),
          quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          unit: z.string().min(1).max(100),
          status: deviceRetentionServiceStatusSchema,
        })
        .strict(),
    ),
    selectionRequired: z.boolean(),
    execution: z
      .object({
        available: z.literal(false),
        reasons: z
          .array(deviceRetentionExecutionReasonSchema)
          .refine((reasons) => new Set(reasons).size === reasons.length, "Reasons must be unique")
          .refine(
            (reasons) => reasons.includes("enforcement_not_enabled"),
            "Execution must state enforcement is not enabled",
          ),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.current.tenantId !== value.future.tenantId)
      context.addIssue({
        code: "custom",
        path: ["future", "tenantId"],
        message: "Snapshots must belong to the same tenant",
      });
    if (Date.parse(value.future.asOf) !== Date.parse(value.boundary.effectiveAt))
      context.addIssue({
        code: "custom",
        path: ["future", "asOf"],
        message: "Future snapshot must describe the boundary",
      });
    if (Date.parse(value.current.asOf) >= Date.parse(value.boundary.effectiveAt))
      context.addIssue({
        code: "custom",
        path: ["current", "asOf"],
        message: "Current snapshot must precede the boundary",
      });
  });
export const deviceRetentionPreviewRequestSchema = z
  .object({
    requestId: platformUuidSchema,
    boundaryKey: deviceRetentionBoundarySchema.shape.key,
    selectedDeviceIds: deviceIds,
    expectedRevision: revision,
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();
export const deviceRetentionConfirmSchema = z
  .object({ requestId: platformUuidSchema, previewId: platformUuidSchema })
  .strict();

function validateSelection(
  value: { selectedDeviceIds: string[]; observation: DeviceRetentionObservation },
  context: z.RefinementCtx,
): void {
  const devices = new Map(value.observation.devices.map((device) => [device.deviceId, device]));
  for (const [index, id] of value.selectedDeviceIds.entries()) {
    const device = devices.get(id);
    if (
      !device ||
      !device.eligible ||
      (device.kind === "handheld" && value.observation.future.candidate.features.handheld !== true)
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedDeviceIds", index],
        message: "Selected device must be present and eligible under future conditions",
      });
    }
  }
  const limit = value.observation.future.candidate.quotas.stations.limit;
  if (limit !== null && value.selectedDeviceIds.length > limit)
    context.addIssue({
      code: "custom",
      path: ["selectedDeviceIds"],
      message: "Selection exceeds future working-device capacity",
    });
}
export const deviceRetentionPreviewSchema = z
  .object({
    id: platformUuidSchema,
    requestId: platformUuidSchema,
    createdAt: platformTimestampSchema,
    expiresAt: platformTimestampSchema,
    expectedRevision: revision,
    selectedDeviceIds: deviceIds,
    observation: deviceRetentionObservationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateSelection(value, context);
    const created = Date.parse(value.createdAt);
    const expires = Date.parse(value.expiresAt);
    if (
      expires <= created ||
      expires - created > 5 * 60_000 ||
      expires > Date.parse(value.observation.boundary.effectiveAt)
    )
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Preview must expire within five minutes and no later than the boundary",
      });
    if (created < Date.parse(value.observation.current.asOf))
      context.addIssue({
        code: "custom",
        path: ["createdAt"],
        message: "Preview cannot predate its observation",
      });
  });
export const deviceRetentionSelectionSchema = z
  .object({
    id: platformUuidSchema,
    revision: revision.min(1),
    preparedAt: platformTimestampSchema,
    selectedDeviceIds: deviceIds,
    observation: deviceRetentionObservationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateSelection(value, context);
    const prepared = Date.parse(value.preparedAt);
    if (
      prepared < Date.parse(value.observation.current.asOf) ||
      prepared >= Date.parse(value.observation.boundary.effectiveAt)
    )
      context.addIssue({
        code: "custom",
        path: ["preparedAt"],
        message: "Selection must be prepared after observation and before the boundary",
      });
  });
export const deviceRetentionReceiptSchema = z
  .object({ requestId: platformUuidSchema, selection: deviceRetentionSelectionSchema })
  .strict();
export const deviceRetentionInspectionSchema = z
  .object({
    canSelect: z.boolean(),
    observation: deviceRetentionObservationSchema.nullable(),
    selections: z.array(
      z
        .object({
          selection: deviceRetentionSelectionSchema,
          needsReview: z.boolean(),
          boundaryReached: z.boolean(),
        })
        .strict(),
    ),
    currentShadow: z
      .object({
        awaitingSelection: z.boolean(),
        affectedDeviceIds: deviceIds,
        enforced: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type DeviceRetentionBoundary = z.output<typeof deviceRetentionBoundarySchema>;
export type DeviceRetentionDevice = z.output<typeof deviceRetentionDeviceSchema>;
export type DeviceRetentionObservation = z.output<typeof deviceRetentionObservationSchema>;
export type DeviceRetentionPreviewRequest = z.output<typeof deviceRetentionPreviewRequestSchema>;
export type DeviceRetentionConfirm = z.output<typeof deviceRetentionConfirmSchema>;
export type DeviceRetentionPreview = z.output<typeof deviceRetentionPreviewSchema>;
export type DeviceRetentionSelection = z.output<typeof deviceRetentionSelectionSchema>;
export type DeviceRetentionReceipt = z.output<typeof deviceRetentionReceiptSchema>;
export type DeviceRetentionInspection = z.output<typeof deviceRetentionInspectionSchema>;
export const cabinetDeviceRetentionContracts = {
  inspect: {
    method: "GET",
    path: "/device-licensing/retention",
    response: deviceRetentionInspectionSchema,
  },
  preview: {
    method: "POST",
    path: "/device-licensing/retention/preview",
    status: 200,
    body: deviceRetentionPreviewRequestSchema,
    response: deviceRetentionPreviewSchema,
  },
  confirm: {
    method: "POST",
    path: "/device-licensing/retention/confirm",
    status: 200,
    body: deviceRetentionConfirmSchema,
    response: deviceRetentionReceiptSchema,
  },
} as const;
export const platformDeviceRetentionContracts = {
  inspect: {
    ...cabinetDeviceRetentionContracts.inspect,
    path: "/platform/tenants/:tenantId/device-licensing/retention",
  },
  preview: {
    ...cabinetDeviceRetentionContracts.preview,
    path: "/platform/tenants/:tenantId/device-licensing/retention/preview",
  },
  confirm: {
    ...cabinetDeviceRetentionContracts.confirm,
    path: "/platform/tenants/:tenantId/device-licensing/retention/confirm",
  },
} as const;

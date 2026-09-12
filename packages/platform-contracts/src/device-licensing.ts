import { z } from "zod";
import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

const positiveRevisionSchema = z.number().int().positive();
const releaseReasonSchema = z.enum(["reservation_cancelled", "security_revoked"]);

const workingDeviceSchema = z
  .object({
    deviceId: platformUuidSchema,
    name: z.string(),
    kind: z.enum(["station", "handheld"]),
    assignmentId: platformUuidSchema.nullable(),
    revision: positiveRevisionSchema.nullable(),
    state: z.enum(["reserved", "assigned", "released", "inconsistent"]),
    releaseReason: releaseReasonSchema.nullable(),
    slotOccupied: z.boolean(),
    canCancel: z.boolean(),
    blockedReason: z
      .enum(["already_paired", "released", "inconsistent", "production_evidence"])
      .nullable(),
    connectionStatus: z.enum(["awaiting_pairing", "online", "offline", "revoked"]),
    pairedAt: platformTimestampSchema.nullable(),
    lastSeenAt: platformTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((device, context) => {
    if (device.state !== "released") return;
    if (device.assignmentId === null) {
      context.addIssue({
        code: "custom",
        path: ["assignmentId"],
        message: "Released assignment ID is required",
      });
    }
    if (device.revision === null) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "Released assignment revision is required",
      });
    }
    if (device.releaseReason === null) {
      context.addIssue({
        code: "custom",
        path: ["releaseReason"],
        message: "Released assignment reason is required",
      });
    }
  });

export const workingDevicePoolSchema = z
  .object({
    tenantId: platformTenantIdSchema,
    usage: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative().nullable(),
    canCancelReservations: z.boolean(),
    integrity: z.enum(["ready", "inconsistent"]),
    devices: z.array(workingDeviceSchema),
  })
  .strict();

export const cancelDeviceReservationSchema = z
  .object({
    requestId: platformUuidSchema,
    expectedRevision: positiveRevisionSchema,
  })
  .strict();

export const deviceReservationReceiptSchema = z
  .object({
    requestId: platformUuidSchema,
    deviceId: platformUuidSchema,
    assignmentId: platformUuidSchema,
    revision: positiveRevisionSchema,
    state: z.literal("released"),
    releaseReason: z.literal("reservation_cancelled"),
    releasedAt: platformTimestampSchema,
  })
  .strict();

export type WorkingDevicePool = z.infer<typeof workingDevicePoolSchema>;
export type CancelDeviceReservation = z.infer<typeof cancelDeviceReservationSchema>;
export type DeviceReservationReceipt = z.infer<typeof deviceReservationReceiptSchema>;

export const cabinetDeviceLicensingContracts = {
  inspect: {
    method: "GET",
    path: "/device-licensing",
    response: workingDevicePoolSchema,
  },
  cancelReservation: {
    method: "POST",
    path: "/device-licensing/:deviceId/cancel-reservation",
    body: cancelDeviceReservationSchema,
    response: deviceReservationReceiptSchema,
  },
} as const;

export const platformDeviceLicensingContracts = {
  inspect: {
    method: "GET",
    path: "/platform/tenants/:tenantId/device-licensing",
    response: workingDevicePoolSchema,
  },
  cancelReservation: {
    method: "POST",
    path: "/platform/tenants/:tenantId/device-licensing/:deviceId/cancel-reservation",
    body: cancelDeviceReservationSchema,
    response: deviceReservationReceiptSchema,
  },
} as const;

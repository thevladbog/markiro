import { z } from "zod";

import { offlineGrantPolicyRecordSchema } from "./offline-grant-policies.js";
import { grantReadinessReasonSchema } from "./offline-grant-readiness.js";
import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";
import { platformRoleSchema } from "./platform-auth.js";

const protocolSchema = z.literal("offline-grants-activation-v1");
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const opaqueCursorSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[A-Za-z0-9_-]+$/);
const uniqueDeviceIdsSchema = z
  .array(platformUuidSchema)
  .min(1)
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Device IDs must be unique",
  });

export const grantActivationStateSchema = z.enum([
  "prepared",
  "confirmed",
  "cancelled",
  "expired",
  "needs_review",
]);

const grantActivationActorSchema = z
  .object({ userId: z.string().min(1).max(128), role: platformRoleSchema })
  .strict();

const grantActivationBasePolicySchema = z
  .object({
    id: platformUuidSchema,
    policyKey: z.string().trim().min(1).max(100),
    version: z.number().int().positive(),
    payloadHash: digestSchema,
    revision: z.string().trim().min(1).max(512),
  })
  .strict();

export const grantActivationMemberSchema = z
  .object({
    tenantId: platformTenantIdSchema,
    tenantName: z.string().trim().min(1).max(300),
    subscriptionId: platformUuidSchema,
    deviceId: platformUuidSchema,
    deviceKind: z.enum(["station", "handheld", "kiosk"]),
    deviceName: z.string().trim().min(1).max(300),
    credentialEpoch: z.number().int().nonnegative().max(2_147_483_647),
    assignmentId: platformUuidSchema.nullable(),
    configurationId: platformUuidSchema,
    clientReportId: platformUuidSchema,
    verifiedGrantId: platformUuidSchema,
    keysetRevision: z.string().trim().min(1).max(512),
    entitlementRevision: z.string().regex(/^(0|[1-9][0-9]*)$/),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.deviceKind === "kiosk") !== (value.assignmentId === null)) {
      context.addIssue({
        code: "custom",
        path: ["assignmentId"],
        message: "Only working devices have an assignment",
      });
    }
  });

export const grantActivationPreparationSchema = z
  .object({
    protocol: protocolSchema,
    id: platformUuidSchema,
    state: grantActivationStateSchema,
    requestId: platformUuidSchema,
    previewRequestId: platformUuidSchema,
    previewDigest: digestSchema,
    preparationDigest: digestSchema,
    basePolicy: grantActivationBasePolicySchema,
    members: z.array(grantActivationMemberSchema).min(1).max(200),
    decisionReference: z.string().trim().min(1).max(1_000),
    preparedBy: grantActivationActorSchema,
    preparedAt: platformTimestampSchema,
    expiresAt: platformTimestampSchema,
    confirmedBy: grantActivationActorSchema.nullable(),
    confirmedAt: platformTimestampSchema.nullable(),
    cancelledBy: grantActivationActorSchema.nullable(),
    cancelledAt: platformTimestampSchema.nullable(),
    cancellationReason: z.string().trim().min(1).max(1_000).nullable(),
    rolloutPolicy: offlineGrantPolicyRecordSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const confirmed =
      value.confirmedBy !== null && value.confirmedAt !== null && value.rolloutPolicy !== null;
    const cancelled =
      value.cancelledBy !== null && value.cancelledAt !== null && value.cancellationReason !== null;
    if ((value.state === "confirmed") !== confirmed) {
      context.addIssue({ code: "custom", path: ["state"], message: "Invalid confirmed state" });
    }
    if ((value.state === "cancelled") !== cancelled) {
      context.addIssue({ code: "custom", path: ["state"], message: "Invalid cancelled state" });
    }
    if (confirmed && cancelled) {
      context.addIssue({ code: "custom", path: ["state"], message: "Terminal states conflict" });
    }
  });

export const grantActivationPrepareRequestSchema = z
  .object({
    protocol: protocolSchema,
    previewRequestId: platformUuidSchema,
    previewDigest: digestSchema,
    policyId: platformUuidSchema,
    deviceIds: uniqueDeviceIdsSchema,
    decisionReference: z.string().trim().min(1).max(1_000),
    requestId: platformUuidSchema,
  })
  .strict();

export const grantActivationConfirmRequestSchema = z
  .object({
    protocol: protocolSchema,
    preparationDigest: digestSchema,
    requestId: platformUuidSchema,
  })
  .strict();

export const grantActivationCancelRequestSchema = z
  .object({
    protocol: protocolSchema,
    reason: z.string().trim().min(1).max(1_000),
    requestId: platformUuidSchema,
  })
  .strict();

const confirmedResponseSchema = z
  .object({
    status: z.literal("confirmed"),
    requestId: platformUuidSchema,
    preparation: grantActivationPreparationSchema.refine(
      (preparation) => preparation.state === "confirmed",
    ),
    activationIds: z.array(platformUuidSchema).min(1).max(200),
  })
  .strict();

const needsReviewResponseSchema = z
  .object({
    status: z.literal("needs_review"),
    requestId: platformUuidSchema,
    preparation: grantActivationPreparationSchema.refine(
      (preparation) => preparation.state === "needs_review",
    ),
    reasons: z.array(grantReadinessReasonSchema).min(1),
  })
  .strict();

const listQuerySchema = z
  .object({
    state: grantActivationStateSchema.optional(),
    cursor: opaqueCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const platformGrantActivationContracts = {
  list: {
    query: listQuerySchema,
    response: z
      .object({
        items: z.array(grantActivationPreparationSchema).max(100),
        nextCursor: opaqueCursorSchema.nullable(),
      })
      .strict(),
  },
  detail: { response: grantActivationPreparationSchema },
  prepare: {
    body: grantActivationPrepareRequestSchema,
    response: grantActivationPreparationSchema.refine(
      (preparation) => preparation.state === "prepared",
    ),
  },
  confirm: {
    body: grantActivationConfirmRequestSchema,
    response: z.discriminatedUnion("status", [confirmedResponseSchema, needsReviewResponseSchema]),
  },
  cancel: {
    body: grantActivationCancelRequestSchema,
    response: grantActivationPreparationSchema.refine(
      (preparation) => preparation.state === "cancelled",
    ),
  },
} as const;

export type GrantActivationState = z.output<typeof grantActivationStateSchema>;
export type PlatformGrantActivationListQuery = z.input<
  typeof platformGrantActivationContracts.list.query
>;
export type GrantActivationMember = z.output<typeof grantActivationMemberSchema>;
export type PlatformGrantActivationPreparation = z.output<typeof grantActivationPreparationSchema>;
export type PlatformGrantActivationPrepareRequest = z.output<
  typeof grantActivationPrepareRequestSchema
>;
export type PlatformGrantActivationConfirmRequest = z.output<
  typeof grantActivationConfirmRequestSchema
>;
export type PlatformGrantActivationCancelRequest = z.output<
  typeof grantActivationCancelRequestSchema
>;
export type PlatformGrantActivationReceipt = z.output<
  typeof platformGrantActivationContracts.confirm.response
>;

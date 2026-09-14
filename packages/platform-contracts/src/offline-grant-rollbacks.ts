import { z } from "zod";

import { offlineGrantPolicyRecordSchema } from "./offline-grant-policies.js";
import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";
import { platformRoleSchema } from "./platform-auth.js";

const protocolSchema = z.literal("offline-grants-rollback-v1");
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const opaqueCursorSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[A-Za-z0-9_-]+$/);
const uniqueActivationIdsSchema = z
  .array(platformUuidSchema)
  .min(1)
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Activation IDs must be unique",
  });

export const grantRollbackStateSchema = z.enum([
  "prepared",
  "confirmed",
  "cancelled",
  "expired",
  "needs_review",
]);

export const grantRollbackReasonSchema = z.enum([
  "activation_missing",
  "activation_inactive",
  "activation_mismatch",
  "base_policy_mismatch",
  "strict_policy_mismatch",
  "subscription_mismatch",
  "device_mismatch",
  "credential_mismatch",
  "assignment_mismatch",
  "configuration_mismatch",
]);

const grantRollbackActorSchema = z
  .object({ userId: z.string().min(1).max(128), role: platformRoleSchema })
  .strict();

export const grantRollbackMemberSchema = z
  .object({
    activationId: platformUuidSchema,
    activationPreparationId: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    tenantName: z.string().trim().min(1).max(300),
    subscriptionId: platformUuidSchema,
    deviceId: platformUuidSchema,
    deviceKind: z.enum(["station", "handheld", "kiosk"]),
    deviceName: z.string().trim().min(1).max(300),
    credentialEpoch: z.number().int().positive().max(2_147_483_647),
    assignmentId: platformUuidSchema.nullable(),
    configurationId: platformUuidSchema,
    basePolicyId: platformUuidSchema,
    strictPolicyId: platformUuidSchema,
    activatedAt: platformTimestampSchema,
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

export const grantRollbackCandidateSchema = z
  .object({
    activationId: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    tenantName: z.string().trim().min(1).max(300),
    subscriptionId: platformUuidSchema,
    deviceId: platformUuidSchema,
    deviceKind: z.enum(["station", "handheld", "kiosk"]),
    deviceName: z.string().trim().min(1).max(300),
    basePolicyId: platformUuidSchema,
    strictPolicyId: platformUuidSchema,
    strictDecisionReference: z.string().trim().min(1).max(1_000),
    activatedAt: platformTimestampSchema,
  })
  .strict();

export const grantRollbackPreparationSchema = z
  .object({
    protocol: protocolSchema,
    id: platformUuidSchema,
    state: grantRollbackStateSchema,
    requestId: platformUuidSchema,
    rollbackDigest: digestSchema,
    members: z.array(grantRollbackMemberSchema).min(1).max(200),
    decisionReference: z.string().trim().min(1).max(1_000),
    preparedBy: grantRollbackActorSchema,
    preparedAt: platformTimestampSchema,
    expiresAt: platformTimestampSchema,
    confirmedBy: grantRollbackActorSchema.nullable(),
    confirmedAt: platformTimestampSchema.nullable(),
    cancelledBy: grantRollbackActorSchema.nullable(),
    cancelledAt: platformTimestampSchema.nullable(),
    cancellationReason: z.string().trim().min(1).max(1_000).nullable(),
    observePolicy: offlineGrantPolicyRecordSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const confirmed =
      value.confirmedBy !== null && value.confirmedAt !== null && value.observePolicy !== null;
    const reviewed =
      value.confirmedBy !== null && value.confirmedAt !== null && value.observePolicy === null;
    const cancelled =
      value.cancelledBy !== null && value.cancelledAt !== null && value.cancellationReason !== null;
    if ((value.state === "confirmed") !== confirmed) {
      context.addIssue({ code: "custom", path: ["state"], message: "Invalid confirmed state" });
    }
    if ((value.state === "needs_review") !== (reviewed && !cancelled)) {
      context.addIssue({ code: "custom", path: ["state"], message: "Invalid review state" });
    }
    if ((value.state === "cancelled") !== cancelled) {
      context.addIssue({ code: "custom", path: ["state"], message: "Invalid cancelled state" });
    }
    if (confirmed && cancelled) {
      context.addIssue({ code: "custom", path: ["state"], message: "Terminal states conflict" });
    }
  });

export const grantRollbackPrepareRequestSchema = z
  .object({
    protocol: protocolSchema,
    activationIds: uniqueActivationIdsSchema,
    decisionReference: z.string().trim().min(1).max(1_000),
    requestId: platformUuidSchema,
  })
  .strict();

export const grantRollbackConfirmRequestSchema = z
  .object({
    protocol: protocolSchema,
    rollbackDigest: digestSchema,
    requestId: platformUuidSchema,
  })
  .strict();

export const grantRollbackCancelRequestSchema = z
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
    preparation: grantRollbackPreparationSchema.refine(
      (preparation) => preparation.state === "confirmed",
    ),
  })
  .strict();

const needsReviewResponseSchema = z
  .object({
    status: z.literal("needs_review"),
    requestId: platformUuidSchema,
    preparation: grantRollbackPreparationSchema.refine(
      (preparation) => preparation.state === "needs_review",
    ),
    reasons: z.array(grantRollbackReasonSchema).min(1),
  })
  .strict();

const listQuerySchema = z
  .object({
    state: grantRollbackStateSchema.optional(),
    cursor: opaqueCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const candidatesQuerySchema = z
  .object({
    tenantId: platformTenantIdSchema.optional(),
    deviceKind: z.enum(["station", "handheld", "kiosk"]).optional(),
    cursor: opaqueCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const platformGrantRollbackContracts = {
  candidates: {
    query: candidatesQuerySchema,
    response: z
      .object({
        items: z.array(grantRollbackCandidateSchema).max(100),
        nextCursor: opaqueCursorSchema.nullable(),
      })
      .strict(),
  },
  list: {
    query: listQuerySchema,
    response: z
      .object({
        items: z.array(grantRollbackPreparationSchema).max(100),
        nextCursor: opaqueCursorSchema.nullable(),
      })
      .strict(),
  },
  detail: { response: grantRollbackPreparationSchema },
  prepare: {
    body: grantRollbackPrepareRequestSchema,
    response: grantRollbackPreparationSchema.refine(
      (preparation) => preparation.state === "prepared",
    ),
  },
  confirm: {
    body: grantRollbackConfirmRequestSchema,
    response: z.discriminatedUnion("status", [confirmedResponseSchema, needsReviewResponseSchema]),
  },
  cancel: {
    body: grantRollbackCancelRequestSchema,
    response: grantRollbackPreparationSchema.refine(
      (preparation) => preparation.state === "cancelled",
    ),
  },
} as const;

export type GrantRollbackState = z.output<typeof grantRollbackStateSchema>;
export type GrantRollbackReason = z.output<typeof grantRollbackReasonSchema>;
export type GrantRollbackMember = z.output<typeof grantRollbackMemberSchema>;
export type GrantRollbackCandidate = z.output<typeof grantRollbackCandidateSchema>;
export type PlatformGrantRollbackCandidatesQuery = z.input<
  typeof platformGrantRollbackContracts.candidates.query
>;
export type PlatformGrantRollbackPreparation = z.output<typeof grantRollbackPreparationSchema>;
export type PlatformGrantRollbackListQuery = z.input<
  typeof platformGrantRollbackContracts.list.query
>;
export type PlatformGrantRollbackPrepareRequest = z.output<
  typeof grantRollbackPrepareRequestSchema
>;
export type PlatformGrantRollbackConfirmRequest = z.output<
  typeof grantRollbackConfirmRequestSchema
>;
export type PlatformGrantRollbackCancelRequest = z.output<typeof grantRollbackCancelRequestSchema>;
export type PlatformGrantRollbackReceipt = z.output<
  typeof platformGrantRollbackContracts.confirm.response
>;

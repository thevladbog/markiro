import { deviceKindSchema } from "@markiro/domain";
import { z } from "zod";
import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

export const grantReadinessReasonSchema = z.enum([
  "credential_inactive",
  "device_revoked",
  "working_assignment_missing",
  "subscription_missing",
  "target_policy_not_current",
  "target_policy_not_approved",
  "signing_not_configured",
  "configuration_missing",
  "client_report_missing",
  "client_report_stale",
  "credential_epoch_mismatch",
  "configuration_mismatch",
  "keyset_mismatch",
  "verified_grant_missing",
  "verified_grant_mismatch",
  "grant_key_retired",
]);

const boundedRevisionSchema = z.string().min(1).max(256);
const nonnegativeCountSchema = z.number().int().nonnegative();
const positiveEpochSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const currentPolicySchema = z
  .object({
    id: platformUuidSchema,
    revision: boundedRevisionSchema,
    approved: z.boolean(),
  })
  .strict();

const signingReadinessSchema = z
  .object({
    configured: z.boolean(),
    keysetRevision: boundedRevisionSchema.nullable(),
  })
  .strict();

const configurationReadinessSchema = z
  .object({
    id: platformUuidSchema,
    mode: z.enum(["observe", "strict"]),
    policyRevision: boundedRevisionSchema.nullable(),
  })
  .strict();

const clientReadinessReportSchema = z
  .object({
    id: platformUuidSchema,
    receivedAt: platformTimestampSchema,
    clientBuild: z.string().min(1).max(100),
    storageRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    credentialEpoch: positiveEpochSchema,
    mode: z.enum(["observe", "strict"]),
    policyRevision: boundedRevisionSchema.nullable(),
    keysetRevision: boundedRevisionSchema.nullable(),
    verifiedGrantId: platformUuidSchema.nullable(),
    matchesCurrentConfiguration: z.boolean(),
    verifiedGrantMatched: z.boolean(),
  })
  .strict();

const verifiedGrantReadinessSchema = z
  .object({
    id: platformUuidSchema,
    issuedAt: platformTimestampSchema,
    kid: z.string().min(1).max(128),
    retired: z.boolean(),
  })
  .strict();

const evidenceReadinessSchema = z
  .object({
    acceptedCount: nonnegativeCountSchema,
    lastAcceptedAt: platformTimestampSchema.nullable(),
  })
  .strict();

const eligibilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("eligible"), reasons: z.tuple([]) }).strict(),
  z
    .object({
      status: z.literal("blocked"),
      reasons: z
        .array(grantReadinessReasonSchema)
        .min(1)
        .max(grantReadinessReasonSchema.options.length)
        .refine((reasons) => new Set(reasons).size === reasons.length, "Reasons must be unique"),
    })
    .strict(),
]);

export const platformGrantReadinessRowSchema = z
  .object({
    tenantId: platformTenantIdSchema,
    tenantName: z.string().min(1).max(200),
    deviceId: platformUuidSchema,
    deviceKind: deviceKindSchema,
    deviceName: z.string().min(1).max(200),
    credentialEpoch: positiveEpochSchema,
    credentialActive: z.boolean(),
    revokedAt: platformTimestampSchema.nullable(),
    assignmentId: platformUuidSchema.nullable(),
    lastSeenAt: platformTimestampSchema.nullable(),
    currentPolicy: currentPolicySchema.nullable(),
    signing: signingReadinessSchema,
    configuration: configurationReadinessSchema.nullable(),
    clientReport: clientReadinessReportSchema.nullable(),
    verifiedGrant: verifiedGrantReadinessSchema.nullable(),
    evidence: evidenceReadinessSchema,
    eligibility: eligibilitySchema,
  })
  .strict();

const reasonCountsSchema = z
  .partialRecord(grantReadinessReasonSchema, z.number().int().positive())
  .refine((counts) => Object.keys(counts).length <= grantReadinessReasonSchema.options.length);

export const platformGrantReadinessAggregatesSchema = z
  .object({
    total: nonnegativeCountSchema,
    eligible: nonnegativeCountSchema,
    blocked: nonnegativeCountSchema,
    reasons: reasonCountsSchema,
  })
  .strict()
  .refine(({ total, eligible, blocked }) => total === eligible + blocked, {
    message: "Total must equal eligible plus blocked",
    path: ["total"],
  });

const opaqueCursorSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[A-Za-z0-9_-]+$/);

export const platformGrantReadinessListQuerySchema = z
  .object({
    tenantId: platformTenantIdSchema.optional(),
    deviceKind: deviceKindSchema.optional(),
    readiness: z.enum(["eligible", "blocked"]).optional(),
    policyId: platformUuidSchema.optional(),
    cursor: opaqueCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const platformGrantReadinessListResponseSchema = z
  .object({
    asOf: platformTimestampSchema,
    items: z.array(platformGrantReadinessRowSchema).max(100),
    aggregates: platformGrantReadinessAggregatesSchema,
    nextCursor: opaqueCursorSchema.nullable(),
  })
  .strict();

export const platformGrantReadinessPreviewRequestSchema = z
  .object({
    policyId: platformUuidSchema,
    mode: z.literal("strict"),
    deviceIds: z
      .array(platformUuidSchema)
      .min(1)
      .max(200)
      .refine((deviceIds) => new Set(deviceIds).size === deviceIds.length, {
        message: "Device IDs must be unique",
      }),
    requestId: platformUuidSchema,
  })
  .strict();

export const platformGrantReadinessPreviewResponseSchema = z
  .object({
    requestId: platformUuidSchema,
    policyId: platformUuidSchema,
    policyRevision: boundedRevisionSchema,
    mode: z.literal("strict"),
    asOf: platformTimestampSchema,
    previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
    items: z.array(platformGrantReadinessRowSchema).min(1).max(200),
    aggregates: platformGrantReadinessAggregatesSchema,
  })
  .strict();

export const platformGrantReadinessContracts = {
  list: {
    query: platformGrantReadinessListQuerySchema,
    response: platformGrantReadinessListResponseSchema,
  },
  preview: {
    body: platformGrantReadinessPreviewRequestSchema,
    response: platformGrantReadinessPreviewResponseSchema,
  },
} as const;

export type GrantReadinessReason = z.infer<typeof grantReadinessReasonSchema>;
export type PlatformGrantReadinessRow = z.infer<typeof platformGrantReadinessRowSchema>;
export type PlatformGrantReadinessListQuery = z.input<typeof platformGrantReadinessListQuerySchema>;
export type PlatformGrantReadinessListResponse = z.output<
  typeof platformGrantReadinessListResponseSchema
>;
export type PlatformGrantReadinessPreviewRequest = z.output<
  typeof platformGrantReadinessPreviewRequestSchema
>;
export type PlatformGrantReadinessPreviewResponse = z.output<
  typeof platformGrantReadinessPreviewResponseSchema
>;

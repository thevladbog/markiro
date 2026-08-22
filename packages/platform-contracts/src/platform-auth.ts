import { z } from "zod";

import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

const platformUserIdSchema = z.string().min(1).max(128);
const nullablePlatformUserIdSchema = platformUserIdSchema.nullable();
const responseTimestampSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  platformTimestampSchema,
);

export const platformRoleSchema = z.enum(["platform_admin", "support", "accountant"]);
export type PlatformRole = z.infer<typeof platformRoleSchema>;

export const platformCapabilitySchema = z.enum([
  "tenants.read",
  "tenants.write",
  "catalog.read",
  "catalog.write",
  "billing.read",
  "billing.write",
  "platformTeam.write",
  "audit.read",
]);
export type PlatformCapability = z.infer<typeof platformCapabilitySchema>;

export const platformCapabilitiesForRole = {
  platform_admin: [
    "tenants.read",
    "tenants.write",
    "catalog.read",
    "catalog.write",
    "billing.read",
    "billing.write",
    "platformTeam.write",
    "audit.read",
  ],
  support: ["tenants.read", "tenants.write", "catalog.read", "audit.read"],
  accountant: [
    "tenants.read",
    "catalog.read",
    "catalog.write",
    "billing.read",
    "billing.write",
    "audit.read",
  ],
} as const satisfies Record<PlatformRole, readonly PlatformCapability[]>;

export const platformPrincipalSchema = z
  .object({
    userId: platformUserIdSchema,
    role: platformRoleSchema,
    capabilities: z.array(platformCapabilitySchema).readonly(),
    twoFactorReady: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = platformCapabilitiesForRole[value.role];
    if (
      value.capabilities.length !== expected.length ||
      value.capabilities.some((capability, index) => capability !== expected[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Capabilities do not match the platform role",
      });
    }
  });
export type PlatformPrincipal = z.infer<typeof platformPrincipalSchema>;

export const platformTeamStatusSchema = z.enum(["active", "suspended", "invited"]);

export const platformTeamUserSchema = z
  .object({
    id: platformUserIdSchema,
    name: z.string().min(1).max(300),
    email: z.email(),
    role: platformRoleSchema,
    status: platformTeamStatusSchema,
    twoFactorReady: z.boolean(),
    createdAt: responseTimestampSchema,
  })
  .strict();
export type PlatformTeamUser = z.infer<typeof platformTeamUserSchema>;

export const platformTeamListResponseSchema = z.array(platformTeamUserSchema);

const normalizedEmailSchema = z
  .string()
  .transform((value) => value.trim().toLocaleLowerCase("en-US"))
  .pipe(z.email());

export const platformTeamInviteSchema = z.object({
  email: normalizedEmailSchema,
  role: platformRoleSchema,
});
export type PlatformTeamInviteInput = z.infer<typeof platformTeamInviteSchema>;

export const platformTeamRoleChangeSchema = z.object({ role: platformRoleSchema });
export type PlatformTeamRoleChangeInput = z.infer<typeof platformTeamRoleChangeSchema>;

export const platformActivationIssueResultSchema = z
  .object({
    userId: platformUserIdSchema,
    deliveryId: platformUuidSchema,
  })
  .strict();
export type PlatformActivationIssueResult = z.infer<typeof platformActivationIssueResultSchema>;

export const platformMutationAcknowledgementSchema = z.object({ status: z.literal(true) }).strict();
export type PlatformMutationAcknowledgement = z.infer<typeof platformMutationAcknowledgementSchema>;

export const platformActivationCompleteRequestSchema = z.object({
  token: z.string().min(16).max(512),
  password: z.string().min(8).max(128),
});
export type PlatformActivationCompleteRequest = z.infer<
  typeof platformActivationCompleteRequestSchema
>;

export const platformActivationSuccessSchema = z
  .object({ twoFactorEnrollmentRequired: z.literal(true) })
  .strict();
export type PlatformActivationSuccess = z.infer<typeof platformActivationSuccessSchema>;

export const platformAuditQuerySchema = z.object({
  tenantId: platformTenantIdSchema.optional(),
  actorId: platformUserIdSchema.optional(),
  action: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_.-]+$/)
    .optional(),
  outcome: z.enum(["success", "failed", "denied"]).optional(),
  from: z.iso
    .datetime()
    .transform((value) => new Date(value))
    .optional(),
  to: z.iso
    .datetime()
    .transform((value) => new Date(value))
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
export type PlatformAuditQuery = z.infer<typeof platformAuditQuerySchema>;

const requiredAuditMetadataSchema = z
  .unknown()
  .refine((value) => value !== undefined, "Audit metadata field is required");

export const platformAuditEventSchema = z
  .object({
    id: platformUuidSchema,
    actorPlatformUserId: nullablePlatformUserIdSchema,
    actorRole: platformRoleSchema.nullable(),
    action: z.string().min(1).max(120),
    outcome: z.enum(["success", "failed", "denied"]),
    tenantId: platformTenantIdSchema.nullable(),
    targetType: z.string().min(1).max(120),
    targetId: z.string().min(1).max(128).nullable(),
    reason: z.string().min(1).max(1_000).nullable(),
    before: requiredAuditMetadataSchema,
    after: requiredAuditMetadataSchema,
    requestId: z.string().min(1).max(128).nullable(),
    createdAt: responseTimestampSchema,
  })
  .strict();
export type PlatformAuditEvent = z.infer<typeof platformAuditEventSchema>;

export const platformAuditResponseSchema = z
  .object({
    items: z.array(platformAuditEventSchema),
    nextOffset: z.number().int().min(0).max(10_100).nullable(),
  })
  .strict();
export type PlatformAuditResponse = z.infer<typeof platformAuditResponseSchema>;

const platformTeamUserParamsSchema = z
  .object({ id: platformUserIdSchema })
  .strict()
  .refine(({ id }) => !id.includes("/"), {
    path: ["id"],
    message: "Platform user ID must not contain a path separator",
  });
export type PlatformTeamUserParams = z.infer<typeof platformTeamUserParamsSchema>;

export const platformTeamContracts = {
  list: { response: platformTeamListResponseSchema },
  invite: { body: platformTeamInviteSchema, response: platformActivationIssueResultSchema },
  changeRole: {
    params: platformTeamUserParamsSchema,
    body: platformTeamRoleChangeSchema,
    response: platformMutationAcknowledgementSchema,
  },
  suspend: {
    params: platformTeamUserParamsSchema,
    response: platformMutationAcknowledgementSchema,
  },
  renewActivation: {
    params: platformTeamUserParamsSchema,
    response: platformActivationIssueResultSchema,
  },
  recoverTwoFactor: {
    params: platformTeamUserParamsSchema,
    response: platformMutationAcknowledgementSchema,
  },
} as const;

export const platformAuthContracts = {
  me: { response: platformPrincipalSchema },
  activationComplete: {
    body: platformActivationCompleteRequestSchema,
    response: platformActivationSuccessSchema,
  },
} as const;

export const platformAuditContracts = {
  list: { query: platformAuditQuerySchema, response: platformAuditResponseSchema },
} as const;

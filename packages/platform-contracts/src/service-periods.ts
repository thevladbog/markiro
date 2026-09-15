import { z } from "zod";

import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const minuteSchema = z.number().int().min(0).max(POSTGRES_INTEGER_MAX);
const positiveMinuteSchema = minuteSchema.min(1);
const responseTimestampSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  platformTimestampSchema,
);

export const servicePeriodRevisionSchema = z.number().int().min(1).max(POSTGRES_INTEGER_MAX);
export const servicePeriodStateSchema = z.enum(["upcoming", "active", "expired"]);
export const serviceUsageClassificationSchema = z.enum(["customer_service", "product_defect"]);

export const servicePeriodBalanceSchema = z
  .object({
    included: minuteSchema,
    externallyApproved: minuteSchema,
    consumed: minuteSchema,
    remaining: minuteSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.remaining !== value.included + value.externallyApproved - value.consumed) {
      context.addIssue({ code: "custom", path: ["remaining"], message: "Balance must reconcile" });
    }
  });

const servicePeriodSummaryShape = {
  id: platformUuidSchema,
  tenantId: platformTenantIdSchema,
  orderedServiceId: platformUuidSchema,
  catalogItemId: platformUuidSchema,
  catalogVersionId: platformUuidSchema,
  nameRu: z.string().trim().min(1).max(300),
  nameEn: z.string().trim().min(1).max(300),
  startsAt: responseTimestampSchema,
  endsAt: responseTimestampSchema,
  state: servicePeriodStateSchema,
  revision: servicePeriodRevisionSchema,
  balance: servicePeriodBalanceSchema,
} as const;

export const servicePeriodSummarySchema = z.object(servicePeriodSummaryShape).strict();

export const serviceUsageEntrySchema = z
  .object({
    id: platformUuidSchema,
    kind: z.enum(["usage", "correction"]),
    classification: serviceUsageClassificationSchema,
    originalEntryId: platformUuidSchema.nullable(),
    workReference: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(4_000),
    performedAt: responseTimestampSchema,
    postedAt: responseTimestampSchema,
    actualMinutesDelta: z.number().int().min(-POSTGRES_INTEGER_MAX).max(POSTGRES_INTEGER_MAX),
    allowanceMinutesDelta: z.number().int().min(-POSTGRES_INTEGER_MAX).max(POSTGRES_INTEGER_MAX),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.kind === "usage" &&
      (value.originalEntryId !== null || value.actualMinutesDelta <= 0)
    ) {
      context.addIssue({ code: "custom", message: "Usage must add actual minutes" });
    }
    if (value.kind === "correction" && value.originalEntryId === null) {
      context.addIssue({
        code: "custom",
        path: ["originalEntryId"],
        message: "Correction requires original entry",
      });
    }
    if (
      value.kind === "usage" &&
      value.classification === "product_defect" &&
      value.allowanceMinutesDelta !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowanceMinutesDelta"],
        message: "Product defects do not consume allowance",
      });
    }
  });

export const platformServiceUsageEntrySchema = serviceUsageEntrySchema
  .safeExtend({
    billingActId: platformUuidSchema.nullable(),
    internalNote: z.string().trim().max(4_000).nullable(),
    actorPlatformUserId: z.string().trim().min(1).max(128),
    requestId: platformUuidSchema,
  })
  .strict();

export const serviceExcessApprovalSchema = z
  .object({
    id: platformUuidSchema,
    kind: z.enum(["approval", "withdrawal"]),
    originalApprovalId: platformUuidSchema.nullable(),
    minuteDelta: z.number().int().min(-POSTGRES_INTEGER_MAX).max(POSTGRES_INTEGER_MAX),
    externalReference: z.string().trim().min(1).max(1_000),
    externalUrl: z.url().max(2_000).nullable(),
    approvedAt: responseTimestampSchema,
    reason: z.string().trim().min(1).max(1_000),
    actorPlatformUserId: z.string().trim().min(1).max(128),
    requestId: platformUuidSchema,
    postedAt: responseTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.kind === "approval" &&
      (value.minuteDelta <= 0 || value.originalApprovalId !== null)
    ) {
      context.addIssue({ code: "custom", message: "Approval must add capacity" });
    }
    if (
      value.kind === "withdrawal" &&
      (value.minuteDelta >= 0 || value.originalApprovalId === null)
    ) {
      context.addIssue({ code: "custom", message: "Withdrawal must reverse an approval" });
    }
  });

const requestIdentityShape = {
  requestId: platformUuidSchema,
  expectedRevision: servicePeriodRevisionSchema,
} as const;

export const serviceUsagePostSchema = z
  .object({
    ...requestIdentityShape,
    classification: serviceUsageClassificationSchema,
    performedAt: platformTimestampSchema,
    actualMinutes: positiveMinuteSchema,
    allowanceMinutes: minuteSchema,
    workReference: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(4_000),
    internalNote: z.string().trim().max(4_000).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.classification === "product_defect" && value.allowanceMinutes !== 0) {
      context.addIssue({
        code: "custom",
        path: ["allowanceMinutes"],
        message: "Product defects do not consume allowance",
      });
    }
  });

export const serviceUsageCorrectionSchema = z
  .object({
    ...requestIdentityShape,
    classification: serviceUsageClassificationSchema,
    actualMinutesDelta: z.number().int().min(-POSTGRES_INTEGER_MAX).max(POSTGRES_INTEGER_MAX),
    allowanceMinutesDelta: z.number().int().min(-POSTGRES_INTEGER_MAX).max(POSTGRES_INTEGER_MAX),
    description: z.string().trim().min(1).max(4_000),
    internalNote: z.string().trim().max(4_000).nullable(),
  })
  .strict()
  .refine((value) => value.actualMinutesDelta !== 0 || value.allowanceMinutesDelta !== 0, {
    message: "Correction must change actual or allowance minutes",
  });

export const serviceExcessApprovalPostSchema = z
  .object({
    ...requestIdentityShape,
    approvedMinutes: positiveMinuteSchema,
    externalReference: z.string().trim().min(1).max(1_000),
    externalUrl: z.url().max(2_000).nullable(),
    approvedAt: platformTimestampSchema,
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const serviceExcessApprovalWithdrawalSchema = z
  .object({
    ...requestIdentityShape,
    withdrawnMinutes: positiveMinuteSchema,
    externalReference: z.string().trim().min(1).max(1_000),
    externalUrl: z.url().max(2_000).nullable(),
    approvedAt: platformTimestampSchema,
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const servicePeriodListQuerySchema = z
  .object({
    tenantId: platformTenantIdSchema.optional(),
    catalogItemId: platformUuidSchema.optional(),
    state: servicePeriodStateSchema.optional(),
    from: platformTimestampSchema.optional(),
    to: platformTimestampSchema.optional(),
    cursor: z.string().trim().min(1).max(2_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const tenantServicePeriodListQuerySchema = servicePeriodListQuerySchema.omit({
  tenantId: true,
});
export const servicePeriodParamsSchema = z.object({ id: platformUuidSchema }).strict();
export const serviceUsageParamsSchema = z
  .object({ id: platformUuidSchema, entryId: platformUuidSchema })
  .strict();
export const serviceApprovalParamsSchema = z
  .object({ id: platformUuidSchema, approvalId: platformUuidSchema })
  .strict();

const servicePeriodListResponseSchema = z
  .object({ items: z.array(servicePeriodSummarySchema), nextCursor: z.string().nullable() })
  .strict();
const tenantServicePeriodSummarySchema = servicePeriodSummarySchema.omit({ tenantId: true });
const tenantServicePeriodListResponseSchema = z
  .object({ items: z.array(tenantServicePeriodSummarySchema), nextCursor: z.string().nullable() })
  .strict();
const platformServicePeriodDetailSchema = servicePeriodSummarySchema
  .extend({
    invoiceId: platformUuidSchema,
    invoiceLineId: platformUuidSchema,
    paymentId: platformUuidSchema,
    entries: z.array(platformServiceUsageEntrySchema),
    approvals: z.array(serviceExcessApprovalSchema),
  })
  .strict();
const tenantServicePeriodDetailSchema = tenantServicePeriodSummarySchema
  .extend({ entries: z.array(serviceUsageEntrySchema) })
  .strict();

const servicePeriodMutationResponseSchema = z
  .object({ revision: servicePeriodRevisionSchema, balance: servicePeriodBalanceSchema })
  .strict();

export const platformServicePeriodContracts = {
  list: { query: servicePeriodListQuerySchema, response: servicePeriodListResponseSchema },
  detail: { params: servicePeriodParamsSchema, response: platformServicePeriodDetailSchema },
  postUsage: {
    params: servicePeriodParamsSchema,
    body: serviceUsagePostSchema,
    response: servicePeriodMutationResponseSchema,
  },
  correctUsage: {
    params: serviceUsageParamsSchema,
    body: serviceUsageCorrectionSchema,
    response: servicePeriodMutationResponseSchema,
  },
  addApproval: {
    params: servicePeriodParamsSchema,
    body: serviceExcessApprovalPostSchema,
    response: servicePeriodMutationResponseSchema,
  },
  withdrawApproval: {
    params: serviceApprovalParamsSchema,
    body: serviceExcessApprovalWithdrawalSchema,
    response: servicePeriodMutationResponseSchema,
  },
} as const;

export const tenantServicePeriodContracts = {
  list: {
    query: tenantServicePeriodListQuerySchema,
    response: tenantServicePeriodListResponseSchema,
  },
  detail: { params: servicePeriodParamsSchema, response: tenantServicePeriodDetailSchema },
} as const;

export type ServicePeriodDetail = z.output<typeof platformServicePeriodDetailSchema>;
export type ServiceUsagePostInput = z.output<typeof serviceUsagePostSchema>;
export type ServiceUsageCorrectionInput = z.output<typeof serviceUsageCorrectionSchema>;
export type ServiceExcessApprovalPostInput = z.output<typeof serviceExcessApprovalPostSchema>;
export type ServiceExcessApprovalWithdrawalInput = z.output<
  typeof serviceExcessApprovalWithdrawalSchema
>;

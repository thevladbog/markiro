import { z } from "zod";

import { platformRoleSchema } from "./platform-auth.js";
import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

export const OPERATIONS_RESTRICTION_WINDOW_DAYS = 14;

const responseTimestampSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  platformTimestampSchema,
);

const componentStatusSchema = z.enum(["healthy", "degraded", "unavailable"]);
const componentCategorySchema = z.enum([
  "database_unavailable",
  "database_timeout",
  "jobs_unavailable",
  "jobs_timeout",
  "smtp_unavailable",
  "smtp_timeout",
  "storage_unavailable",
  "storage_timeout",
]);

export const platformHealthComponentSchema = z
  .object({
    status: componentStatusSchema,
    checkedAt: responseTimestampSchema,
    category: componentCategorySchema.optional(),
  })
  .strict();

export const platformHealthSchema = z
  .object({
    status: z.enum(["ok", "degraded", "unavailable"]),
    checkedAt: responseTimestampSchema,
    checks: z
      .object({
        database: platformHealthComponentSchema,
        jobs: platformHealthComponentSchema,
        smtp: platformHealthComponentSchema,
        storage: platformHealthComponentSchema,
      })
      .strict(),
    integrations: z
      .object({
        dadata: z.object({ status: z.enum(["ready", "unconfigured"]) }).strict(),
      })
      .strict(),
  })
  .strict();
export type PlatformHealth = z.infer<typeof platformHealthSchema>;

const decisionBase = {
  id: z.string().min(1).max(256),
};

const subscriptionEndingDecisionSchema = z
  .object({
    ...decisionBase,
    kind: z.literal("subscription_ending"),
    severity: z.literal("warning"),
    tenantId: platformTenantIdSchema,
    tenantName: z.string().trim().min(1).max(300),
    subscriptionId: platformUuidSchema,
    endsAt: responseTimestampSchema,
  })
  .strict();

const overdueInvoiceDecisionSchema = z
  .object({
    ...decisionBase,
    kind: z.literal("overdue_invoice"),
    severity: z.literal("critical"),
    tenantId: platformTenantIdSchema,
    tenantName: z.string().trim().min(1).max(300),
    invoiceId: platformUuidSchema,
    invoiceNumber: z.string().trim().min(1).max(120),
    dueAt: responseTimestampSchema,
  })
  .strict();

const billingReadinessMissingSchema = z
  .array(z.enum(["confirmed_legal_profile", "default_bank_account"]))
  .min(1)
  .max(2);

const operatorBillingReadinessDecisionSchema = z
  .object({
    ...decisionBase,
    kind: z.literal("billing_readiness"),
    severity: z.literal("attention"),
    party: z.literal("operator"),
    tenantId: z.null(),
    tenantName: z.null(),
    missing: billingReadinessMissingSchema,
  })
  .strict();

const tenantBillingReadinessDecisionSchema = z
  .object({
    ...decisionBase,
    kind: z.literal("billing_readiness"),
    severity: z.literal("attention"),
    party: z.literal("tenant"),
    tenantId: platformTenantIdSchema,
    tenantName: z.string().trim().min(1).max(300),
    missing: billingReadinessMissingSchema,
  })
  .strict();

export const operationsDecisionItemSchema = z.union([
  subscriptionEndingDecisionSchema,
  overdueInvoiceDecisionSchema,
  operatorBillingReadinessDecisionSchema,
  tenantBillingReadinessDecisionSchema,
]);
export type OperationsDecisionItem = z.infer<typeof operationsDecisionItemSchema>;

export const operationsAuditEventSummarySchema = z
  .object({
    id: platformUuidSchema,
    actorPlatformUserId: z.string().min(1).max(128).nullable(),
    actorRole: platformRoleSchema.nullable(),
    action: z.string().min(1).max(120),
    outcome: z.enum(["success", "failed", "denied"]),
    tenantId: platformTenantIdSchema.nullable(),
    targetType: z.string().min(1).max(120),
    targetId: z.string().min(1).max(128).nullable(),
    createdAt: responseTimestampSchema,
  })
  .strict();
export type OperationsAuditEventSummary = z.infer<typeof operationsAuditEventSummarySchema>;

export const operationsFormulaDefinitionsSchema = z
  .object({
    activeTenants: z
      .object({
        version: z.literal("active-tenants-v1"),
        subscriptionStatuses: z.tuple([z.literal("trial"), z.literal("active")]),
      })
      .strict(),
    tenantsApproachingRestriction: z
      .object({
        version: z.literal("subscriptions-ending-v1"),
        subscriptionStatuses: z.tuple([z.literal("trial"), z.literal("active")]),
        windowDays: z.literal(OPERATIONS_RESTRICTION_WINDOW_DAYS),
      })
      .strict(),
    overdueInvoices: z
      .object({
        version: z.literal("overdue-invoices-v1"),
        invoiceStatuses: z.tuple([z.literal("issued")]),
      })
      .strict(),
  })
  .strict();

export const operationsOverviewSchema = z
  .object({
    generatedAt: responseTimestampSchema,
    definitions: operationsFormulaDefinitionsSchema,
    activeTenants: z.number().int().nonnegative(),
    tenantsApproachingRestriction: z.number().int().nonnegative(),
    overdueInvoices: z.number().int().nonnegative().nullable(),
    decisionQueue: z.array(operationsDecisionItemSchema).max(100),
    recentActivity: z.array(operationsAuditEventSummarySchema).max(20),
    health: platformHealthSchema.nullable(),
  })
  .strict();
export type OperationsOverview = z.infer<typeof operationsOverviewSchema>;

export const platformOperationsContracts = {
  overview: { response: operationsOverviewSchema },
  monitoring: { response: platformHealthSchema },
} as const;

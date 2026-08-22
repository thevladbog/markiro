import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "@markiro/db";
import {
  OPERATIONS_RESTRICTION_WINDOW_DAYS,
  operationsAuditEventSummarySchema,
  platformOperationsContracts,
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
  type OperationsAuditEventSummary,
  type OperationsDecisionItem,
  type OperationsOverview,
  type PlatformHealth,
  type PlatformRole,
} from "@markiro/platform-contracts";
import { z } from "zod";

import type { ReadinessService } from "../../health/readiness.service";
import type { PlatformDadataService } from "../platform-dadata/platform-dadata.service";

const DECISION_QUEUE_LIMIT = 25;
const RECENT_ACTIVITY_LIMIT = 10;

export interface OperationsSummaryFacts {
  activeTenants: number;
  tenantsApproachingRestriction: number;
  overdueInvoices: number;
}

export interface SubscriptionEndingFact {
  tenantId: string;
  tenantName: string;
  subscriptionId: string;
  endsAt: string;
}

export interface OverdueInvoiceFact {
  tenantId: string;
  tenantName: string;
  invoiceId: string;
  invoiceNumber: string;
  dueAt: string;
}

export interface BillingReadinessFact {
  confirmedLegalProfile: boolean;
  defaultBankAccount: boolean;
}

export interface TenantBillingReadinessFact extends BillingReadinessFact {
  tenantId: string;
  tenantName: string;
}

export interface PlatformOperationsRepository {
  summary(now: Date, restrictionWindowEnd: Date): Promise<OperationsSummaryFacts>;
  subscriptionsEnding(
    now: Date,
    restrictionWindowEnd: Date,
    limit: number,
  ): Promise<SubscriptionEndingFact[]>;
  overdueInvoiceFacts(now: Date, limit: number): Promise<OverdueInvoiceFact[]>;
  billingReadiness(limit: number): Promise<{
    operator: BillingReadinessFact;
    tenants: TenantBillingReadinessFact[];
  }>;
  recentActivity(role: PlatformRole, limit: number): Promise<OperationsAuditEventSummary[]>;
}

export const PLATFORM_OPERATIONS_REPOSITORY = Symbol("PLATFORM_OPERATIONS_REPOSITORY");

const operationsSummaryFactsSchema = z
  .object({
    activeTenants: z.coerce.number().int().nonnegative(),
    tenantsApproachingRestriction: z.coerce.number().int().nonnegative(),
    overdueInvoices: z.coerce.number().int().nonnegative(),
  })
  .strict();

const subscriptionEndingFactSchema = z
  .object({
    tenantId: platformTenantIdSchema,
    tenantName: z.string().trim().min(1).max(300),
    subscriptionId: platformUuidSchema,
    endsAt: platformTimestampSchema,
  })
  .strict();

const overdueInvoiceFactSchema = z
  .object({
    tenantId: platformTenantIdSchema,
    tenantName: z.string().trim().min(1).max(300),
    invoiceId: platformUuidSchema,
    invoiceNumber: z.string().trim().min(1).max(120),
    dueAt: platformTimestampSchema,
  })
  .strict();

const billingReadinessFactSchema = z
  .object({
    confirmedLegalProfile: z.boolean(),
    defaultBankAccount: z.boolean(),
  })
  .strict();

const tenantBillingReadinessFactSchema = billingReadinessFactSchema.extend({
  tenantId: platformTenantIdSchema,
  tenantName: z.string().trim().min(1).max(300),
});

export class DrizzlePlatformOperationsRepository implements PlatformOperationsRepository {
  constructor(private readonly db: Db) {}

  async summary(now: Date, restrictionWindowEnd: Date): Promise<OperationsSummaryFacts> {
    const result = await this.db.execute(sql`
      select
        (
          select count(distinct tenant_subscriptions.tenant_id)::int
          from tenant_subscriptions
          where tenant_subscriptions.status in ('trial', 'active')
            and (tenant_subscriptions.starts_at is null or tenant_subscriptions.starts_at <= ${now})
            and (tenant_subscriptions.ends_at is null or tenant_subscriptions.ends_at > ${now})
        ) as "activeTenants",
        (
          select count(distinct tenant_subscriptions.tenant_id)::int
          from tenant_subscriptions
          where tenant_subscriptions.status in ('trial', 'active')
            and (tenant_subscriptions.starts_at is null or tenant_subscriptions.starts_at <= ${now})
            and tenant_subscriptions.ends_at > ${now}
            and tenant_subscriptions.ends_at <= ${restrictionWindowEnd}
        ) as "tenantsApproachingRestriction",
        (
          select count(*)::int
          from invoices
          where invoices.status = 'issued'
            and invoices.paid_at is null
            and invoices.due_date < ${now}
        ) as "overdueInvoices"
    `);
    return operationsSummaryFactsSchema.parse(
      result.rows[0] ?? {
        activeTenants: 0,
        tenantsApproachingRestriction: 0,
        overdueInvoices: 0,
      },
    );
  }

  async subscriptionsEnding(
    now: Date,
    restrictionWindowEnd: Date,
    limit: number,
  ): Promise<SubscriptionEndingFact[]> {
    const result = await this.db.execute(sql`
      select
        organization.id as "tenantId",
        organization.name as "tenantName",
        tenant_subscriptions.id as "subscriptionId",
        tenant_subscriptions.ends_at as "endsAt"
      from tenant_subscriptions
      inner join organization on organization.id = tenant_subscriptions.tenant_id
      where tenant_subscriptions.status in ('trial', 'active')
        and (tenant_subscriptions.starts_at is null or tenant_subscriptions.starts_at <= ${now})
        and tenant_subscriptions.ends_at > ${now}
        and tenant_subscriptions.ends_at <= ${restrictionWindowEnd}
      order by tenant_subscriptions.ends_at asc, tenant_subscriptions.id asc
      limit ${limit}
    `);
    return result.rows.map((row) => subscriptionEndingFactSchema.parse(row));
  }

  async overdueInvoiceFacts(now: Date, limit: number): Promise<OverdueInvoiceFact[]> {
    const result = await this.db.execute(sql`
      select
        organization.id as "tenantId",
        organization.name as "tenantName",
        invoices.id as "invoiceId",
        invoices.number as "invoiceNumber",
        invoices.due_date as "dueAt"
      from invoices
      inner join organization on organization.id = invoices.tenant_id
      where invoices.status = 'issued'
        and invoices.paid_at is null
        and invoices.due_date < ${now}
      order by invoices.due_date asc, invoices.id asc
      limit ${limit}
    `);
    return result.rows.map((row) => overdueInvoiceFactSchema.parse(row));
  }

  async billingReadiness(limit: number): Promise<{
    operator: BillingReadinessFact;
    tenants: TenantBillingReadinessFact[];
  }> {
    const operatorResult = await this.db.execute(sql`
      select
        exists(
          select 1 from operator_billing_profiles
          where operator_billing_profiles.is_current = true
            and operator_billing_profiles.is_confirmed = true
        ) as "confirmedLegalProfile",
        exists(
          select 1 from operator_bank_accounts
          where operator_bank_accounts.status = 'active'
            and operator_bank_accounts.is_default = true
        ) as "defaultBankAccount"
    `);
    const tenantResult = await this.db.execute(sql`
      select
        organization.id as "tenantId",
        organization.name as "tenantName",
        exists(
          select 1 from tenant_billing_profiles
          where tenant_billing_profiles.tenant_id = organization.id
            and tenant_billing_profiles.is_current = true
            and tenant_billing_profiles.is_confirmed = true
        ) as "confirmedLegalProfile",
        exists(
          select 1 from tenant_bank_accounts
          where tenant_bank_accounts.tenant_id = organization.id
            and tenant_bank_accounts.status = 'active'
            and tenant_bank_accounts.is_default = true
        ) as "defaultBankAccount"
      from organization
      where exists(
        select 1 from tenant_subscriptions
        where tenant_subscriptions.tenant_id = organization.id
          and tenant_subscriptions.status in ('trial', 'active')
      )
        and (
          not exists(
            select 1 from tenant_billing_profiles
            where tenant_billing_profiles.tenant_id = organization.id
              and tenant_billing_profiles.is_current = true
              and tenant_billing_profiles.is_confirmed = true
          )
          or not exists(
            select 1 from tenant_bank_accounts
            where tenant_bank_accounts.tenant_id = organization.id
              and tenant_bank_accounts.status = 'active'
              and tenant_bank_accounts.is_default = true
          )
        )
      order by organization.created_at asc, organization.id asc
      limit ${limit}
    `);
    return {
      operator: billingReadinessFactSchema.parse(
        operatorResult.rows[0] ?? {
          confirmedLegalProfile: false,
          defaultBankAccount: false,
        },
      ),
      tenants: tenantResult.rows.map((row) => tenantBillingReadinessFactSchema.parse(row)),
    };
  }

  async recentActivity(role: PlatformRole, limit: number): Promise<OperationsAuditEventSummary[]> {
    const roleFilter =
      role === "support"
        ? sql`platform_audit_events.action like 'platform.tenant.%'`
        : role === "accountant"
          ? sql`(
              platform_audit_events.action like 'payment.%'
              or platform_audit_events.action like 'billing.%'
              or platform_audit_events.action like 'catalog.%'
              or platform_audit_events.action like 'offer.%'
              or platform_audit_events.action like 'subscription.%'
            )`
          : sql`true`;
    const result = await this.db.execute(sql`
      select
        platform_audit_events.id,
        platform_audit_events.actor_platform_user_id as "actorPlatformUserId",
        platform_audit_events.actor_role as "actorRole",
        platform_audit_events.action,
        platform_audit_events.outcome,
        platform_audit_events.tenant_id as "tenantId",
        platform_audit_events.target_type as "targetType",
        platform_audit_events.target_id as "targetId",
        platform_audit_events.created_at as "createdAt"
      from platform_audit_events
      where ${roleFilter}
      order by platform_audit_events.created_at desc, platform_audit_events.id desc
      limit ${limit}
    `);
    return result.rows.map((row) => operationsAuditEventSummarySchema.parse(row));
  }
}

@Injectable()
export class PlatformOperationsService {
  constructor(
    @Inject(PLATFORM_OPERATIONS_REPOSITORY)
    private readonly repository: PlatformOperationsRepository,
    private readonly readiness: ReadinessService,
    private readonly dadata: PlatformDadataService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async overview(role: PlatformRole): Promise<OperationsOverview> {
    const generatedAt = this.now();
    const restrictionWindowEnd = new Date(
      generatedAt.getTime() + OPERATIONS_RESTRICTION_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
    );
    const [
      summary,
      endingSubscriptions,
      overdueInvoices,
      billingReadiness,
      recentActivity,
      health,
    ] = await Promise.all([
      this.repository.summary(generatedAt, restrictionWindowEnd),
      this.repository.subscriptionsEnding(generatedAt, restrictionWindowEnd, DECISION_QUEUE_LIMIT),
      this.repository.overdueInvoiceFacts(generatedAt, DECISION_QUEUE_LIMIT),
      this.repository.billingReadiness(DECISION_QUEUE_LIMIT),
      this.repository.recentActivity(role, RECENT_ACTIVITY_LIMIT),
      this.monitoring(),
    ]);

    const decisionQueue: OperationsDecisionItem[] = [
      ...overdueInvoices.map((invoice): OperationsDecisionItem => ({
        id: `invoice-overdue:${invoice.invoiceId}`,
        kind: "overdue_invoice",
        severity: "critical",
        tenantId: invoice.tenantId,
        tenantName: invoice.tenantName,
        invoiceId: invoice.invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        dueAt: serializeTimestamp(invoice.dueAt),
      })),
      ...endingSubscriptions.map((subscription): OperationsDecisionItem => ({
        id: `subscription-ending:${subscription.tenantId}:${subscription.subscriptionId}`,
        kind: "subscription_ending",
        severity: "warning",
        tenantId: subscription.tenantId,
        tenantName: subscription.tenantName,
        subscriptionId: subscription.subscriptionId,
        endsAt: serializeTimestamp(subscription.endsAt),
      })),
      ...billingReadinessDecisions(billingReadiness),
    ].slice(0, DECISION_QUEUE_LIMIT);

    return platformOperationsContracts.overview.response.parse({
      generatedAt,
      definitions: {
        activeTenants: {
          version: "active-tenants-v1",
          subscriptionStatuses: ["trial", "active"],
        },
        tenantsApproachingRestriction: {
          version: "subscriptions-ending-v1",
          subscriptionStatuses: ["trial", "active"],
          windowDays: OPERATIONS_RESTRICTION_WINDOW_DAYS,
        },
        overdueInvoices: {
          version: "overdue-invoices-v1",
          invoiceStatuses: ["issued"],
        },
      },
      ...summary,
      decisionQueue,
      recentActivity: [...recentActivity]
        .sort((left, right) => timestampValue(right.createdAt) - timestampValue(left.createdAt))
        .slice(0, RECENT_ACTIVITY_LIMIT),
      health,
    });
  }

  async monitoring(): Promise<PlatformHealth> {
    const [readiness, dadata] = await Promise.all([
      this.readiness.ready(),
      Promise.resolve(this.dadata.status()),
    ]);
    return platformOperationsContracts.monitoring.response.parse({
      ...readiness,
      integrations: { dadata },
    });
  }
}

function billingReadinessDecisions(readiness: {
  operator: BillingReadinessFact;
  tenants: TenantBillingReadinessFact[];
}): OperationsDecisionItem[] {
  const decisions: OperationsDecisionItem[] = [];
  const operatorMissing = missingReadiness(readiness.operator);
  if (operatorMissing.length > 0) {
    decisions.push({
      id: "billing-readiness:operator",
      kind: "billing_readiness",
      severity: "attention",
      party: "operator",
      tenantId: null,
      tenantName: null,
      missing: operatorMissing,
    });
  }
  for (const tenant of readiness.tenants) {
    const missing = missingReadiness(tenant);
    if (missing.length === 0) continue;
    decisions.push({
      id: `billing-readiness:tenant:${tenant.tenantId}`,
      kind: "billing_readiness",
      severity: "attention",
      party: "tenant",
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      missing,
    });
  }
  return decisions;
}

function missingReadiness(
  fact: BillingReadinessFact,
): Array<"confirmed_legal_profile" | "default_bank_account"> {
  const missing: Array<"confirmed_legal_profile" | "default_bank_account"> = [];
  if (!fact.confirmedLegalProfile) missing.push("confirmed_legal_profile");
  if (!fact.defaultBankAccount) missing.push("default_bank_account");
  return missing;
}

function serializeTimestamp(value: Date | string): string {
  return platformTimestampSchema.parse(value instanceof Date ? value.toISOString() : value);
}

function timestampValue(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

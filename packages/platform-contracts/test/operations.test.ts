import { describe, expect, it } from "vitest";

import {
  OPERATIONS_RESTRICTION_WINDOW_DAYS,
  operationsOverviewSchema,
  platformHealthSchema,
} from "../src/operations.js";

const generatedAt = "2026-08-22T08:00:00.000Z";

describe("platform operations contracts", () => {
  it("keeps every overview count tied to an explicit, versioned formula", () => {
    const parsed = operationsOverviewSchema.parse({
      generatedAt,
      definitions: {
        activeTenants: {
          version: "active-tenants-v1",
          subscriptionStatuses: ["trial", "active"],
        },
        tenantsApproachingRestriction: {
          version: "subscriptions-ending-v1",
          subscriptionStatuses: ["trial", "active"],
          windowDays: 14,
        },
        overdueInvoices: {
          version: "overdue-invoices-v1",
          invoiceStatuses: ["issued"],
        },
      },
      activeTenants: 128,
      tenantsApproachingRestriction: 7,
      overdueInvoices: 4,
      decisionQueue: [
        {
          id: "invoice-overdue:00000000-0000-4000-8000-000000000101",
          kind: "overdue_invoice",
          severity: "critical",
          tenantId: "tenant-one",
          tenantName: "ООО Северная линия",
          invoiceId: "00000000-0000-4000-8000-000000000101",
          invoiceNumber: "СЧ-000101",
          dueAt: "2026-08-20T00:00:00.000Z",
        },
        {
          id: "subscription-ending:tenant-two:00000000-0000-4000-8000-000000000102",
          kind: "subscription_ending",
          severity: "warning",
          tenantId: "tenant-two",
          tenantName: "ПромСталь",
          subscriptionId: "00000000-0000-4000-8000-000000000102",
          endsAt: "2026-08-26T08:00:00.000Z",
        },
        {
          id: "billing-readiness:tenant:tenant-three",
          kind: "billing_readiness",
          severity: "attention",
          party: "tenant",
          tenantId: "tenant-three",
          tenantName: "Вектор Пак",
          missing: ["confirmed_legal_profile", "default_bank_account"],
        },
      ],
      recentActivity: [
        {
          id: "00000000-0000-4000-8000-000000000103",
          actorPlatformUserId: "platform-admin",
          actorRole: "platform_admin",
          action: "billing.invoice.issued",
          outcome: "success",
          tenantId: "tenant-one",
          targetType: "invoice",
          targetId: "00000000-0000-4000-8000-000000000101",
          createdAt: "2026-08-22T07:55:00.000Z",
        },
      ],
      health: {
        status: "degraded",
        checkedAt: generatedAt,
        checks: {
          database: { status: "healthy", checkedAt: generatedAt },
          jobs: { status: "healthy", checkedAt: generatedAt },
          smtp: {
            status: "degraded",
            category: "smtp_unavailable",
            checkedAt: generatedAt,
          },
          storage: { status: "healthy", checkedAt: generatedAt },
        },
        integrations: { dadata: { status: "unconfigured" } },
      },
    });

    expect(OPERATIONS_RESTRICTION_WINDOW_DAYS).toBe(14);
    expect(parsed.definitions).toEqual({
      activeTenants: {
        version: "active-tenants-v1",
        subscriptionStatuses: ["trial", "active"],
      },
      tenantsApproachingRestriction: {
        version: "subscriptions-ending-v1",
        subscriptionStatuses: ["trial", "active"],
        windowDays: 14,
      },
      overdueInvoices: {
        version: "overdue-invoices-v1",
        invoiceStatuses: ["issued"],
      },
    });
  });

  it("rejects provider details and unbounded overview collections", () => {
    expect(() =>
      platformHealthSchema.parse({
        status: "unavailable",
        checkedAt: generatedAt,
        checks: {
          database: {
            status: "unavailable",
            category: "postgres://user:secret@database.internal/markiro",
            checkedAt: generatedAt,
          },
          jobs: { status: "healthy", checkedAt: generatedAt },
          smtp: { status: "healthy", checkedAt: generatedAt },
          storage: { status: "healthy", checkedAt: generatedAt },
        },
        integrations: { dadata: { status: "ready" } },
      }),
    ).toThrow();

    const oversized = Array.from({ length: 101 }, (_, index) => ({
      id: `billing-readiness:tenant:tenant-${index}`,
      kind: "billing_readiness" as const,
      severity: "attention" as const,
      party: "tenant" as const,
      tenantId: `tenant-${index}`,
      tenantName: `Tenant ${index}`,
      missing: ["confirmed_legal_profile" as const],
    }));
    expect(() =>
      operationsOverviewSchema.parse({
        generatedAt,
        definitions: {
          activeTenants: {
            version: "active-tenants-v1",
            subscriptionStatuses: ["trial", "active"],
          },
          tenantsApproachingRestriction: {
            version: "subscriptions-ending-v1",
            subscriptionStatuses: ["trial", "active"],
            windowDays: 14,
          },
          overdueInvoices: {
            version: "overdue-invoices-v1",
            invoiceStatuses: ["issued"],
          },
        },
        activeTenants: 0,
        tenantsApproachingRestriction: 0,
        overdueInvoices: 0,
        decisionQueue: oversized,
        recentActivity: [],
        health: {
          status: "ok",
          checkedAt: generatedAt,
          checks: {
            database: { status: "healthy", checkedAt: generatedAt },
            jobs: { status: "healthy", checkedAt: generatedAt },
            smtp: { status: "healthy", checkedAt: generatedAt },
            storage: { status: "healthy", checkedAt: generatedAt },
          },
          integrations: { dadata: { status: "ready" } },
        },
      }),
    ).toThrow();
  });

  it("accepts an overview with capability-redacted billing and diagnostics", () => {
    const parsed = operationsOverviewSchema.parse({
      generatedAt,
      definitions: {
        activeTenants: {
          version: "active-tenants-v1",
          subscriptionStatuses: ["trial", "active"],
        },
        tenantsApproachingRestriction: {
          version: "subscriptions-ending-v1",
          subscriptionStatuses: ["trial", "active"],
          windowDays: 14,
        },
        overdueInvoices: {
          version: "overdue-invoices-v1",
          invoiceStatuses: ["issued"],
        },
      },
      activeTenants: 2,
      tenantsApproachingRestriction: 1,
      overdueInvoices: null,
      decisionQueue: [],
      recentActivity: [],
      health: null,
    });

    expect(parsed.overdueInvoices).toBeNull();
    expect(parsed.health).toBeNull();
  });
});

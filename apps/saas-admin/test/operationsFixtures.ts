import type { OperationsOverview, PlatformHealth } from "@markiro/platform-contracts";
import { vi } from "vitest";

import type { PlatformPrincipal } from "../src/auth/PlatformAuthBoundary.js";
import { jsonResponse, PLATFORM_ADMIN_ME } from "./render.js";

export const HEALTHY_PLATFORM = {
  status: "ok",
  checkedAt: "2026-08-22T09:30:00.000Z",
  checks: {
    database: { status: "healthy", checkedAt: "2026-08-22T09:30:00.000Z" },
    jobs: { status: "healthy", checkedAt: "2026-08-22T09:30:00.000Z" },
    smtp: { status: "healthy", checkedAt: "2026-08-22T09:30:00.000Z" },
    storage: { status: "healthy", checkedAt: "2026-08-22T09:30:00.000Z" },
  },
  integrations: { dadata: { status: "ready" } },
} satisfies PlatformHealth;

export const DEGRADED_PLATFORM = {
  ...HEALTHY_PLATFORM,
  status: "degraded",
  checks: {
    ...HEALTHY_PLATFORM.checks,
    smtp: {
      status: "degraded",
      checkedAt: "2026-08-22T09:30:00.000Z",
      category: "smtp_timeout",
    },
  },
} satisfies PlatformHealth;

export const OPERATIONS_OVERVIEW = {
  generatedAt: "2026-08-22T09:30:00.000Z",
  definitions: {
    activeTenants: { version: "active-tenants-v1", subscriptionStatuses: ["trial", "active"] },
    tenantsApproachingRestriction: {
      version: "subscriptions-ending-v1",
      subscriptionStatuses: ["trial", "active"],
      windowDays: 14,
    },
    overdueInvoices: { version: "overdue-invoices-v1", invoiceStatuses: ["issued"] },
  },
  activeTenants: 12,
  tenantsApproachingRestriction: 3,
  overdueInvoices: 2,
  decisionQueue: [
    {
      id: "overdue:11111111-1111-4111-8111-111111111111",
      kind: "overdue_invoice",
      severity: "critical",
      tenantId: "21111111-1111-4111-8111-111111111111",
      tenantName: "Первый завод",
      invoiceId: "11111111-1111-4111-8111-111111111111",
      invoiceNumber: "MK-42",
      dueAt: "2026-08-18T00:00:00.000Z",
    },
    {
      id: "ending:31111111-1111-4111-8111-111111111111",
      kind: "subscription_ending",
      severity: "warning",
      tenantId: "21111111-1111-4111-8111-111111111111",
      tenantName: "Первый завод",
      subscriptionId: "31111111-1111-4111-8111-111111111111",
      endsAt: "2026-08-26T00:00:00.000Z",
    },
    {
      id: "readiness:tenant:21111111-1111-4111-8111-111111111111",
      kind: "billing_readiness",
      severity: "attention",
      party: "tenant",
      tenantId: "21111111-1111-4111-8111-111111111111",
      tenantName: "Первый завод",
      missing: ["confirmed_legal_profile"],
    },
    {
      id: "readiness:operator",
      kind: "billing_readiness",
      severity: "attention",
      party: "operator",
      tenantId: null,
      tenantName: null,
      missing: ["default_bank_account"],
    },
  ],
  recentActivity: [
    {
      id: "41111111-1111-4111-8111-111111111111",
      actorPlatformUserId: "user-1",
      actorRole: "platform_admin",
      action: "tenant.created",
      outcome: "success",
      tenantId: "21111111-1111-4111-8111-111111111111",
      targetType: "tenant",
      targetId: "21111111-1111-4111-8111-111111111111",
      createdAt: "2026-08-22T09:00:00.000Z",
    },
  ],
  health: HEALTHY_PLATFORM,
} satisfies OperationsOverview;

export function installOperationsApi({
  me = PLATFORM_ADMIN_ME,
  overview = OPERATIONS_OVERVIEW,
  monitoring = HEALTHY_PLATFORM,
  overviewStatus = 200,
  monitoringStatus = 200,
}: {
  me?: PlatformPrincipal;
  overview?: unknown;
  monitoring?: unknown;
  overviewStatus?: number;
  monitoringStatus?: number;
} = {}) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, me);
      if (url.endsWith("/api/platform/operations/overview")) {
        return jsonResponse(
          overviewStatus,
          overviewStatus === 200 ? overview : { code: "operations_unavailable" },
        );
      }
      if (url.endsWith("/api/platform/operations/monitoring")) {
        return jsonResponse(
          monitoringStatus,
          monitoringStatus === 200 ? monitoring : { code: "monitoring_unavailable" },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  return { requests };
}

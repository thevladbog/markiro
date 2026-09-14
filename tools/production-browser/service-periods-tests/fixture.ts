import { test as base, expect } from "@playwright/test";
import type { Route } from "@playwright/test";
import {
  catalogVersionV4Schema,
  platformCapabilitiesForRole,
  platformServicePeriodContracts,
} from "../../../packages/platform-contracts/src/index.js";

const NOW = "2026-09-15T09:00:00.000Z";
export const ACTIVE_PERIOD_ID = "71111111-1111-4111-8111-111111111181";

export const monthlyService = catalogVersionV4Schema.parse({
  id: "61111111-1111-4111-8111-111111111181",
  catalogItemId: "51111111-1111-4111-8111-111111111181",
  catalogItemCode: "monthly-support",
  documentNameRu: "Абонентское сопровождение",
  documentNameEn: "Monthly support",
  subject: "service",
  sellerPolicyRevision: 1,
  lifecyclePolicyId: null,
  kind: "service",
  version: 1,
  status: "published",
  nameRu: "Сервисное сопровождение",
  nameEn: "Service support",
  descriptionRu: "Консультации и настройка интеграций",
  descriptionEn: "Consulting and integration setup",
  unit: "month",
  billingMode: "recurring",
  billingPeriod: "month",
  unitPrice: "30000.00",
  vatRateBps: null,
  vatIncluded: false,
  publishedAt: NOW,
  publishedByPlatformUserId: "fixture-admin",
  service: {
    cadence: "month",
    includedMinutes: 180,
    carryover: "none",
    excessPolicy: "external_approval",
    scopeRu: "Консультации и настройка интеграций",
    scopeEn: "Consulting and integration setup",
    operatingHoursRu: "Будни, 09:00–18:00 МСК",
    operatingHoursEn: "Weekdays, 09:00–18:00 MSK",
    schedulingTermsRu: "По согласованной заявке",
    schedulingTermsEn: "By an agreed request",
  },
});

const active = {
  id: ACTIVE_PERIOD_ID,
  tenantId: "service-fixture",
  orderedServiceId: "72111111-1111-4111-8111-111111111181",
  catalogItemId: monthlyService.catalogItemId,
  catalogVersionId: monthlyService.id,
  nameRu: monthlyService.nameRu,
  nameEn: monthlyService.nameEn,
  startsAt: "2026-09-01T00:00:00.000Z",
  endsAt: "2026-10-01T00:00:00.000Z",
  state: "active",
  revision: 5,
  balance: { included: 180, externallyApproved: 30, consumed: 75, remaining: 135 },
} as const;

const exhausted = {
  ...active,
  id: "71111111-1111-4111-8111-111111111182",
  orderedServiceId: "72111111-1111-4111-8111-111111111182",
  nameRu: "Операционная поддержка",
  nameEn: "Operations support",
  balance: { included: 60, externallyApproved: 30, consumed: 90, remaining: 0 },
} as const;

const detail = platformServicePeriodContracts.detail.response.parse({
  ...active,
  invoiceId: "73111111-1111-4111-8111-111111111181",
  invoiceLineId: "74111111-1111-4111-8111-111111111181",
  paymentId: "75111111-1111-4111-8111-111111111181",
  entries: [
    {
      id: "76111111-1111-4111-8111-111111111181",
      kind: "usage",
      classification: "customer_service",
      originalEntryId: null,
      workReference: "SUP-42",
      description: "Настройка интеграции",
      performedAt: "2026-09-10T08:00:00.000Z",
      postedAt: "2026-09-10T10:00:00.000Z",
      actualMinutesDelta: 60,
      allowanceMinutesDelta: 60,
      billingActId: null,
      internalNote: "Синтетическая внутренняя заметка",
      actorPlatformUserId: "fixture-admin",
      requestId: "77111111-1111-4111-8111-111111111181",
    },
    {
      id: "76111111-1111-4111-8111-111111111182",
      kind: "correction",
      classification: "customer_service",
      originalEntryId: "76111111-1111-4111-8111-111111111181",
      workReference: "SUP-42",
      description: "Уточнение фактического времени",
      performedAt: "2026-09-10T08:00:00.000Z",
      postedAt: "2026-09-11T10:00:00.000Z",
      actualMinutesDelta: -5,
      allowanceMinutesDelta: -5,
      billingActId: null,
      internalNote: null,
      actorPlatformUserId: "fixture-admin",
      requestId: "77111111-1111-4111-8111-111111111182",
    },
    {
      id: "76111111-1111-4111-8111-111111111183",
      kind: "usage",
      classification: "product_defect",
      originalEntryId: null,
      workReference: "BUG-7",
      description: "Исправление дефекта Маркиро",
      performedAt: "2026-09-12T08:00:00.000Z",
      postedAt: "2026-09-12T09:00:00.000Z",
      actualMinutesDelta: 20,
      allowanceMinutesDelta: 0,
      billingActId: null,
      internalNote: null,
      actorPlatformUserId: "fixture-admin",
      requestId: "77111111-1111-4111-8111-111111111183",
    },
  ],
  approvals: [
    {
      id: "78111111-1111-4111-8111-111111111181",
      kind: "approval",
      originalApprovalId: null,
      minuteDelta: 30,
      externalReference: "SUP-APPROVAL-7",
      externalUrl: null,
      approvedAt: "2026-09-09T08:00:00.000Z",
      reason: "Согласованы дополнительные работы",
      actorPlatformUserId: "fixture-admin",
      requestId: "79111111-1111-4111-8111-111111111181",
      postedAt: "2026-09-09T09:00:00.000Z",
    },
  ],
});

function makeFixture() {
  return { unhandled: [] as string[] };
}

export const test = base.extend<{ fixture: ReturnType<typeof makeFixture> }>({
  fixture: async ({ context, baseURL }, use) => {
    const fixture = makeFixture();
    const origin = new URL(baseURL!).origin;
    await context.route("**/*", async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        fixture.unhandled.push(request.url());
        await route.abort();
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        await route.continue();
        return;
      }
      const method = request.method();
      let json: unknown;
      if (url.pathname === "/api/platform-auth/get-session" && method === "GET") {
        json = {
          session: { id: "fixture-session", expiresAt: "2027-01-01T00:00:00Z" },
          user: {
            id: "fixture-admin",
            email: "fixture@example.invalid",
            name: "Fixture",
            twoFactorEnabled: true,
          },
        };
      } else if (url.pathname === "/api/platform/me" && method === "GET") {
        json = {
          userId: "fixture-admin",
          role: "platform_admin",
          capabilities: platformCapabilitiesForRole.platform_admin,
          twoFactorReady: true,
        };
      } else if (url.pathname === "/api/platform/catalog/items" && method === "GET") {
        json = { items: [monthlyService] };
      } else if (url.pathname === "/api/platform/settings/demo-plan" && method === "GET") {
        json = { catalogVersionId: null };
      } else if (url.pathname === "/api/platform/service-periods" && method === "GET") {
        json = platformServicePeriodContracts.list.response.parse({
          items: [active, exhausted],
          nextCursor: null,
        });
      } else if (
        url.pathname === `/api/platform/service-periods/${ACTIVE_PERIOD_ID}` &&
        method === "GET"
      ) {
        json = detail;
      } else {
        fixture.unhandled.push(`${method} ${url.pathname}${url.search}`);
        await route.abort();
        return;
      }
      await route.fulfill({ json, headers: { "Cache-Control": "no-store" } });
    });
    await use(fixture);
    await context.unrouteAll({ behavior: "wait" });
    expect(fixture.unhandled, "Every API request must be explicitly intercepted").toEqual([]);
  },
});

export { expect };

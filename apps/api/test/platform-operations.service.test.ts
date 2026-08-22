import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import type { PlatformRole } from "@markiro/platform-contracts";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ReadinessService } from "../src/health/readiness.service";
import type { PlatformDadataService } from "../src/modules/platform-dadata/platform-dadata.service";
import {
  PlatformOperationsService,
  DrizzlePlatformOperationsRepository,
  type PlatformOperationsRepository,
} from "../src/modules/platform-operations/platform-operations.service";
import { createPublishedPlan } from "./support/subscription-fixtures";

const NOW = new Date("2026-08-22T08:00:00.000Z");

function repositoryFixture(): PlatformOperationsRepository {
  return {
    summary: vi.fn(async () => ({
      activeTenants: 2,
      tenantsApproachingRestriction: 1,
      overdueInvoices: 1,
    })),
    subscriptionsEnding: vi.fn(async () => [
      {
        tenantId: "tenant-ending",
        tenantName: "ПромСталь",
        subscriptionId: "00000000-0000-4000-8000-000000000102",
        endsAt: "2026-08-26T08:00:00.000Z",
      },
    ]),
    overdueInvoiceFacts: vi.fn(async () => [
      {
        tenantId: "tenant-overdue",
        tenantName: "ООО Северная линия",
        invoiceId: "00000000-0000-4000-8000-000000000101",
        invoiceNumber: "СЧ-000101",
        dueAt: "2026-08-20T00:00:00.000Z",
      },
    ]),
    billingReadiness: vi.fn(async () => ({
      operator: { confirmedLegalProfile: true, defaultBankAccount: true },
      tenants: [
        {
          tenantId: "tenant-unready",
          tenantName: "Вектор Пак",
          confirmedLegalProfile: false,
          defaultBankAccount: false,
        },
      ],
    })),
    recentActivity: vi.fn(async (_role: PlatformRole) => [
      {
        id: "00000000-0000-4000-8000-000000000104",
        actorPlatformUserId: "platform-support",
        actorRole: "support" as const,
        action: "platform.tenant.updated",
        outcome: "success" as const,
        tenantId: "tenant-ending",
        targetType: "tenant",
        targetId: "tenant-ending",
        createdAt: "2026-08-22T07:50:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000103",
        actorPlatformUserId: "platform-admin",
        actorRole: "platform_admin" as const,
        action: "billing.invoice.issued",
        outcome: "success" as const,
        tenantId: "tenant-overdue",
        targetType: "invoice",
        targetId: "00000000-0000-4000-8000-000000000101",
        createdAt: "2026-08-22T07:55:00.000Z",
      },
    ]),
  };
}

function healthDependencies() {
  const checkedAt = NOW.toISOString();
  const readiness = {
    ready: vi.fn(async () => ({
      status: "degraded" as const,
      checkedAt,
      checks: {
        database: { status: "healthy" as const, checkedAt },
        jobs: { status: "healthy" as const, checkedAt },
        smtp: {
          status: "degraded" as const,
          category: "smtp_unavailable" as const,
          checkedAt,
        },
        storage: { status: "healthy" as const, checkedAt },
      },
    })),
  } as unknown as ReadinessService;
  const dadata = {
    status: vi.fn(() => ({ status: "unconfigured" as const })),
  } as unknown as PlatformDadataService;
  return { readiness, dadata };
}

describe("PlatformOperationsService", () => {
  it("builds a bounded decision queue without letting billing readiness change active access", async () => {
    const repository = repositoryFixture();
    const { readiness, dadata } = healthDependencies();
    const service = new PlatformOperationsService(repository, readiness, dadata, () => NOW);

    const result = await service.overview("platform_admin");

    expect(result.activeTenants).toBe(2);
    expect(result.tenantsApproachingRestriction).toBe(1);
    expect(result.overdueInvoices).toBe(1);
    expect(result.definitions).toEqual({
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
    expect(result.decisionQueue.map((item) => item.kind)).toEqual([
      "overdue_invoice",
      "subscription_ending",
      "billing_readiness",
    ]);
    expect(result.recentActivity.map((event) => event.id)).toEqual([
      "00000000-0000-4000-8000-000000000103",
      "00000000-0000-4000-8000-000000000104",
    ]);
    expect(repository.summary).toHaveBeenCalledWith(NOW, new Date("2026-09-05T08:00:00.000Z"));
  });

  it("adds the operator decision separately when Markiro billing data is incomplete", async () => {
    const repository = repositoryFixture();
    vi.mocked(repository.billingReadiness).mockResolvedValue({
      operator: { confirmedLegalProfile: false, defaultBankAccount: true },
      tenants: [],
    });
    const { readiness, dadata } = healthDependencies();
    const service = new PlatformOperationsService(repository, readiness, dadata, () => NOW);

    const result = await service.overview("accountant");

    expect(result.activeTenants).toBe(2);
    expect(result.decisionQueue.at(-1)).toEqual({
      id: "billing-readiness:operator",
      kind: "billing_readiness",
      severity: "attention",
      party: "operator",
      tenantId: null,
      tenantName: null,
      missing: ["confirmed_legal_profile"],
    });
    expect(repository.recentActivity).toHaveBeenCalledWith("accountant", 10);
  });

  it("returns cached readiness and DaData state without infrastructure details", async () => {
    const repository = repositoryFixture();
    const { readiness, dadata } = healthDependencies();
    const service = new PlatformOperationsService(repository, readiness, dadata, () => NOW);

    const result = await service.monitoring();

    expect(result).toEqual({
      status: "degraded",
      checkedAt: NOW.toISOString(),
      checks: {
        database: { status: "healthy", checkedAt: NOW.toISOString() },
        jobs: { status: "healthy", checkedAt: NOW.toISOString() },
        smtp: {
          status: "degraded",
          category: "smtp_unavailable",
          checkedAt: NOW.toISOString(),
        },
        storage: { status: "healthy", checkedAt: NOW.toISOString() },
      },
      integrations: { dadata: { status: "unconfigured" } },
    });
    expect(JSON.stringify(result)).not.toMatch(/host|bucket|credential|stack|secret/i);
  });
});

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("DrizzlePlatformOperationsRepository", () => {
  const databaseName = `markiro_platform_operations_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratchUrl.toString());
  const repository = new DrizzlePlatformOperationsRepository(connection.db);
  const actorId = `operations-${randomUUID()}`;
  const endingTenantId = `operations-ending-${randomUUID()}`;
  const activeTenantId = `operations-active-${randomUUID()}`;
  const expiredTenantId = `operations-expired-${randomUUID()}`;
  const endingSubscriptionId = "00000000-0000-4000-8000-000000000201";
  const overdueInvoiceId = "00000000-0000-4000-8000-000000000202";

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    await connection.db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Operations actor",
      email: `${actorId}@example.invalid`,
      role: "platform_admin",
      status: "active",
    });
    await connection.db.insert(schema.organization).values([
      { id: endingTenantId, name: "Ending tenant", slug: endingTenantId, createdAt: NOW },
      { id: activeTenantId, name: "Active tenant", slug: activeTenantId, createdAt: NOW },
      { id: expiredTenantId, name: "Expired tenant", slug: expiredTenantId, createdAt: NOW },
    ]);
    const planVersionId = await createPublishedPlan(connection.db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
    });
    await connection.db.insert(schema.tenantSubscriptions).values([
      {
        id: endingSubscriptionId,
        tenantId: endingTenantId,
        planVersionId,
        status: "active",
        startsAt: new Date("2026-08-01T08:00:00.000Z"),
        endsAt: new Date("2026-08-26T08:00:00.000Z"),
        source: "manual",
      },
      {
        id: "00000000-0000-4000-8000-000000000203",
        tenantId: activeTenantId,
        planVersionId,
        status: "trial",
        startsAt: new Date("2026-08-01T08:00:00.000Z"),
        endsAt: null,
        source: "demo",
      },
      {
        id: "00000000-0000-4000-8000-000000000204",
        tenantId: expiredTenantId,
        planVersionId,
        status: "expired",
        startsAt: new Date("2026-07-01T08:00:00.000Z"),
        endsAt: new Date("2026-08-01T08:00:00.000Z"),
        source: "manual",
      },
    ]);
    await connection.db.insert(schema.operatorBillingProfiles).values({
      revision: 1,
      kind: "legal_entity",
      fullName: "ООО Маркиро",
      displayName: "Маркиро",
      inn: "7700000000",
      kpp: "770001001",
      ogrn: "1027700000000",
      addressRaw: "Москва",
      legalAddressRaw: "Москва",
      postalSameAsLegal: true,
      isConfirmed: true,
      confirmedByPlatformUserId: actorId,
      confirmedAt: NOW,
      createdByPlatformUserId: actorId,
    });
    await connection.db.insert(schema.operatorBankAccounts).values({
      label: "Основной",
      settlementAccount: "40702810900000000001",
      bic: "044525225",
      bankName: "ПАО Сбербанк",
      correspondentAccount: "30101810400000000225",
      isDefault: true,
      createdByPlatformUserId: actorId,
    });
    await connection.db.insert(schema.tenantBillingProfiles).values({
      tenantId: endingTenantId,
      revision: 1,
      kind: "legal_entity",
      fullName: "ООО Ending tenant",
      displayName: "Ending tenant",
      inn: "7800000000",
      kpp: "780001001",
      ogrn: "1027800000000",
      addressRaw: "Санкт-Петербург",
      legalAddressRaw: "Санкт-Петербург",
      postalSameAsLegal: true,
      isConfirmed: true,
      confirmedByPlatformUserId: actorId,
      confirmedAt: NOW,
      createdByPlatformUserId: actorId,
    });
    await connection.db.insert(schema.tenantBankAccounts).values({
      tenantId: endingTenantId,
      label: "Основной",
      settlementAccount: "40702810900000000002",
      bic: "044525225",
      bankName: "ПАО Сбербанк",
      correspondentAccount: "30101810400000000225",
      isDefault: true,
      createdByPlatformUserId: actorId,
    });
    await connection.db.insert(schema.invoices).values([
      {
        id: overdueInvoiceId,
        tenantId: endingTenantId,
        number: "СЧ-000202",
        status: "issued",
        issueDate: new Date("2026-08-01T00:00:00.000Z"),
        dueDate: new Date("2026-08-20T00:00:00.000Z"),
        sellerSnapshot: {},
        buyerSnapshot: {},
        createdByPlatformUserId: actorId,
      },
      {
        id: "00000000-0000-4000-8000-000000000205",
        tenantId: activeTenantId,
        number: "СЧ-000205",
        status: "draft",
        dueDate: new Date("2026-08-19T00:00:00.000Z"),
        createdByPlatformUserId: actorId,
      },
    ]);
    await connection.db.insert(schema.platformAuditEvents).values([
      {
        id: "00000000-0000-4000-8000-000000000206",
        actorPlatformUserId: actorId,
        actorRole: "platform_admin",
        action: "platform.tenant.updated",
        outcome: "success",
        tenantId: endingTenantId,
        targetType: "tenant",
        targetId: endingTenantId,
        before: null,
        after: null,
        createdAt: new Date("2026-08-22T07:50:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000207",
        actorPlatformUserId: actorId,
        actorRole: "platform_admin",
        action: "billing.invoice.issued",
        outcome: "success",
        tenantId: endingTenantId,
        targetType: "invoice",
        targetId: overdueInvoiceId,
        before: null,
        after: null,
        createdAt: new Date("2026-08-22T07:55:00.000Z"),
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenance.pool.end();
  });

  it("derives active, approaching, overdue, readiness, and role-scoped audit facts", async () => {
    const windowEnd = new Date("2026-09-05T08:00:00.000Z");

    await expect(repository.summary(NOW, windowEnd)).resolves.toEqual({
      activeTenants: 2,
      tenantsApproachingRestriction: 1,
      overdueInvoices: 1,
    });
    const ending = await repository.subscriptionsEnding(NOW, windowEnd, 25);
    expect(ending).toHaveLength(1);
    expect(ending[0]).toMatchObject({
      tenantId: endingTenantId,
      tenantName: "Ending tenant",
      subscriptionId: endingSubscriptionId,
    });
    expect(new Date(ending[0]!.endsAt).toISOString()).toBe("2026-08-26T08:00:00.000Z");
    const overdue = await repository.overdueInvoiceFacts(NOW, 25);
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({
      tenantId: endingTenantId,
      tenantName: "Ending tenant",
      invoiceId: overdueInvoiceId,
      invoiceNumber: "СЧ-000202",
    });
    expect(new Date(overdue[0]!.dueAt).toISOString()).toBe("2026-08-20T00:00:00.000Z");
    await expect(repository.billingReadiness(25)).resolves.toEqual({
      operator: { confirmedLegalProfile: true, defaultBankAccount: true },
      tenants: [
        {
          tenantId: activeTenantId,
          tenantName: "Active tenant",
          confirmedLegalProfile: false,
          defaultBankAccount: false,
        },
      ],
    });
    expect((await repository.recentActivity("platform_admin", 10)).map((item) => item.id)).toEqual([
      "00000000-0000-4000-8000-000000000207",
      "00000000-0000-4000-8000-000000000206",
    ]);
    expect((await repository.recentActivity("support", 10)).map((item) => item.id)).toEqual([
      "00000000-0000-4000-8000-000000000206",
    ]);
  });
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}

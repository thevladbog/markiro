import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BillingApplicationService } from "../src/modules/billing/billing-application.service";
import { ServicePeriodsService } from "../src/modules/service-periods/service-periods.service";
import { ServicePeriodObservability } from "../src/modules/service-periods/service-period-observability";
import type { ServiceLedgerEvent } from "../src/modules/service-periods/service-period-observability";
import type { PlatformPrincipal } from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { SubscriptionLifecycleService } from "../src/subscriptions/subscription-lifecycle.service";
import { createOrganization } from "./support/subscription-fixtures";

const databaseUrl = process.env.DATABASE_URL;
const support: PlatformPrincipal = {
  userId: `service-support-${randomUUID()}`,
  role: "support",
  capabilities: [
    "tenants.read",
    "tenants.write",
    "catalog.read",
    "services.read",
    "services.write",
    "agreements.read",
    "audit.read",
    "diagnostics.read",
  ],
  twoFactorReady: true,
};

describe.skipIf(!databaseUrl)("service period ledger", () => {
  const databaseName = `markiro_service_ledger_${randomUUID().replaceAll("-", "_")}`;
  const scratch = new URL(databaseUrl ?? "postgres://invalid");
  scratch.pathname = `/${databaseName}`;
  scratch.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let tenantId: string;
  let catalogItemId: string;
  let catalogVersionId: string;
  let application: BillingApplicationService;
  let service: ServicePeriodsService;
  let ledgerEvent: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratch.toString());
    db = connection.db;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
    await db.insert(schema.platformUsers).values({
      id: support.userId,
      name: "Service support",
      email: `${support.userId}@example.invalid`,
      role: support.role,
      status: "active",
    });
    tenantId = await createOrganization(db);
    catalogItemId = randomUUID();
    catalogVersionId = randomUUID();
    await db.insert(schema.catalogItems).values({
      id: catalogItemId,
      code: `support-${catalogItemId}`,
      nameRu: "Поддержка",
      nameEn: "Support",
      kind: "service",
    });
    await db.insert(schema.catalogItemVersions).values({
      id: catalogVersionId,
      catalogItemId,
      kind: "service",
      version: 1,
      status: "published",
      documentNameRu: "Абонентское сопровождение",
      documentNameEn: "Monthly support",
      subject: "service",
      sellerPolicyRevision: 1,
      nameRu: "Поддержка",
      nameEn: "Support",
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      serviceTerms: {
        cadence: "month",
        includedMinutes: 180,
        carryover: "none",
        excessPolicy: "external_approval",
        scopeRu: "Консультации",
        scopeEn: "Consulting",
        operatingHoursRu: null,
        operatingHoursEn: null,
        schedulingTermsRu: null,
        schedulingTermsEn: null,
      },
      unitPrice: "30000.00",
      vatIncluded: false,
      publishedAt: new Date(),
      publishedByPlatformUserId: support.userId,
    });
    const audit = new PlatformAuditService();
    application = new BillingApplicationService(
      db,
      new SubscriptionLifecycleService(db, audit),
      audit,
    );
    const observability = new ServicePeriodObservability();
    ledgerEvent = vi.spyOn(observability, "record").mockImplementation(() => undefined);
    service = new ServicePeriodsService(db, audit, observability);
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE "${databaseName}"`);
    await maintenance.pool.end();
  });

  async function createPeriod() {
    const invoiceId = randomUUID();
    const lineId = randomUUID();
    const paymentId = randomUUID();
    const paidAt = new Date();
    await db.insert(schema.invoices).values({
      id: invoiceId,
      tenantId,
      number: `INV-${randomUUID()}`,
      status: "paid",
      issueDate: paidAt,
      paidAt,
      sellerSnapshot: { name: "Markiro" },
      buyerSnapshot: { name: tenantId },
      subtotal: "30000.00",
      vatTotal: "0.00",
      total: "30000.00",
      applicationMode: "manual",
      createdByPlatformUserId: support.userId,
      issuedByPlatformUserId: support.userId,
      issuedAt: paidAt,
    });
    await db.insert(schema.invoiceLines).values({
      id: lineId,
      tenantId,
      invoiceId,
      position: 1,
      kind: "service",
      catalogVersionId,
      catalogKind: "service",
      nameRu: "Абонентское сопровождение",
      nameEn: "Monthly support",
      quantity: 1,
      unit: "month",
      agreedUnitPrice: "30000.00",
      vatIncluded: false,
      lineSubtotal: "30000.00",
      lineVat: "0.00",
      lineTotal: "30000.00",
      commercialTerms: {
        version: 2,
        subject: "service",
        documentNameRu: "Абонентское сопровождение",
        documentNameEn: "Monthly support",
        sellerPolicyRevision: 1,
        billingPeriod: "month",
        billingTimezone: "Europe/Moscow",
        activationRule: "after_current",
        serviceTerms: {
          cadence: "month",
          includedMinutes: 180,
          carryover: "none",
          excessPolicy: "external_approval",
          scopeRu: "Консультации",
          scopeEn: "Consulting",
          operatingHoursRu: null,
          operatingHoursEn: null,
          schedulingTermsRu: null,
          schedulingTermsEn: null,
        },
      },
    });
    await db.insert(schema.billingPayments).values({
      id: paymentId,
      tenantId,
      invoiceId,
      source: "manual",
      paidAt,
      amount: "30000.00",
      bankReference: `PAY-${paymentId}`,
      platformUserId: support.userId,
      idempotencyKey: `payment:${paymentId}`,
    });
    await db
      .insert(schema.invoicePaymentCompletions)
      .values({ tenantId, invoiceId, billingPaymentId: paymentId });
    await application.apply(support, invoiceId, { reason: "Activate", lines: [{ lineId }] });
    const [period] = await db
      .select()
      .from(schema.servicePeriods)
      .where(eq(schema.servicePeriods.invoiceLineId, lineId));
    if (!period) throw new Error("period fixture missing");
    return period;
  }

  it("posts usage, preserves defect allowance, corrects usage, and replays exactly", async () => {
    const period = await createPeriod();
    const performedAt = new Date(period.startsAt.getTime() + 60_000);
    const requestId = randomUUID();
    const first = await service.postUsage(support, period.id, {
      requestId,
      expectedRevision: 1,
      classification: "customer_service",
      performedAt: performedAt.toISOString(),
      actualMinutes: 45,
      allowanceMinutes: 45,
      workReference: "SUP-42",
      description: "Настройка интеграции",
      internalNote: "Диагностика завершена",
    });
    expect(first).toEqual({
      revision: 2,
      balance: { included: 180, externallyApproved: 0, consumed: 45, remaining: 135 },
    });
    expect(ledgerEvent).toHaveBeenLastCalledWith({
      event: "usage_posted",
      count: 1,
      periodId: period.id,
      actualMinutes: 45,
      allowanceMinutes: 45,
    });
    const eventsAfterFirst = ledgerEvent.mock.calls.length;
    expect(
      await service.postUsage(support, period.id, {
        requestId,
        expectedRevision: 1,
        classification: "customer_service",
        performedAt: performedAt.toISOString(),
        actualMinutes: 45,
        allowanceMinutes: 45,
        workReference: "SUP-42",
        description: "Настройка интеграции",
        internalNote: "Диагностика завершена",
      }),
    ).toEqual(first);
    expect(ledgerEvent.mock.calls).toHaveLength(eventsAfterFirst);
    await expect(
      service.postUsage(support, period.id, {
        requestId,
        expectedRevision: 1,
        classification: "customer_service",
        performedAt: performedAt.toISOString(),
        actualMinutes: 46,
        allowanceMinutes: 45,
        workReference: "SUP-42",
        description: "Настройка интеграции",
        internalNote: "Диагностика завершена",
      }),
    ).rejects.toMatchObject({ response: { code: "SERVICE_REQUEST_CONFLICT" } });

    const detail = await service.detail(support, period.id);
    const original = detail.entries[0];
    if (!original) throw new Error("usage fixture missing");
    const [auditEvent] = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.action, "service_period.usage_posted"),
          eq(schema.platformAuditEvents.requestId, requestId),
        ),
      );
    expect(auditEvent).toMatchObject({
      actorPlatformUserId: support.userId,
      actorRole: "support",
      tenantId,
      targetType: "service_usage_entry",
      targetId: original.id,
      before: {
        servicePeriodId: period.id,
        revision: 1,
        balance: { included: 180, externallyApproved: 0, consumed: 0, remaining: 180 },
      },
      after: {
        servicePeriodId: period.id,
        revision: 2,
        actualMinutesDelta: 45,
        allowanceMinutesDelta: 45,
        balance: { included: 180, externallyApproved: 0, consumed: 45, remaining: 135 },
      },
      requestId,
    });
    const defect = await service.postUsage(support, period.id, {
      requestId: randomUUID(),
      expectedRevision: 2,
      classification: "product_defect",
      performedAt: performedAt.toISOString(),
      actualMinutes: 20,
      allowanceMinutes: 0,
      workReference: "BUG-7",
      description: "Исправление дефекта",
      internalNote: null,
    });
    expect(defect.balance.consumed).toBe(45);
    expect(ledgerEvent).toHaveBeenLastCalledWith({
      event: "defect_work_posted",
      count: 1,
      periodId: period.id,
      actualMinutes: 20,
      allowanceMinutes: 0,
    });
    const corrected = await service.correctUsage(support, period.id, original.id, {
      requestId: randomUUID(),
      expectedRevision: 3,
      classification: "customer_service",
      actualMinutesDelta: -15,
      allowanceMinutesDelta: -15,
      description: "Уточнение времени",
      internalNote: null,
    });
    expect(corrected.balance).toEqual({
      included: 180,
      externallyApproved: 0,
      consumed: 30,
      remaining: 150,
    });
    expect(ledgerEvent).toHaveBeenLastCalledWith({
      event: "correction_posted",
      count: 1,
      periodId: period.id,
      actualMinutesDelta: -15,
      allowanceMinutesDelta: -15,
    });
  });

  it("serializes competing allowance consumption", async () => {
    const period = await createPeriod();
    const performedAt = new Date(period.startsAt.getTime() + 60_000);
    const command = (reference: string) =>
      service.postUsage(support, period.id, {
        requestId: randomUUID(),
        expectedRevision: 1,
        classification: "customer_service" as const,
        performedAt: performedAt.toISOString(),
        actualMinutes: 100,
        allowanceMinutes: 100,
        workReference: reference,
        description: "Работы",
        internalNote: null,
      });
    const results = await Promise.allSettled([command("SUP-A"), command("SUP-B")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { response: { code: "SERVICE_ALLOWANCE_EXCEEDED" } },
    });
    expect(ledgerEvent.mock.calls.map((call: [ServiceLedgerEvent]) => call[0].event)).toContain(
      "allowance_blocked",
    );
  });

  it("reclassifies customer work as a defect and returns its allowance", async () => {
    const period = await createPeriod();
    const usage = await service.postUsage(support, period.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
      classification: "customer_service",
      performedAt: new Date(period.startsAt.getTime() + 60_000).toISOString(),
      actualMinutes: 10,
      allowanceMinutes: 10,
      workReference: "SUP-RECLASSIFY",
      description: "Первичная классификация",
      internalNote: null,
    });
    expect(usage.balance.remaining).toBe(170);
    const detail = await service.detail(support, period.id);
    const original = detail.entries[0];
    if (!original) throw new Error("usage fixture missing");
    const correction = await service.correctUsage(support, period.id, original.id, {
      requestId: randomUUID(),
      expectedRevision: 2,
      classification: "product_defect",
      actualMinutesDelta: 0,
      allowanceMinutesDelta: -10,
      description: "Подтверждён дефект продукта",
      internalNote: null,
    });
    expect(correction.balance).toEqual({
      included: 180,
      externallyApproved: 0,
      consumed: 0,
      remaining: 180,
    });
  });

  it("adds external capacity and prevents an unsafe withdrawal", async () => {
    const period = await createPeriod();
    const approval = await service.addApproval(support, period.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
      approvedMinutes: 60,
      externalReference: "EMAIL-1",
      externalUrl: null,
      approvedAt: new Date().toISOString(),
      reason: "Согласовано клиентом",
    });
    expect(approval.balance).toEqual({
      included: 180,
      externallyApproved: 60,
      consumed: 0,
      remaining: 240,
    });
    expect(ledgerEvent).toHaveBeenLastCalledWith({
      event: "excess_approved",
      count: 1,
      periodId: period.id,
      minuteDelta: 60,
    });
    const detail = await service.detail(support, period.id);
    const approvalId = detail.approvals[0]!.id;
    const withdrawal = await service.withdrawApproval(support, period.id, approvalId, {
      requestId: randomUUID(),
      expectedRevision: 2,
      withdrawnMinutes: 30,
      externalReference: "EMAIL-2",
      externalUrl: null,
      approvedAt: new Date().toISOString(),
      reason: "Частичный отзыв",
    });
    expect(withdrawal.balance.externallyApproved).toBe(30);
    expect(ledgerEvent).toHaveBeenLastCalledWith({
      event: "approval_withdrawn",
      count: 1,
      periodId: period.id,
      minuteDelta: -30,
    });
    await expect(
      service.withdrawApproval(support, period.id, approvalId, {
        requestId: randomUUID(),
        expectedRevision: 3,
        withdrawnMinutes: 40,
        externalReference: "EMAIL-3",
        externalUrl: null,
        approvedAt: new Date().toISOString(),
        reason: "Избыточный отзыв",
      }),
    ).rejects.toMatchObject({ response: { code: "SERVICE_WITHDRAWAL_EXCEEDS_APPROVAL" } });
  });

  it("paginates periods with stable distinct cursors and complete balances", async () => {
    await createPeriod();
    await createPeriod();
    const first = await service.list(support, { tenantId, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(support, {
      tenantId,
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(second.items[0]?.balance.included).toBe(180);
  });

  it("does not accept a correction entry from another period", async () => {
    const source = await createPeriod();
    const target = await createPeriod();
    const performedAt = new Date(source.startsAt.getTime() + 60_000).toISOString();
    await service.postUsage(support, source.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
      classification: "customer_service",
      performedAt,
      actualMinutes: 10,
      allowanceMinutes: 10,
      workReference: "SUP-X",
      description: "Работы",
      internalNote: null,
    });
    const sourceDetail = await service.detail(support, source.id);
    const sourceEntry = sourceDetail.entries[0];
    if (!sourceEntry) throw new Error("source usage fixture missing");
    await expect(
      service.correctUsage(support, target.id, sourceEntry.id, {
        requestId: randomUUID(),
        expectedRevision: 1,
        classification: "customer_service",
        actualMinutesDelta: -1,
        allowanceMinutesDelta: -1,
        description: "Чужая корректировка",
        internalNote: null,
      }),
    ).rejects.toMatchObject({ response: { code: "SERVICE_USAGE_NOT_FOUND" } });
  });
});

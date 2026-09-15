import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BillingApplicationService } from "../src/modules/billing/billing-application.service";
import { ServicePeriodObservability } from "../src/modules/service-periods/service-period-observability";
import type { PlatformPrincipal } from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { SubscriptionLifecycleService } from "../src/subscriptions/subscription-lifecycle.service";
import { createOrganization } from "./support/subscription-fixtures";

const databaseUrl = process.env.DATABASE_URL;
const serviceTerms = {
  cadence: "month" as const,
  includedMinutes: 180,
  carryover: "none" as const,
  excessPolicy: "external_approval" as const,
  scopeRu: "Консультации и настройка Маркиро",
  scopeEn: "Markiro consulting and configuration",
  operatingHoursRu: null,
  operatingHoursEn: null,
  schedulingTermsRu: null,
  schedulingTermsEn: null,
};

describe.skipIf(!databaseUrl)("paid recurring service activation", () => {
  const databaseName = `markiro_service_activation_${randomUUID().replaceAll("-", "_")}`;
  const scratch = new URL(databaseUrl ?? "postgres://invalid");
  scratch.pathname = `/${databaseName}`;
  scratch.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let application: BillingApplicationService;
  let periodCreated: ReturnType<typeof vi.spyOn>;
  let tenantId: string;
  let catalogItemId: string;
  let catalogVersionId: string;
  const actor: PlatformPrincipal = {
    userId: `service-accountant-${randomUUID()}`,
    role: "accountant",
    capabilities: ["billing.read", "billing.write"],
    twoFactorReady: true,
  };

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratch.toString());
    db = connection.db;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
    await db.insert(schema.platformUsers).values({
      id: actor.userId,
      name: "Service accountant",
      email: `${actor.userId}@example.invalid`,
      role: actor.role,
      status: "active",
    });
    tenantId = await createOrganization(db);
    catalogItemId = randomUUID();
    catalogVersionId = randomUUID();
    await db.insert(schema.catalogItems).values({
      id: catalogItemId,
      code: `monthly-support-${catalogItemId}`,
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
      serviceTerms,
      unitPrice: "30000.00",
      vatIncluded: false,
      publishedAt: new Date(),
      publishedByPlatformUserId: actor.userId,
    });
    const audit = new PlatformAuditService();
    const observability = new ServicePeriodObservability();
    periodCreated = vi.spyOn(observability, "periodCreated").mockImplementation(() => undefined);
    application = new BillingApplicationService(
      db,
      new SubscriptionLifecycleService(db, audit),
      audit,
      observability,
    );
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE "${databaseName}"`);
    await maintenance.pool.end();
  });

  async function paidInvoice() {
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
      createdByPlatformUserId: actor.userId,
      issuedByPlatformUserId: actor.userId,
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
        serviceTerms,
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
      platformUserId: actor.userId,
      idempotencyKey: `payment:${paymentId}`,
    });
    await db.insert(schema.invoicePaymentCompletions).values({
      tenantId,
      invoiceId,
      billingPaymentId: paymentId,
    });
    return { invoiceId, lineId };
  }

  it("creates one immutable period and replays its exact application result", async () => {
    const eventsBefore = periodCreated.mock.calls.length;
    const invoice = await paidInvoice();
    expect(
      await db
        .select()
        .from(schema.servicePeriods)
        .where(eq(schema.servicePeriods.invoiceLineId, invoice.lineId)),
    ).toEqual([]);

    const first = await application.apply(actor, invoice.invoiceId, {
      reason: "Apply monthly support",
      lines: [{ lineId: invoice.lineId }],
    });
    const retry = await application.apply(actor, invoice.invoiceId, {
      reason: "Retry monthly support",
      lines: [{ lineId: invoice.lineId }],
    });
    const periods = await db
      .select()
      .from(schema.servicePeriods)
      .where(eq(schema.servicePeriods.invoiceLineId, invoice.lineId));
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({
      tenantId,
      catalogItemId,
      catalogVersionId,
      includedMinutes: 180,
      revision: 1,
      allowanceSnapshot: { includedMinutes: 180, carryover: "none" },
    });
    expect(first.results[0]?.result).toEqual(retry.results[0]?.result);
    expect(periodCreated.mock.calls).toHaveLength(eventsBefore + 1);
    expect(periodCreated.mock.calls.at(-1)?.[0]).toMatchObject({
      event: "period_created",
      invoiceId: invoice.invoiceId,
      invoiceLineId: invoice.lineId,
      periodId: periods[0]?.id,
    });
  });

  it("serializes advance renewals into consecutive non-overlapping periods", async () => {
    const firstInvoice = await paidInvoice();
    const secondInvoice = await paidInvoice();
    await Promise.all([
      application.apply(actor, firstInvoice.invoiceId, {
        reason: "First renewal",
        lines: [{ lineId: firstInvoice.lineId }],
      }),
      application.apply(actor, secondInvoice.invoiceId, {
        reason: "Second renewal",
        lines: [{ lineId: secondInvoice.lineId }],
      }),
    ]);
    const periods = await db
      .select()
      .from(schema.servicePeriods)
      .where(eq(schema.servicePeriods.catalogItemId, catalogItemId))
      .orderBy(schema.servicePeriods.startsAt);
    const latest = periods.slice(-2);
    expect(latest).toHaveLength(2);
    expect(latest[0]?.endsAt).toEqual(latest[1]?.startsAt);
  });

  it("rolls back the ordered service and success event when period creation fails", async () => {
    const eventsBefore = periodCreated.mock.calls.length;
    const invoice = await paidInvoice();
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `fail_service_period_${suffix}`;
    const triggerName = `fail_service_period_${suffix}`;
    await connection.pool.query(
      `create function ${functionName}() returns trigger language plpgsql as $$ begin raise exception 'forced service period failure'; end $$`,
    );
    await connection.pool.query(
      `create trigger ${triggerName} before insert on service_periods for each row execute function ${functionName}()`,
    );
    try {
      await expect(
        application.apply(actor, invoice.invoiceId, {
          reason: "Force rollback",
          lines: [{ lineId: invoice.lineId }],
        }),
      ).rejects.toThrow();
    } finally {
      await connection.pool.query(`drop trigger ${triggerName} on service_periods`);
      await connection.pool.query(`drop function ${functionName}()`);
    }
    expect(
      await db
        .select()
        .from(schema.orderedServices)
        .where(eq(schema.orderedServices.invoiceLineId, invoice.lineId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.invoiceApplicationEvents)
        .where(eq(schema.invoiceApplicationEvents.invoiceLineId, invoice.lineId)),
    ).toEqual([]);
    expect(periodCreated.mock.calls).toHaveLength(eventsBefore);
  });
});

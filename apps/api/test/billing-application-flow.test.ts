import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, schema, type Db } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BillingPaymentsService } from "../src/modules/billing-payments/billing-payments.service";
import { BillingPaymentsController } from "../src/modules/billing-payments/billing-payments.controller";
import { BillingApplicationService } from "../src/modules/billing/billing-application.service";
import { BillingService } from "../src/modules/billing/billing.service";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { SubscriptionLifecycleService } from "../src/subscriptions/subscription-lifecycle.service";
import {
  createManagedSubscription,
  createOrganization,
  createPublishedAddon,
  createPublishedPlan,
} from "./support/subscription-fixtures";
import { createTestTenantBillingNotifications } from "./support/tenant-billing-notifications";

const ready = Boolean(process.env.DATABASE_URL);

describe("platform payment response boundary", () => {
  it("rejects a malformed successful payment list returned by the service", async () => {
    const service = {
      list: async () => ({ items: [{ id: "61111111-1111-4111-8111-111111111111" }] }),
    } as unknown as BillingPaymentsService;
    const controller = new BillingPaymentsController(service);

    await expect(controller.list()).rejects.toThrow();
  });
});

describe.skipIf(!ready)("invoice payment application flow", () => {
  const databaseName = `markiro_billing_application_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenanceConnection = createDb(maintenanceUrl);
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let application: BillingApplicationService;
  let payments: BillingPaymentsService;
  let billing: BillingService;
  const actor: PlatformPrincipal = {
    userId: `billing-accountant-${randomUUID()}`,
    role: "accountant",
    capabilities: platformCapabilitiesForRole("accountant"),
    twoFactorReady: true,
  };

  beforeAll(async () => {
    await maintenanceConnection.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString());
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
    await db.insert(schema.platformUsers).values({
      id: actor.userId,
      name: "Billing accountant",
      email: `${actor.userId}@example.invalid`,
      role: actor.role,
      status: "active",
      twoFactorEnabled: true,
    });
    const audit = new PlatformAuditService();
    const lifecycle = new SubscriptionLifecycleService(db, audit);
    application = new BillingApplicationService(db, lifecycle, audit);
    payments = new BillingPaymentsService(db, application, audit);
    billing = new BillingService(db, audit, createTestTenantBillingNotifications(db));
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    await maintenanceConnection.pool.query(`DROP DATABASE "${databaseName}"`);
    await maintenanceConnection.pool.end();
  });

  async function createInvoice(input: {
    status?: "draft" | "issued";
    applicationMode: "manual" | "automatic";
    activationPolicy: "immediate" | "after_current" | "manual";
  }) {
    const tenantId = await createOrganization(db);
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 2,
      maxStations: 2,
      maxKiosks: 1,
      maxCabinetUsers: 3,
    });
    const invoiceId = randomUUID();
    const lineId = randomUUID();
    const status = input.status ?? "issued";
    const now = new Date();
    await db.insert(schema.invoices).values({
      id: invoiceId,
      tenantId,
      number: `INV-${randomUUID()}`,
      status,
      issueDate: status === "issued" ? now : null,
      sellerSnapshot: status === "issued" ? { name: "Markiro" } : null,
      buyerSnapshot: status === "issued" ? { name: tenantId } : null,
      subtotal: "1000.00",
      vatTotal: "0.00",
      total: "1000.00",
      applicationMode: input.applicationMode,
      createdByPlatformUserId: actor.userId,
      issuedByPlatformUserId: status === "issued" ? actor.userId : null,
      issuedAt: status === "issued" ? now : null,
    });
    await db.insert(schema.invoiceLines).values({
      id: lineId,
      tenantId,
      invoiceId,
      position: 1,
      kind: "plan",
      catalogVersionId: planVersionId,
      catalogKind: "plan",
      nameRu: "Производство",
      nameEn: "Production",
      quantity: 1,
      unit: "subscription",
      catalogUnitPrice: "1000.00",
      agreedUnitPrice: "1000.00",
      vatIncluded: true,
      lineSubtotal: "1000.00",
      lineVat: "0.00",
      lineTotal: "1000.00",
      activationPolicy: input.activationPolicy,
    });
    return { tenantId, invoiceId, lineId, planVersionId };
  }

  async function waitForScratchLock(
    predicate: () => Promise<boolean>,
    description: string,
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  async function createManualServiceInvoice() {
    const tenantId = await createOrganization(db);
    const itemId = randomUUID();
    const serviceVersionId = randomUUID();
    await db.insert(schema.catalogItems).values({
      id: itemId,
      code: `rollout-service-${itemId}`,
      nameRu: "Настройка",
      nameEn: "Configuration",
      kind: "service",
    });
    await db.insert(schema.catalogItemVersions).values({
      id: serviceVersionId,
      catalogItemId: itemId,
      kind: "service",
      version: 1,
      status: "published",
      publishedAt: new Date(),
      nameRu: "Настройка",
      nameEn: "Configuration",
      unit: "service",
      billingMode: "one_time",
      unitPrice: "100.00",
      vatIncluded: true,
    });
    const invoiceId = randomUUID();
    const lineId = randomUUID();
    const issuedAt = new Date();
    await db.insert(schema.invoices).values({
      id: invoiceId,
      tenantId,
      number: `INV-${randomUUID()}`,
      status: "issued",
      issueDate: issuedAt,
      sellerSnapshot: { name: "Markiro" },
      buyerSnapshot: { name: tenantId },
      subtotal: "100.00",
      vatTotal: "0.00",
      total: "100.00",
      applicationMode: "manual",
      createdByPlatformUserId: actor.userId,
      issuedByPlatformUserId: actor.userId,
      issuedAt,
    });
    await db.insert(schema.invoiceLines).values({
      id: lineId,
      tenantId,
      invoiceId,
      position: 1,
      kind: "service",
      catalogVersionId: serviceVersionId,
      catalogKind: "service",
      nameRu: "Настройка",
      nameEn: "Configuration",
      quantity: 1,
      unit: "service",
      agreedUnitPrice: "100.00",
      vatIncluded: true,
      lineSubtotal: "100.00",
      lineVat: "0.00",
      lineTotal: "100.00",
    });
    return { tenantId, invoiceId, lineId };
  }

  it("rejects payment before an invoice is issued", async () => {
    const invoice = await createInvoice({
      status: "draft",
      applicationMode: "automatic",
      activationPolicy: "immediate",
    });

    await expect(
      payments.recordManual(actor, invoice.invoiceId, {
        amount: "1000.00",
        paidAt: new Date(),
        bankReference: "draft-payment",
        idempotencyKey: `draft-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ response: { code: "invoice_not_issued" } });
  });

  it("atomically applies an automatic invoice and replays the same payment", async () => {
    const invoice = await createInvoice({
      applicationMode: "automatic",
      activationPolicy: "immediate",
    });
    const input = {
      amount: "1000.00",
      paidAt: new Date("2026-08-21T12:00:00.000Z"),
      bankReference: `bank-${randomUUID()}`,
      idempotencyKey: `automatic-${randomUUID()}`,
    };

    const first = await payments.recordManual(actor, invoice.invoiceId, input);
    const replay = await payments.recordManual(actor, invoice.invoiceId, input);

    expect(replay.id).toBe(first.id);
    const subscriptions = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.sourceInvoiceLineId, invoice.lineId));
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      tenantId: invoice.tenantId,
      planVersionId: invoice.planVersionId,
      source: "paid_invoice_line",
      sourceInvoiceLineId: invoice.lineId,
    });
    const events = await db
      .select()
      .from(schema.invoiceApplicationEvents)
      .where(eq(schema.invoiceApplicationEvents.invoiceLineId, invoice.lineId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ attempt: 1, status: "applied", source: "payment" });
    const audits = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.tenantId, invoice.tenantId),
          eq(schema.platformAuditEvents.action, "billing.payment.recorded"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorPlatformUserId: actor.userId,
      actorRole: "accountant",
      outcome: "success",
      targetType: "billing_payment",
      targetId: first.id,
    });
    await expect(
      payments.recordManual(actor, invoice.invoiceId, {
        ...input,
        bankReference: "different-fact",
      }),
    ).rejects.toMatchObject({ response: { code: "payment_idempotency_key_reused" } });
    const duplicateApply = await application.apply(actor, invoice.invoiceId, {
      reason: "Проверка повторного применения",
      lines: [{ lineId: invoice.lineId, activationPolicy: "immediate" }],
    });
    expect(duplicateApply.results).toEqual([
      expect.objectContaining({ lineId: invoice.lineId, status: "skipped", attempt: 1 }),
    ]);
  });

  it("serializes concurrent payment replays with the same idempotency key", async () => {
    const invoice = await createInvoice({
      applicationMode: "automatic",
      activationPolicy: "immediate",
    });
    const triggerSuffix = randomUUID().replaceAll("-", "_");
    const functionName = `test_delay_payment_${triggerSuffix}`;
    const triggerName = `test_delay_payment_${triggerSuffix}`;
    await connection.pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        perform pg_sleep(0.15);
        return new;
      end
      $$
    `);
    await connection.pool.query(
      `create trigger ${triggerName} before insert on billing_payments for each row execute function ${functionName}()`,
    );
    const input = {
      amount: "1000.00",
      paidAt: new Date("2026-08-21T12:30:00.000Z"),
      bankReference: `concurrent-${randomUUID()}`,
      idempotencyKey: `concurrent-${randomUUID()}`,
    };
    try {
      const [first, replay] = await Promise.all([
        payments.recordManual(actor, invoice.invoiceId, input),
        payments.recordManual(actor, invoice.invoiceId, input),
      ]);
      expect(replay.id).toBe(first.id);
    } finally {
      await connection.pool.query(`drop trigger ${triggerName} on billing_payments`);
      await connection.pool.query(`drop function ${functionName}()`);
    }
    expect(
      await db
        .select({ id: schema.billingPayments.id })
        .from(schema.billingPayments)
        .where(eq(schema.billingPayments.invoiceId, invoice.invoiceId)),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: schema.tenantSubscriptions.id })
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.sourceInvoiceLineId, invoice.lineId)),
    ).toHaveLength(1);
  });

  it("keeps manual lines pending until the operator chooses how to apply them", async () => {
    const invoice = await createInvoice({
      applicationMode: "automatic",
      activationPolicy: "manual",
    });
    const payment = await payments.recordManual(actor, invoice.invoiceId, {
      amount: "1000.00",
      paidAt: new Date("2026-08-21T13:00:00.000Z"),
      bankReference: `bank-${randomUUID()}`,
      idempotencyKey: `manual-${randomUUID()}`,
    });

    expect(
      await db
        .select({ id: schema.tenantSubscriptions.id })
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.sourceInvoiceLineId, invoice.lineId)),
    ).toEqual([]);
    expect(
      await db
        .select({ status: schema.invoiceApplicationEvents.status })
        .from(schema.invoiceApplicationEvents)
        .where(eq(schema.invoiceApplicationEvents.invoiceLineId, invoice.lineId)),
    ).toEqual([{ status: "pending" }]);
    const pendingDetail = await billing.get(invoice.invoiceId);
    expect(pendingDetail.payments).toEqual([
      expect.objectContaining({
        id: payment.id,
        bankReference: expect.any(String),
      }),
    ]);
    expect(pendingDetail.paymentSummary).toEqual({
      confirmedAmount: "1000.00",
      remainingAmount: "0.00",
      status: "paid",
    });
    expect(pendingDetail.application).toMatchObject({
      status: "pending",
      latestByLine: [
        expect.objectContaining({
          invoiceLineId: invoice.lineId,
          attempt: 1,
          status: "pending",
          kind: "plan",
        }),
      ],
    });

    const applied = await application.apply(actor, invoice.invoiceId, {
      reason: "Подтверждено после сверки",
      lines: [{ lineId: invoice.lineId, activationPolicy: "immediate" }],
    });

    expect(applied.results).toEqual([
      expect.objectContaining({ lineId: invoice.lineId, status: "applied" }),
    ]);
    expect(
      await db
        .select({ source: schema.tenantSubscriptions.source })
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.sourceInvoiceLineId, invoice.lineId)),
    ).toEqual([{ source: "paid_invoice_line" }]);
  });

  it("keeps a non-manual line policy frozen and rejects a contradictory operator override", async () => {
    const invoice = await createInvoice({
      applicationMode: "manual",
      activationPolicy: "immediate",
    });
    await payments.recordManual(actor, invoice.invoiceId, {
      amount: "1000.00",
      paidAt: new Date(),
      bankReference: `frozen-${randomUUID()}`,
      idempotencyKey: `frozen-${randomUUID()}`,
    });

    await expect(
      application.apply(actor, invoice.invoiceId, {
        reason: "Попытка изменить зафиксированное правило",
        lines: [{ lineId: invoice.lineId, activationPolicy: "after_current" }],
      }),
    ).rejects.toMatchObject({ response: { code: "invoice_activation_policy_frozen" } });

    await expect(
      application.apply(actor, invoice.invoiceId, {
        reason: "Применение по правилу счёта",
        lines: [{ lineId: invoice.lineId }],
      }),
    ).resolves.toMatchObject({ status: "applied" });
  });

  it("serializes concurrent application attempts and audits the skipped replay", async () => {
    const invoice = await createInvoice({
      applicationMode: "manual",
      activationPolicy: "immediate",
    });
    await payments.recordManual(actor, invoice.invoiceId, {
      amount: "1000.00",
      paidAt: new Date(),
      bankReference: `application-race-${randomUUID()}`,
      idempotencyKey: `application-race-${randomUUID()}`,
    });
    const triggerSuffix = randomUUID().replaceAll("-", "_");
    const functionName = `test_delay_application_${triggerSuffix}`;
    const triggerName = `test_delay_application_${triggerSuffix}`;
    await connection.pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.status = 'applied' then perform pg_sleep(0.15); end if;
        return new;
      end
      $$
    `);
    await connection.pool.query(
      `create trigger ${triggerName} before update on invoice_application_events for each row execute function ${functionName}()`,
    );
    const input = {
      reason: "Параллельное применение",
      lines: [{ lineId: invoice.lineId }],
    };
    try {
      const results = await Promise.all([
        application.apply(actor, invoice.invoiceId, input),
        application.apply(actor, invoice.invoiceId, input),
      ]);
      expect(results.map((result) => result.results[0]?.status).sort()).toEqual([
        "applied",
        "skipped",
      ]);
    } finally {
      await connection.pool.query(`drop trigger ${triggerName} on invoice_application_events`);
      await connection.pool.query(`drop function ${functionName}()`);
    }
    expect(
      await db
        .select({ id: schema.tenantSubscriptions.id })
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.sourceInvoiceLineId, invoice.lineId)),
    ).toHaveLength(1);
    const aggregateAudits = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.targetId, invoice.invoiceId),
          eq(schema.platformAuditEvents.action, "billing.invoice.application_processed"),
        ),
      );
    expect(aggregateAudits).toHaveLength(2);
    expect(aggregateAudits.some((event) => JSON.stringify(event.after).includes("skipped"))).toBe(
      true,
    );
  });

  it("derives invoice application status from every line and prioritizes failures", async () => {
    const invoice = await createInvoice({
      applicationMode: "manual",
      activationPolicy: "manual",
    });
    const customLineId = randomUUID();
    await db.insert(schema.invoiceLines).values({
      id: customLineId,
      tenantId: invoice.tenantId,
      invoiceId: invoice.invoiceId,
      position: 2,
      kind: "custom",
      nameRu: "Ручная услуга",
      nameEn: "Manual service",
      quantity: 1,
      unit: "item",
      agreedUnitPrice: "0.00",
      vatIncluded: true,
      lineSubtotal: "0.00",
      lineVat: "0.00",
      lineTotal: "0.00",
    });
    await payments.recordManual(actor, invoice.invoiceId, {
      amount: "1000.00",
      paidAt: new Date(),
      bankReference: `global-status-${randomUUID()}`,
      idempotencyKey: `global-status-${randomUUID()}`,
    });

    const partialSelection = await application.apply(actor, invoice.invoiceId, {
      reason: "Применить только тариф",
      lines: [{ lineId: invoice.lineId, activationPolicy: "immediate" }],
    });
    expect(partialSelection.status).toBe("pending");

    await db
      .update(schema.invoiceApplicationEvents)
      .set({ status: "failed", errorCode: "manual_review_required" })
      .where(eq(schema.invoiceApplicationEvents.invoiceLineId, customLineId));
    const detail = await billing.get(invoice.invoiceId);
    expect(detail.application.status).toBe("partial_failure");
  });

  it("creates an ordered service and records an explicit custom no-entitlement result", async () => {
    const tenantId = await createOrganization(db);
    const itemId = randomUUID();
    const serviceVersionId = randomUUID();
    await db.insert(schema.catalogItems).values({
      id: itemId,
      code: `service-${itemId}`,
      nameRu: "Внедрение",
      nameEn: "Implementation",
      kind: "service",
    });
    await db.insert(schema.catalogItemVersions).values({
      id: serviceVersionId,
      catalogItemId: itemId,
      kind: "service",
      version: 1,
      status: "published",
      publishedAt: new Date(),
      nameRu: "Внедрение",
      nameEn: "Implementation",
      unit: "service",
      billingMode: "one_time",
      unitPrice: "100.00",
      vatIncluded: true,
    });
    const invoiceId = randomUUID();
    const serviceLineId = randomUUID();
    const customLineId = randomUUID();
    const issuedAt = new Date();
    await db.insert(schema.invoices).values({
      id: invoiceId,
      tenantId,
      number: `INV-${randomUUID()}`,
      status: "issued",
      issueDate: issuedAt,
      sellerSnapshot: { name: "Markiro" },
      buyerSnapshot: { name: tenantId },
      subtotal: "150.00",
      vatTotal: "0.00",
      total: "150.00",
      applicationMode: "automatic",
      createdByPlatformUserId: actor.userId,
      issuedByPlatformUserId: actor.userId,
      issuedAt,
    });
    await db.insert(schema.invoiceLines).values([
      {
        id: serviceLineId,
        tenantId,
        invoiceId,
        position: 1,
        kind: "service",
        catalogVersionId: serviceVersionId,
        catalogKind: "service",
        nameRu: "Внедрение",
        nameEn: "Implementation",
        quantity: 1,
        unit: "service",
        agreedUnitPrice: "100.00",
        vatIncluded: true,
        lineSubtotal: "100.00",
        lineVat: "0.00",
        lineTotal: "100.00",
      },
      {
        id: customLineId,
        tenantId,
        invoiceId,
        position: 2,
        kind: "custom",
        nameRu: "Особые условия",
        nameEn: "Special terms",
        quantity: 1,
        unit: "item",
        agreedUnitPrice: "50.00",
        vatIncluded: true,
        lineSubtotal: "50.00",
        lineVat: "0.00",
        lineTotal: "50.00",
      },
    ]);

    const payment = await payments.recordManual(actor, invoiceId, {
      amount: "150.00",
      paidAt: new Date(),
      bankReference: `service-${randomUUID()}`,
      idempotencyKey: `service-${randomUUID()}`,
    });

    expect(
      await db
        .select({
          invoiceId: schema.orderedServices.invoiceId,
          invoiceLineId: schema.orderedServices.invoiceLineId,
          billingPaymentId: schema.orderedServices.billingPaymentId,
          status: schema.orderedServices.status,
        })
        .from(schema.orderedServices)
        .where(eq(schema.orderedServices.invoiceLineId, serviceLineId)),
    ).toEqual([
      {
        invoiceId,
        invoiceLineId: serviceLineId,
        billingPaymentId: payment.id,
        status: "ordered",
      },
    ]);
    const [customEvent] = await db
      .select()
      .from(schema.invoiceApplicationEvents)
      .where(eq(schema.invoiceApplicationEvents.invoiceLineId, customLineId));
    expect(customEvent).toMatchObject({
      status: "applied",
      afterSnapshot: { kind: "custom", entitlementApplied: false },
    });
  });

  it("uses the true lock-waiting completing payment as manual service provenance", async () => {
    const tenantId = await createOrganization(db);
    const itemId = randomUUID();
    const serviceVersionId = randomUUID();
    await db.insert(schema.catalogItems).values({
      id: itemId,
      code: `manual-service-${itemId}`,
      nameRu: "Настройка",
      nameEn: "Configuration",
      kind: "service",
    });
    await db.insert(schema.catalogItemVersions).values({
      id: serviceVersionId,
      catalogItemId: itemId,
      kind: "service",
      version: 1,
      status: "published",
      publishedAt: new Date(),
      nameRu: "Настройка",
      nameEn: "Configuration",
      unit: "service",
      billingMode: "one_time",
      unitPrice: "150.00",
      vatIncluded: true,
    });
    const invoiceId = randomUUID();
    const serviceLineId = randomUUID();
    const issuedAt = new Date();
    await db.insert(schema.invoices).values({
      id: invoiceId,
      tenantId,
      number: `INV-${randomUUID()}`,
      status: "issued",
      issueDate: issuedAt,
      sellerSnapshot: { name: "Markiro" },
      buyerSnapshot: { name: tenantId },
      subtotal: "150.00",
      vatTotal: "0.00",
      total: "150.00",
      applicationMode: "manual",
      createdByPlatformUserId: actor.userId,
      issuedByPlatformUserId: actor.userId,
      issuedAt,
    });
    await db.insert(schema.invoiceLines).values({
      id: serviceLineId,
      tenantId,
      invoiceId,
      position: 1,
      kind: "service",
      catalogVersionId: serviceVersionId,
      catalogKind: "service",
      nameRu: "Настройка",
      nameEn: "Configuration",
      quantity: 1,
      unit: "service",
      agreedUnitPrice: "150.00",
      vatIncluded: true,
      lineSubtotal: "150.00",
      lineVat: "0.00",
      lineTotal: "150.00",
    });

    const finalKey = `manual-service-final-${randomUUID()}`;
    const finalLockName = `billing-payment:${finalKey}`;
    const triggerLockPartOne = 2_608_028;
    const triggerLockPartTwo = Math.floor(Math.random() * 1_000_000_000);
    const suffix = randomUUID().replaceAll("-", "_");
    const functionName = `test_block_partial_payment_${suffix}`;
    const triggerName = `test_block_partial_payment_${suffix}`;
    const blocker = await connection.pool.connect();
    await blocker.query("select pg_advisory_lock(hashtextextended($1, 0))", [finalLockName]);
    await blocker.query("select pg_advisory_lock($1, $2)", [
      triggerLockPartOne,
      triggerLockPartTwo,
    ]);
    await connection.pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.status = 'partially_paid' then
          perform pg_advisory_xact_lock(${triggerLockPartOne}, ${triggerLockPartTwo});
        end if;
        return new;
      end
      $$
    `);
    await connection.pool.query(
      `create trigger ${triggerName} before update on invoices for each row execute function ${functionName}()`,
    );
    let partial: Awaited<ReturnType<typeof payments.recordManual>>;
    let final: Awaited<ReturnType<typeof payments.recordManual>>;
    try {
      const finalPromise = payments.recordManual(actor, invoiceId, {
        amount: "100.00",
        paidAt: new Date("2026-08-26T12:00:00.000Z"),
        bankReference: `manual-service-final-${randomUUID()}`,
        idempotencyKey: finalKey,
      });
      await waitForScratchLock(async () => {
        const result = await connection.pool.query<{ waiting: number }>(
          "select count(*)::int as waiting from pg_locks locks join pg_stat_activity activity on activity.pid = locks.pid where activity.datname = current_database() and locks.locktype = 'advisory' and not locks.granted",
        );
        return (result.rows[0]?.waiting ?? 0) >= 1;
      }, "the older final-payment transaction advisory lock");

      const partialPromise = payments.recordManual(actor, invoiceId, {
        amount: "50.00",
        paidAt: new Date("2026-08-28T12:00:00.000Z"),
        bankReference: `manual-service-partial-${randomUUID()}`,
        idempotencyKey: `manual-service-partial-${randomUUID()}`,
      });
      await waitForScratchLock(async () => {
        const result = await connection.pool.query<{ waiting: number }>(
          "select count(*)::int as waiting from pg_locks locks join pg_stat_activity activity on activity.pid = locks.pid where activity.datname = current_database() and locks.locktype = 'advisory' and not locks.granted",
        );
        return (result.rows[0]?.waiting ?? 0) >= 2;
      }, "the partial payment while it owns the invoice row lock");

      await blocker.query("select pg_advisory_unlock(hashtextextended($1, 0))", [finalLockName]);
      await waitForScratchLock(async () => {
        const result = await connection.pool.query<{ waiting: boolean }>(
          "select exists(select 1 from pg_locks locks join pg_stat_activity activity on activity.pid = locks.pid where activity.datname = current_database() and locks.locktype = 'transactionid' and not locks.granted) as waiting",
        );
        return result.rows[0]?.waiting === true;
      }, "the older transaction waiting behind the partial invoice update");
      await blocker.query("select pg_advisory_unlock($1, $2)", [
        triggerLockPartOne,
        triggerLockPartTwo,
      ]);

      [partial, final] = await Promise.all([partialPromise, finalPromise]);
    } finally {
      await blocker.query("select pg_advisory_unlock(hashtextextended($1, 0))", [finalLockName]);
      await blocker.query("select pg_advisory_unlock($1, $2)", [
        triggerLockPartOne,
        triggerLockPartTwo,
      ]);
      blocker.release();
      await connection.pool.query(`drop trigger if exists ${triggerName} on invoices`);
      await connection.pool.query(`drop function if exists ${functionName}()`);
    }

    await application.apply(actor, invoiceId, {
      reason: "Применить оплаченную услугу",
      lines: [{ lineId: serviceLineId }],
    });

    expect(partial.invoiceStatus).toBe("partially_paid");
    expect(final.invoiceStatus).toBe("paid");
    if (!(partial.createdAt instanceof Date) || !(final.createdAt instanceof Date)) {
      throw new Error("Expected persisted payment creation timestamps");
    }
    if (!(partial.paidAt instanceof Date) || !(final.paidAt instanceof Date)) {
      throw new Error("Expected persisted payment dates");
    }
    expect(final.createdAt.getTime()).toBeLessThan(partial.createdAt.getTime());
    expect(final.paidAt.getTime()).toBeLessThan(partial.paidAt.getTime());
    expect(
      await db
        .select({
          billingPaymentId: schema.orderedServices.billingPaymentId,
          orderedAt: schema.orderedServices.orderedAt,
        })
        .from(schema.orderedServices)
        .where(eq(schema.orderedServices.invoiceLineId, serviceLineId)),
    ).toEqual([{ billingPaymentId: final.id, orderedAt: final.paidAt }]);
  });

  it("applies old-binary manual and imported payments through trigger provenance", async () => {
    const manual = await createManualServiceInvoice();
    const imported = await createManualServiceInvoice();
    const manualPaymentId = randomUUID();
    const importedPaymentId = randomUUID();
    const manualPaidAt = new Date("2026-08-24T12:00:00.000Z");
    const importedPaidAt = new Date("2026-08-23T12:00:00.000Z");
    const importId = randomUUID();
    const importRowId = randomUUID();
    await db.insert(schema.paymentImports).values({
      id: importId,
      sourceChecksum: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      parserVersion: "old-binary-rollout-test",
      status: "ready",
      createdByPlatformUserId: actor.userId,
    });
    await db.insert(schema.paymentImportRows).values({
      id: importRowId,
      importId,
      sourceRowId: "1",
      operationDate: importedPaidAt,
      amount: "100.00",
      currency: "RUB",
      bankReference: `old-import-${importRowId}`,
    });

    const oldManualTransaction = await connection.pool.connect();
    try {
      await oldManualTransaction.query("BEGIN");
      await oldManualTransaction.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
        manual.invoiceId,
      ]);
      await oldManualTransaction.query(
        `INSERT INTO billing_payments
           (id, tenant_id, invoice_id, source, paid_at, amount, bank_reference,
            platform_user_id, idempotency_key)
         VALUES ($1, $2, $3, 'manual', $4, 100, $5, $6, $7)`,
        [
          manualPaymentId,
          manual.tenantId,
          manual.invoiceId,
          manualPaidAt,
          `old-manual-${manualPaymentId}`,
          actor.userId,
          `old-manual-${manualPaymentId}`,
        ],
      );
      await oldManualTransaction.query(
        "UPDATE invoices SET status = 'paid', paid_at = $2 WHERE id = $1",
        [manual.invoiceId, manualPaidAt],
      );
      await oldManualTransaction.query("COMMIT");
    } catch (error) {
      await oldManualTransaction.query("ROLLBACK");
      throw error;
    } finally {
      oldManualTransaction.release();
    }

    const oldImportTransaction = await connection.pool.connect();
    try {
      await oldImportTransaction.query("BEGIN");
      await oldImportTransaction.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
        imported.invoiceId,
      ]);
      await oldImportTransaction.query(
        `INSERT INTO billing_payments
           (id, tenant_id, invoice_id, source, paid_at, amount, bank_reference, import_row_id,
            platform_user_id, idempotency_key)
         VALUES ($1, $2, $3, 'bank_import', $4, 100, $5, $6, $7, $8)`,
        [
          importedPaymentId,
          imported.tenantId,
          imported.invoiceId,
          importedPaidAt,
          `old-import-${importRowId}`,
          importRowId,
          actor.userId,
          `bank-import:${importRowId}`,
        ],
      );
      await oldImportTransaction.query(
        "UPDATE invoices SET status = 'paid', paid_at = $2 WHERE id = $1",
        [imported.invoiceId, importedPaidAt],
      );
      await oldImportTransaction.query("COMMIT");
    } catch (error) {
      await oldImportTransaction.query("ROLLBACK");
      throw error;
    } finally {
      oldImportTransaction.release();
    }

    await application.apply(actor, manual.invoiceId, {
      reason: "Apply old manual rollout payment",
      lines: [{ lineId: manual.lineId }],
    });
    await application.apply(actor, imported.invoiceId, {
      reason: "Apply old imported rollout payment",
      lines: [{ lineId: imported.lineId }],
    });

    expect(
      await db
        .select({
          invoiceId: schema.orderedServices.invoiceId,
          billingPaymentId: schema.orderedServices.billingPaymentId,
          orderedAt: schema.orderedServices.orderedAt,
        })
        .from(schema.orderedServices)
        .where(inArray(schema.orderedServices.invoiceId, [manual.invoiceId, imported.invoiceId]))
        .orderBy(schema.orderedServices.invoiceId),
    ).toEqual(
      [
        { invoiceId: manual.invoiceId, billingPaymentId: manualPaymentId, orderedAt: manualPaidAt },
        {
          invoiceId: imported.invoiceId,
          billingPaymentId: importedPaymentId,
          orderedAt: importedPaidAt,
        },
      ].sort((left, right) => left.invoiceId.localeCompare(right.invoiceId)),
    );
  });

  it("does not let cancellation overwrite a payment holding the invoice lock", async () => {
    const invoice = await createInvoice({
      applicationMode: "manual",
      activationPolicy: "manual",
    });
    const lockPartOne = 2_608_027;
    const lockPartTwo = Math.floor(Math.random() * 1_000_000_000);
    const suffix = randomUUID().replaceAll("-", "_");
    const functionName = `test_block_payment_invoice_${suffix}`;
    const triggerName = `test_block_payment_invoice_${suffix}`;
    const blocker = await connection.pool.connect();
    await blocker.query("select pg_advisory_lock($1, $2)", [lockPartOne, lockPartTwo]);
    await connection.pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.status in ('partially_paid', 'paid') then
          perform pg_advisory_xact_lock(${lockPartOne}, ${lockPartTwo});
        end if;
        return new;
      end
      $$
    `);
    await connection.pool.query(
      `create trigger ${triggerName} before update on invoices for each row execute function ${functionName}()`,
    );
    try {
      const paymentPromise = payments.recordManual(actor, invoice.invoiceId, {
        amount: "1000.00",
        paidAt: new Date("2026-08-27T14:00:00.000Z"),
        bankReference: `cancel-race-${randomUUID()}`,
        idempotencyKey: `cancel-race-${randomUUID()}`,
      });
      await waitForScratchLock(async () => {
        const result = await connection.pool.query<{ waiting: boolean }>(
          "select exists(select 1 from pg_locks where locktype = 'advisory' and classid = $1 and objid = $2 and not granted) as waiting",
          [lockPartOne, lockPartTwo],
        );
        return result.rows[0]?.waiting === true;
      }, "the payment trigger advisory lock");

      const cancelPromise = billing.cancel(actor, invoice.invoiceId);
      await waitForScratchLock(async () => {
        const result = await connection.pool.query<{ waiting: boolean }>(
          "select exists(select 1 from pg_locks locks join pg_stat_activity activity on activity.pid = locks.pid where activity.datname = current_database() and locks.locktype = 'transactionid' and not locks.granted) as waiting",
        );
        return result.rows[0]?.waiting === true;
      }, "the cancellation invoice-row lock");
      await blocker.query("select pg_advisory_unlock($1, $2)", [lockPartOne, lockPartTwo]);

      const [paymentResult, cancelResult] = await Promise.allSettled([
        paymentPromise,
        cancelPromise,
      ]);
      expect(paymentResult.status).toBe("fulfilled");
      expect(cancelResult).toMatchObject({
        status: "rejected",
        reason: { response: { code: "invoice_paid" } },
      });
      expect(
        await db
          .select({ status: schema.invoices.status })
          .from(schema.invoices)
          .where(eq(schema.invoices.id, invoice.invoiceId)),
      ).toEqual([{ status: "paid" }]);
    } finally {
      await blocker.query("select pg_advisory_unlock($1, $2)", [lockPartOne, lockPartTwo]);
      blocker.release();
      await connection.pool.query(`drop trigger if exists ${triggerName} on invoices`);
      await connection.pool.query(`drop function if exists ${functionName}()`);
    }
  });

  it("retries a failed line with a monotonic attempt and keeps the first failure", async () => {
    const invoice = await createInvoice({
      applicationMode: "manual",
      activationPolicy: "manual",
    });
    await payments.recordManual(actor, invoice.invoiceId, {
      amount: "1000.00",
      paidAt: new Date(),
      bankReference: `retry-${randomUUID()}`,
      idempotencyKey: `retry-${randomUUID()}`,
    });

    const failed = await application.apply(actor, invoice.invoiceId, {
      reason: "Сначала после текущей",
      lines: [{ lineId: invoice.lineId, activationPolicy: "after_current" }],
    });
    expect(failed).toMatchObject({
      status: "partial_failure",
      results: [{ lineId: invoice.lineId, attempt: 1, status: "failed" }],
    });
    const retried = await application.apply(actor, invoice.invoiceId, {
      reason: "Исправлено на немедленную активацию",
      lines: [{ lineId: invoice.lineId, activationPolicy: "immediate" }],
    });
    expect(retried).toMatchObject({
      status: "applied",
      results: [{ lineId: invoice.lineId, attempt: 2, status: "applied" }],
    });
    expect(
      await db
        .select({
          attempt: schema.invoiceApplicationEvents.attempt,
          status: schema.invoiceApplicationEvents.status,
        })
        .from(schema.invoiceApplicationEvents)
        .where(eq(schema.invoiceApplicationEvents.invoiceLineId, invoice.lineId))
        .orderBy(schema.invoiceApplicationEvents.attempt),
    ).toEqual([
      { attempt: 1, status: "failed" },
      { attempt: 2, status: "applied" },
    ]);
  });

  it("attributes add-on retirement caused by a paid invoice to the billing flow", async () => {
    const current = await createManagedSubscription(db, {
      status: "active",
      endsAt: new Date(Date.now() + 86_400_000),
    });
    const addonVersionId = await createPublishedAddon(db, [
      { entitlementKey: "stations", increment: 1 },
    ]);
    const addonId = randomUUID();
    await db.insert(schema.subscriptionAddons).values({
      id: addonId,
      tenantId: current.tenantId,
      subscriptionId: current.subscriptionId,
      addonVersionId,
      quantity: 1,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000),
      status: "active",
      source: "manual",
      createdByPlatformUserId: actor.userId,
    });
    const replacementPlanId = await createPublishedPlan(db, {
      maxLines: 4,
      maxStations: 4,
      maxKiosks: 2,
      maxCabinetUsers: 5,
    });
    const invoiceId = randomUUID();
    const lineId = randomUUID();
    const issuedAt = new Date();
    await db.insert(schema.invoices).values({
      id: invoiceId,
      tenantId: current.tenantId,
      number: `INV-${randomUUID()}`,
      status: "issued",
      issueDate: issuedAt,
      sellerSnapshot: { name: "Markiro" },
      buyerSnapshot: { name: current.tenantId },
      subtotal: "1000.00",
      vatTotal: "0.00",
      total: "1000.00",
      applicationMode: "automatic",
      createdByPlatformUserId: actor.userId,
      issuedByPlatformUserId: actor.userId,
      issuedAt,
    });
    await db.insert(schema.invoiceLines).values({
      id: lineId,
      tenantId: current.tenantId,
      invoiceId,
      position: 1,
      kind: "plan",
      catalogVersionId: replacementPlanId,
      catalogKind: "plan",
      nameRu: "Новый тариф",
      nameEn: "Replacement plan",
      quantity: 1,
      unit: "month",
      agreedUnitPrice: "1000.00",
      vatIncluded: true,
      lineSubtotal: "1000.00",
      lineVat: "0.00",
      lineTotal: "1000.00",
      activationPolicy: "immediate",
    });

    await payments.recordManual(actor, invoiceId, {
      amount: "1000.00",
      paidAt: new Date(),
      bankReference: `retire-addon-${randomUUID()}`,
      idempotencyKey: `retire-addon-${randomUUID()}`,
    });

    const [retirementEvent] = await db
      .select()
      .from(schema.subscriptionEvents)
      .where(
        and(
          eq(schema.subscriptionEvents.subscriptionId, current.subscriptionId),
          eq(schema.subscriptionEvents.eventKind, "addon.revoked"),
        ),
      );
    expect(retirementEvent).toMatchObject({ source: "paid_invoice_line" });
    const [retirementAudit] = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.targetId, addonId),
          eq(schema.platformAuditEvents.action, "billing.invoice.addon_revoked"),
        ),
      );
    expect(retirementAudit).toMatchObject({
      tenantId: current.tenantId,
      outcome: "success",
      targetType: "subscription_addon",
    });
  });

  it("binds an after-current add-on to the successor plan created by the same invoice", async () => {
    const current = await createManagedSubscription(db, {
      status: "active",
      endsAt: new Date(Date.now() + 86_400_000),
    });
    const successorPlanId = await createPublishedPlan(db, {
      maxLines: 4,
      maxStations: 4,
      maxKiosks: 2,
      maxCabinetUsers: 5,
    });
    const addonVersionId = await createPublishedAddon(db, [
      { entitlementKey: "stations", increment: 1 },
    ]);
    const invoiceId = randomUUID();
    const planLineId = randomUUID();
    const addonLineId = randomUUID();
    const issuedAt = new Date();
    await db.insert(schema.invoices).values({
      id: invoiceId,
      tenantId: current.tenantId,
      number: `INV-${randomUUID()}`,
      status: "issued",
      issueDate: issuedAt,
      sellerSnapshot: { name: "Markiro" },
      buyerSnapshot: { name: current.tenantId },
      subtotal: "1100.00",
      vatTotal: "0.00",
      total: "1100.00",
      applicationMode: "automatic",
      createdByPlatformUserId: actor.userId,
      issuedByPlatformUserId: actor.userId,
      issuedAt,
    });
    await db.insert(schema.invoiceLines).values([
      {
        id: planLineId,
        tenantId: current.tenantId,
        invoiceId,
        position: 1,
        kind: "plan",
        catalogVersionId: successorPlanId,
        catalogKind: "plan",
        nameRu: "Следующий тариф",
        nameEn: "Successor plan",
        quantity: 1,
        unit: "month",
        agreedUnitPrice: "1000.00",
        vatIncluded: true,
        lineSubtotal: "1000.00",
        lineVat: "0.00",
        lineTotal: "1000.00",
        activationPolicy: "after_current",
      },
      {
        id: addonLineId,
        tenantId: current.tenantId,
        invoiceId,
        position: 2,
        kind: "addon",
        catalogVersionId: addonVersionId,
        catalogKind: "addon",
        nameRu: "Дополнительная станция",
        nameEn: "Extra station",
        quantity: 1,
        unit: "station",
        agreedUnitPrice: "100.00",
        vatIncluded: true,
        lineSubtotal: "100.00",
        lineVat: "0.00",
        lineTotal: "100.00",
        activationPolicy: "after_current",
      },
    ]);

    await payments.recordManual(actor, invoiceId, {
      amount: "1100.00",
      paidAt: new Date(),
      bankReference: `successor-${randomUUID()}`,
      idempotencyKey: `successor-${randomUUID()}`,
    });

    const [successor] = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.sourceInvoiceLineId, planLineId));
    const [addon] = await db
      .select()
      .from(schema.subscriptionAddons)
      .where(eq(schema.subscriptionAddons.sourceInvoiceLineId, addonLineId));
    expect(successor).toMatchObject({ status: "scheduled", source: "paid_invoice_line" });
    expect(addon).toMatchObject({
      subscriptionId: successor?.id,
      status: "scheduled",
      source: "paid_invoice_line",
    });
  });
});

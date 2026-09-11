import { validateCommercialIssuance } from "../src/modules/billing/commercial-line-terms";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import type { RequestWithPlatformPrincipal } from "../src/platform-auth/platform-auth.guard";
import { BillingProfilesService } from "../src/modules/billing-profiles/billing-profiles.service";
import { BillingProfilesController } from "../src/modules/billing-profiles/billing-profiles.controller";
import { BillingService } from "../src/modules/billing/billing.service";
import { toInvoicePrintModel } from "../src/modules/billing/print-document-model";
import { BillingApplicationService } from "../src/modules/billing/billing-application.service";
import { BillingPaymentsService } from "../src/modules/billing-payments/billing-payments.service";
import { TenantBillingReadService } from "../src/modules/tenant-billing/tenant-billing-read.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { OfferWorkspaceService } from "../src/modules/platform-offers/offer-workspace.service";
import { OfferPreviewService } from "../src/modules/platform-offers/offer-preview.service";
import { PlatformOffersController } from "../src/modules/platform-offers/platform-offers.controller";
import { OfferDocumentsService } from "../src/modules/platform-offers/offer-documents.service";
import type { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { PlatformOffersService } from "../src/modules/platform-offers/platform-offers.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { SubscriptionLifecycleService } from "../src/subscriptions/subscription-lifecycle.service";
import {
  createOrganization,
  createPublishedPlan,
  createPublishedAddon,
  createManagedSubscription,
} from "./support/subscription-fixtures";
import { createTestTenantBillingNotifications } from "./support/tenant-billing-notifications";

const terms = {
  version: 1,
  subject: "software_license",
  documentNameRu: "Право использования Маркиро на год",
  documentNameEn: "Markiro annual license",
  sellerPolicyRevision: 1,
  billingPeriod: "year",
  billingTimezone: "Europe/Moscow",
  activationRule: "on_application",
} as const;
describe.skipIf(!process.env.DATABASE_URL)("frozen paid commercial periods", () => {
  const name = `commercial_period_${randomUUID().replaceAll("-", "_")}`;
  const maintenance = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let application: BillingApplicationService;
  let payments: BillingPaymentsService;
  let offers: PlatformOffersService;
  let billing: BillingService;
  const actor: PlatformPrincipal = {
    userId: randomUUID(),
    role: "accountant",
    capabilities: platformCapabilitiesForRole("accountant"),
    twoFactorReady: true,
  };
  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    connection = createDb(url.toString());
    db = connection.db;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
    await db.insert(schema.platformUsers).values({
      id: actor.userId,
      name: "Commercial accountant",
      email: `${actor.userId}@example.invalid`,
      role: actor.role,
      status: "active",
      twoFactorEnabled: true,
    });
    const audit = new PlatformAuditService();
    application = new BillingApplicationService(
      db,
      new SubscriptionLifecycleService(db, audit),
      audit,
    );
    payments = new BillingPaymentsService(db, application, audit);
    offers = new PlatformOffersService(db, audit, createTestTenantBillingNotifications(db));
    billing = new BillingService(db, audit, createTestTenantBillingNotifications(db));
    await db.insert(schema.operatorBillingProfiles).values({
      revision: 1,
      kind: "self_employed",
      fullName: "Seller",
      displayName: "Seller",
      inn: "123456789012",
      addressRaw: "Moscow",
      legalAddressRaw: "Moscow",
      taxPolicy: { kind: "without_vat", regime: "npd" },
      isConfirmed: true,
      confirmedByPlatformUserId: actor.userId,
      confirmedAt: new Date(),
      createdByPlatformUserId: actor.userId,
    });
    await db.insert(schema.operatorBankAccounts).values({
      label: "Default",
      settlementAccount: "40702810900000000001",
      bic: "044525225",
      bankName: "Test bank",
      correspondentAccount: "30101810400000000225",
      isDefault: true,
      createdByPlatformUserId: actor.userId,
    });
  }, 120_000);
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE "${name}"`);
    await maintenance.pool.end();
  });
  function clock(at = "2026-09-10T09:00:00.000Z") {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at));
  }
  async function plan() {
    return createPublishedPlan(db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 0,
      maxCabinetUsers: 1,
    });
  }
  async function invoice(
    input: {
      tenantId?: string;
      kind?: "plan" | "addon";
      catalogVersionId?: string;
      quantity?: number;
      period?: "month" | "year";
      legacy?: boolean;
      rules?: readonly ("on_application" | "after_current")[];
      applicationMode?: "manual" | "automatic";
      activationPolicy?: "immediate" | "after_current";
    } = {},
  ) {
    const tenantId = input.tenantId ?? (await createOrganization(db));
    const catalogVersionId = input.catalogVersionId ?? (await plan());
    const id = randomUUID(),
      lineId = randomUUID();
    const rules = input.rules;
    const amount = rules ? `${69000 * rules.length}.00` : "69000.00";
    await db.insert(schema.invoices).values({
      id,
      tenantId,
      number: `INV-${id}`,
      status: "issued",
      issueDate: new Date(),
      issuedAt: new Date(),
      issuedByPlatformUserId: actor.userId,
      createdByPlatformUserId: actor.userId,
      sellerSnapshot: { exact: "seller" },
      buyerSnapshot: { exact: "buyer" },
      subtotal: amount,
      vatTotal: "0.00",
      total: amount,
      applicationMode: input.applicationMode ?? "manual",
    });
    const activationPolicy = input.activationPolicy ?? "immediate";
    await db.insert(schema.invoiceLines).values({
      id: lineId,
      tenantId,
      invoiceId: id,
      kind: input.kind ?? "plan",
      catalogKind: input.kind ?? "plan",
      catalogVersionId,
      position: 1,
      nameRu: "Historical exact line",
      nameEn: "Exact line",
      quantity: input.quantity ?? 1,
      unit: "year",
      agreedUnitPrice: "69000.00",
      vatIncluded: false,
      lineSubtotal: amount,
      lineVat: "0.00",
      lineTotal: "69000.00",
      activationPolicy,
      commercialTerms: input.legacy
        ? null
        : {
            ...terms,
            billingPeriod: input.period ?? "year",
            activationRule:
              activationPolicy === "after_current" ? "after_current" : "on_application",
          },
    });
    const lineIds = [lineId];
    if (rules) {
      await db
        .update(schema.invoiceLines)
        .set({
          commercialTerms: { ...terms, activationRule: rules[0] },
          activationPolicy: rules[0] === "after_current" ? "after_current" : "immediate",
        })
        .where(eq(schema.invoiceLines.id, lineId));
      const [first] = await db
        .select()
        .from(schema.invoiceLines)
        .where(eq(schema.invoiceLines.id, lineId));
      if (!first) throw new Error("fixture line missing");
      for (const [index, rule] of rules.slice(1).entries()) {
        const id = randomUUID();
        lineIds.push(id);
        await db.insert(schema.invoiceLines).values({
          ...first,
          id,
          position: index + 2,
          activationPolicy: rule === "after_current" ? "after_current" : "immediate",
          commercialTerms: { ...terms, activationRule: rule },
        });
      }
    }
    await payments.recordManual(actor, id, {
      amount,
      paidAt: new Date("2026-08-01T09:00:00Z"),
      bankReference: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    return { id, lineId, lineIds, tenantId, catalogVersionId };
  }
  async function apply(input: { id: string; lineId: string }) {
    return application.apply(actor, input.id, {
      lines: [{ lineId: input.lineId }],
      reason: "Confirmed payment application",
    });
  }
  it.each([
    { quantity: 2, price: "999999999999.99", rate: null, count: 1 },
    { quantity: 1, price: "999999999999.99", rate: 2000, count: 1 },
    { quantity: 1, price: "500000000000.00", rate: null, count: 2 },
  ])(
    "rejects calculated money overflow before persistence in invoices and offers: %j",
    async ({ quantity, price, rate, count }) => {
      const tenantId = await createOrganization(db);
      await db.insert(schema.tenantBillingProfiles).values({
        tenantId,
        revision: 1,
        kind: "legal_entity",
        fullName: "Buyer",
        displayName: "Buyer",
        inn: "7710140679",
        addressRaw: "Moscow",
        legalAddressRaw: "Moscow",
        isConfirmed: true,
        confirmedByPlatformUserId: actor.userId,
        confirmedAt: new Date(),
        createdByPlatformUserId: actor.userId,
      });
      const lines = Array.from({ length: count }, () => ({
        nameRu: "Услуга",
        nameEn: "Service",
        unit: "item",
        quantity,
        agreedUnitPrice: price,
        vatRateBps: rate,
        vatIncluded: false,
      }));
      const error = { status: 400, response: { code: "commercial_amount_out_of_range" } };
      await expect(
        billing.create(actor, {
          tenantId,
          applicationMode: "manual",
          lines: lines.map((line) => ({ ...line, kind: "custom" as const })),
        }),
      ).rejects.toMatchObject(error);
      await expect(
        offers.create(actor, {
          tenantId,
          lines: lines.map((line) => ({ ...line, kind: "service" as const })),
        }),
      ).rejects.toMatchObject(error);
      expect(
        await db.select().from(schema.invoices).where(eq(schema.invoices.tenantId, tenantId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(schema.invoiceLines)
          .where(eq(schema.invoiceLines.tenantId, tenantId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(schema.commercialOffers)
          .where(eq(schema.commercialOffers.tenantId, tenantId)),
      ).toEqual([]);
    },
  );

  it("applies one annual invoice once at application time and preserves frozen invoice bytes", async () => {
    clock();
    const sold = await invoice();
    const before = await db
      .select()
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, sold.id));
    const [first, retry] = await Promise.all([apply(sold), apply(sold)]);
    expect(first.status).toBe("applied");
    expect(retry.status).toBe("applied");
    const rows = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, sold.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endsAt?.toISOString()).toBe("2027-09-10T09:00:00.000Z");
    expect(rows[0]?.commercialPeriod).toMatchObject({
      billingPeriod: "year",
      cycle: 0,
      anchorAt: "2026-09-10T09:00:00.000Z",
    });
    expect(retry.results[0]?.result).toMatchObject({ id: rows[0]?.id });
    expect(
      await db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, sold.id)),
    ).toEqual(before);
    expect(before[0]).toMatchObject({ quantity: 1, agreedUnitPrice: "69000.00" });
  });
  async function acceptedOffer(
    existingTenantId?: string,
    frozenTotal = "69000.00",
    rules?: readonly ("on_application" | "after_current")[],
  ) {
    const tenantId = existingTenantId ?? (await createOrganization(db)),
      catalogVersionId = await plan(),
      id = randomUUID(),
      lineId = randomUUID();
    await db.insert(schema.commercialOffers).values({
      id,
      tenantId,
      revision: 1,
      status: "draft",
      number: `KP-${id}`,
      total: frozenTotal,
      publishedAt: new Date(),
      publishedByPlatformUserId: actor.userId,
      createdByPlatformUserId: actor.userId,
    });
    await db.insert(schema.commercialOfferLines).values({
      id: lineId,
      tenantId,
      offerId: id,
      position: 1,
      kind: "plan",
      catalogVersionId,
      nameRu: "Annual",
      nameEn: "Annual",
      quantity: 1,
      unit: "year",
      agreedUnitPrice: "69000.00",
      vatIncluded: false,
      activationPolicy: "immediately",
      lineTotal: "69000.00",
      commercialTerms: terms,
    });
    const lineIds = [lineId];
    if (rules) {
      await db
        .update(schema.commercialOfferLines)
        .set({
          commercialTerms: { ...terms, activationRule: rules[0] },
          activationPolicy: rules[0] === "after_current" ? "after_current" : "immediately",
        })
        .where(eq(schema.commercialOfferLines.id, lineId));
      const [first] = await db
        .select()
        .from(schema.commercialOfferLines)
        .where(eq(schema.commercialOfferLines.id, lineId));
      if (!first) throw new Error("fixture line missing");
      for (const [index, rule] of rules.slice(1).entries()) {
        const id = randomUUID();
        lineIds.push(id);
        await db.insert(schema.commercialOfferLines).values({
          ...first,
          id,
          position: index + 2,
          activationPolicy: rule === "after_current" ? "after_current" : "immediately",
          commercialTerms: { ...terms, activationRule: rule },
        });
      }
    }
    await db
      .update(schema.commercialOffers)
      .set({ status: "published" })
      .where(eq(schema.commercialOffers.id, id));
    const userId = randomUUID();
    await db.insert(schema.user).values({
      id: userId,
      name: "Buyer",
      email: `${userId}@example.invalid`,
      emailVerified: true,
    });
    await db.insert(schema.commercialOfferDecisions).values({
      tenantId,
      offerId: id,
      decision: "accepted",
      actorUserId: userId,
      idempotencyKey: randomUUID(),
    });
    return { tenantId, catalogVersionId, id, lineId, lineIds };
  }
  it.each([
    ["on_application", "on_application", false],
    ["after_current", "on_application", false],
    ["after_current", "after_current", false],
    ["on_application", "after_current", true],
  ] as const)("checks frozen aggregate at issuance: %s then %s", async (first, second, valid) => {
    const lines = [first, second].map((activationRule) => ({
      kind: "plan",
      quantity: 1,
      commercialTerms: { ...terms, activationRule },
      vatRate: null,
      vatIncluded: false,
    }));
    const validation = db.transaction((tx) => validateCommercialIssuance(tx, lines));
    if (valid) await expect(validation).resolves.toBeUndefined();
    else
      await expect(validation).rejects.toMatchObject({
        response: { code: "commercial_plan_sequence_review_required" },
      });
  });

  it.each([
    ["on_application", "on_application", false],
    ["after_current", "on_application", false],
    ["after_current", "after_current", false],
    ["on_application", "after_current", true],
  ] as const)(
    "protects complete invoice and offer sale %s then %s",
    async (first, second, valid) => {
      clock();
      for (const path of ["invoice", "offer"] as const) {
        const tenantId = await createOrganization(db);
        const existing = await createManagedSubscription(db, {
          tenantId,
          planVersionId: await plan(),
          status: "active",
          startsAt: new Date("2026-08-10T09:00:00Z"),
          endsAt: new Date("2026-10-10T09:00:00Z"),
        });
        const before = await db
          .select()
          .from(schema.tenantSubscriptions)
          .where(eq(schema.tenantSubscriptions.tenantId, tenantId));
        const sold =
          path === "invoice"
            ? await invoice({ tenantId, rules: [first, second], applicationMode: "automatic" })
            : await acceptedOffer(tenantId, "138000.00", [first, second]);
        if (path === "offer") {
          const paid = offers.pay(actor, sold.id, randomUUID(), {
            amount: "138000.00",
            currency: "RUB",
            bankReference: randomUUID(),
          });
          if (valid) await paid;
          else
            await expect(paid).rejects.toMatchObject({
              response: { code: "commercial_plan_sequence_review_required" },
            });
        }
        const rows = await db
          .select()
          .from(schema.tenantSubscriptions)
          .where(eq(schema.tenantSubscriptions.tenantId, tenantId));
        if (valid) {
          expect(rows.find((row) => row.id === existing.subscriptionId)?.status).toBe("superseded");
          const active = rows.find((row) => row.status === "active"),
            scheduled = rows.find((row) => row.status === "scheduled");
          expect(active?.startsAt?.toISOString()).toBe("2026-09-10T09:00:00.000Z");
          expect(active?.endsAt?.toISOString()).toBe("2027-09-10T09:00:00.000Z");
          expect(scheduled?.startsAt).toEqual(active?.endsAt);
          expect(scheduled?.endsAt?.toISOString()).toBe("2028-09-10T09:00:00.000Z");
          expect(scheduled?.commercialPeriod).toMatchObject({
            cycle: 1,
            anchorAt: "2026-09-10T09:00:00.000Z",
          });
          const audit = await db
            .select()
            .from(schema.platformAuditEvents)
            .where(eq(schema.platformAuditEvents.tenantId, tenantId));
          for (const row of [active, scheduled]) {
            expect(audit).toContainEqual(
              expect.objectContaining({
                actorPlatformUserId: actor.userId,
                actorRole: actor.role,
                tenantId,
                targetId: row?.id,
                targetType: "tenant_subscription",
                outcome: "success",
                action: `billing.${path}.${row === active ? "plan_applied" : "plan_scheduled"}`,
              }),
            );
          }
        } else expect(rows).toEqual(before);
        if (path === "invoice") {
          const paid = await db
            .select()
            .from(schema.billingPayments)
            .where(eq(schema.billingPayments.invoiceId, sold.id));
          expect(paid).toHaveLength(1);
          expect(paid[0]?.amount).toBe("138000.00");
          const events = await db
            .select()
            .from(schema.invoiceApplicationEvents)
            .where(eq(schema.invoiceApplicationEvents.invoiceId, sold.id));
          expect(events).toHaveLength(2);
          expect(events.map((event) => event.status)).toEqual([
            valid ? "applied" : "failed",
            valid ? "applied" : "failed",
          ]);
          if (!valid) {
            expect(
              events.every(
                (event) => event.errorCode === "commercial_plan_sequence_review_required",
              ),
            ).toBe(true);
            const audits = await db
              .select()
              .from(schema.platformAuditEvents)
              .where(
                and(
                  eq(schema.platformAuditEvents.tenantId, tenantId),
                  eq(schema.platformAuditEvents.action, "billing.invoice.line_applied"),
                ),
              );
            expect(audits).toHaveLength(2);
            for (const lineId of sold.lineIds)
              expect(audits).toContainEqual(
                expect.objectContaining({
                  actorPlatformUserId: actor.userId,
                  actorRole: actor.role,
                  tenantId,
                  action: "billing.invoice.line_applied",
                  targetType: "invoice_line",
                  targetId: lineId,
                  outcome: "failed",
                  after: {
                    applicationStatus: "failed",
                    kind: "plan",
                    errorCode: "commercial_plan_sequence_review_required",
                  },
                }),
              );
            const detail = await billing.get(sold.id);
            expect(detail.sellerSnapshot).toEqual({ exact: "seller" });
            expect(detail.buyerSnapshot).toEqual({ exact: "buyer" });
            expect(detail.total).toBe("138000.00");
            const frozenLines = await db
              .select()
              .from(schema.invoiceLines)
              .where(
                and(
                  eq(schema.invoiceLines.tenantId, tenantId),
                  eq(schema.invoiceLines.invoiceId, sold.id),
                ),
              )
              .orderBy(schema.invoiceLines.position);
            expect(frozenLines.map((line) => line.commercialTerms)).toEqual(
              [first, second].map((activationRule) => ({ ...terms, activationRule })),
            );
          }
          const retry = await application.apply(actor, sold.id, {
            lines: sold.lineIds.map((lineId) => ({ lineId })),
            reason: "Review retry",
          });
          expect(retry.results.map((row) => row.status)).toEqual([
            valid ? "skipped" : "failed",
            valid ? "skipped" : "failed",
          ]);
        } else {
          const fulfilled = await db
            .select()
            .from(schema.offerLineFulfilments)
            .where(eq(schema.offerLineFulfilments.tenantId, tenantId));
          expect(fulfilled).toHaveLength(valid ? 2 : 0);
          if (valid)
            expect(new Set(fulfilled.map((row) => row.offerLineId))).toEqual(new Set(sold.lineIds));
        }
      }
    },
  );
  it("requires first purchased plan before selected renewal and preserves retry order", async () => {
    clock();
    const sold = await invoice({ rules: ["on_application", "after_current"] });
    await createManagedSubscription(db, {
      tenantId: sold.tenantId,
      planVersionId: await plan(),
      status: "active",
      startsAt: new Date("2026-08-10T09:00:00Z"),
      endsAt: new Date("2026-10-10T09:00:00Z"),
    });
    const secondId = sold.lineIds[1];
    if (!secondId) throw new Error("missing second line");
    const second = await apply({ id: sold.id, lineId: secondId });
    expect(second.results[0]).toMatchObject({
      status: "failed",
      errorCode: "commercial_plan_sequence_review_required",
    });
    expect((await apply(sold)).results[0]?.status).toBe("applied");
    expect((await apply({ id: sold.id, lineId: secondId })).results[0]?.status).toBe("applied");
    const rows = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, sold.tenantId));
    expect(rows.find((row) => row.status === "scheduled")?.startsAt).toEqual(
      rows.find((row) => row.status === "active")?.endsAt,
    );
  });

  it("protects a previously purchased renewal under the timeline lock instead of cancelling it", async () => {
    clock();
    const sold = await invoice({ rules: ["on_application", "after_current"] });
    const secondId = sold.lineIds[1];
    if (!secondId) throw new Error("missing second line");
    const base = await createManagedSubscription(db, {
      tenantId: sold.tenantId,
      planVersionId: sold.catalogVersionId,
      status: "active",
      startsAt: new Date("2026-08-10T09:00:00Z"),
      endsAt: new Date("2026-10-10T09:00:00Z"),
    });
    let release = () => {},
      entered = () => {};
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const renewalId = randomUUID();
    const held = db.transaction(async (tx) => {
      await new SubscriptionLifecycleService(db).lockTenantTimeline(tx, sold.tenantId);
      await tx.execute(
        sql`select id from tenant_subscriptions where id = ${base.subscriptionId} for update`,
      );
      await tx.insert(schema.tenantSubscriptions).values({
        id: renewalId,
        tenantId: sold.tenantId,
        planVersionId: sold.catalogVersionId,
        status: "scheduled",
        startsAt: new Date("2026-10-10T09:00:00Z"),
        endsAt: new Date("2027-10-10T09:00:00Z"),
        source: "paid_invoice_line",
        sourceInvoiceLineId: secondId,
      });
      await tx
        .update(schema.invoiceApplicationEvents)
        .set({ status: "applied", afterSnapshot: { id: renewalId }, errorCode: null })
        .where(eq(schema.invoiceApplicationEvents.invoiceLineId, secondId));
      entered();
      await gate;
    });
    await ready;
    const pending = apply(sold);
    try {
      // Observe the actual PostgreSQL lock wait before exposing committed legacy partial state.
      await vi.waitFor(async () => {
        const result = await connection.pool.query(
          "select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event = 'advisory'",
        );
        expect(Number(result.rows[0]?.count)).toBeGreaterThan(0);
      });
    } finally {
      release();
    }
    await held;
    expect((await pending).results[0]).toMatchObject({
      status: "failed",
      errorCode: "commercial_plan_sequence_review_required",
    });
    const rows = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, sold.tenantId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === renewalId)).toMatchObject({
      status: "scheduled",
      startsAt: new Date("2026-10-10T09:00:00Z"),
      endsAt: new Date("2027-10-10T09:00:00Z"),
    });
    expect(rows.find((row) => row.id === base.subscriptionId)?.status).toBe("active");
    const successful = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.tenantId, sold.tenantId),
          eq(schema.platformAuditEvents.action, "billing.invoice.plan_applied"),
        ),
      );
    expect(successful).toHaveLength(0);
  });

  it("preserves a historical partial success on an invalid sequence and keeps the document readable", async () => {
    const sold = await invoice({ rules: ["on_application", "on_application"] });
    const base = await createManagedSubscription(db, {
      tenantId: sold.tenantId,
      planVersionId: sold.catalogVersionId,
    });
    await db
      .update(schema.tenantSubscriptions)
      .set({ source: "paid_invoice_line", sourceInvoiceLineId: sold.lineId })
      .where(eq(schema.tenantSubscriptions.id, base.subscriptionId));
    await db
      .update(schema.invoiceApplicationEvents)
      .set({ status: "applied", afterSnapshot: { id: base.subscriptionId } })
      .where(eq(schema.invoiceApplicationEvents.invoiceLineId, sold.lineId));
    const before = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, sold.tenantId));
    const detail = await billing.get(sold.id);
    expect(detail.lines).toHaveLength(2);
    const result = await application.apply(actor, sold.id, {
      lines: sold.lineIds.map((lineId) => ({ lineId })),
      reason: "Review historical partial sale",
    });
    expect(result.results.map((row) => row.status)).toEqual(["skipped", "failed"]);
    expect(result.results[1]?.errorCode).toBe("commercial_plan_sequence_review_required");
    expect(
      await db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, sold.tenantId)),
    ).toEqual(before);
    expect((await billing.get(sold.id)).lines).toEqual(detail.lines);
  });

  it("honors the full valid source offer when its derived invoice is applied in separate selections", async () => {
    clock();
    const sold = await acceptedOffer(undefined, "138000.00", ["on_application", "after_current"]);
    const source = await db
      .select()
      .from(schema.commercialOfferLines)
      .where(eq(schema.commercialOfferLines.offerId, sold.id))
      .orderBy(schema.commercialOfferLines.position);
    const draft = await billing.create(actor, {
      tenantId: sold.tenantId,
      sourceOfferId: sold.id,
      idempotencyKey: randomUUID(),
      applicationMode: "manual",
      lines: source.map((line) => ({
        kind: "plan",
        catalogVersionId: sold.catalogVersionId,
        quantity: 1,
        agreedUnitPrice: line.agreedUnitPrice,
        vatIncluded: false,
        activationPolicy: line.activationPolicy === "after_current" ? "after_current" : "immediate",
      })),
    });
    await db
      .update(schema.invoices)
      .set({
        status: "issued",
        issueDate: new Date(),
        issuedAt: new Date(),
        issuedByPlatformUserId: actor.userId,
        sellerSnapshot: {},
        buyerSnapshot: {},
      })
      .where(eq(schema.invoices.id, draft.id));
    await payments.recordManual(actor, draft.id, {
      amount: "138000.00",
      paidAt: new Date(),
      bankReference: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    const lines = (await billing.get(draft.id)).lines;
    const first = lines[0],
      second = lines[1];
    if (!first || !second) throw new Error("missing derived lines");
    expect((await apply({ id: draft.id, lineId: second.id })).results[0]).toMatchObject({
      status: "failed",
      errorCode: "commercial_plan_sequence_review_required",
    });
    expect((await apply({ id: draft.id, lineId: first.id })).results[0]?.status).toBe("applied");
    expect((await apply({ id: draft.id, lineId: second.id })).results[0]?.status).toBe("applied");
    const rows = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, sold.tenantId));
    expect(rows.map((row) => row.status).sort()).toEqual(["active", "scheduled"]);
    expect(rows.find((row) => row.status === "scheduled")?.startsAt).toEqual(
      rows.find((row) => row.status === "active")?.endsAt,
    );
    await expect(
      offers.pay(actor, sold.id, randomUUID(), {
        amount: "138000.00",
        currency: "RUB",
        bankReference: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: "offer_invoice_exists" } });
    expect(
      await db
        .select()
        .from(schema.commercialOfferLines)
        .where(eq(schema.commercialOfferLines.offerId, sold.id))
        .orderBy(schema.commercialOfferLines.position),
    ).toEqual(source);
  });

  it("uses the same annual lifecycle for a directly paid accepted offer", async () => {
    clock();
    const { id, lineId } = await acceptedOffer();
    const result = await offers.pay(actor, id, randomUUID(), {
      amount: "69000.00",
      currency: "RUB",
      bankReference: "annual",
    });
    const [row] = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(
        eq(
          schema.tenantSubscriptions.id,
          result.subscriptionId ?? "00000000-0000-4000-8000-000000000000",
        ),
      );
    expect(row?.endsAt?.toISOString()).toBe("2027-09-10T09:00:00.000Z");
    expect(row?.sourceOfferLineId).toBe(lineId);
    expect(row?.commercialPeriod).toMatchObject({ cycle: 0, billingPeriod: "year" });
    const [audit] = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.targetId, row?.id ?? randomUUID()),
          eq(schema.platformAuditEvents.action, "billing.offer.plan_applied"),
        ),
      );
    expect(audit).toMatchObject({
      actorPlatformUserId: actor.userId,
      actorRole: "accountant",
      tenantId: row?.tenantId,
      targetType: "tenant_subscription",
      targetId: row?.id,
      outcome: "success",
      after: { paymentOrigin: { kind: "offer", offerLineId: lineId, paymentId: result.paymentId } },
    });
  });
  it("requires review for an ambiguous legacy paid license instead of inferring from unit", async () => {
    clock();
    const sold = await invoice({ legacy: true });
    expect((await apply(sold)).results[0]).toMatchObject({
      status: "failed",
      errorCode: "commercial_terms_review_required",
    });
    expect(
      await db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, sold.tenantId)),
    ).toHaveLength(0);
  });
  it("retains an add-on purchased interval beyond the base and quantity counts resources", async () => {
    clock();
    const base = await createManagedSubscription(db, { endsAt: new Date("2026-09-20T09:00:00Z") });
    const addon = await createPublishedAddon(db, [{ entitlementKey: "stations", increment: 1 }]);
    const sold = await invoice({
      tenantId: base.tenantId,
      kind: "addon",
      catalogVersionId: addon,
      quantity: 2,
      period: "month",
    });
    expect((await apply(sold)).status).toBe("applied");
    const [row] = await db
      .select()
      .from(schema.subscriptionAddons)
      .where(
        and(
          eq(schema.subscriptionAddons.tenantId, base.tenantId),
          eq(schema.subscriptionAddons.sourceInvoiceLineId, sold.lineId),
        ),
      );
    expect(row?.quantity).toBe(2);
    expect(row?.endsAt?.toISOString()).toBe("2026-10-10T09:00:00.000Z");
    expect(row?.commercialPeriod).toMatchObject({ endsAt: "2026-10-10T09:00:00.000Z" });
    const read = new TenantBillingReadService(
      db,
      {} as ObjectStorageService,
      new EntitlementsService(db, "all"),
    );
    expect((await new EntitlementsService(db, "all").resolve(base.tenantId)).quotas.stations).toBe(
      3,
    );
    vi.setSystemTime(new Date("2026-09-21T09:00:00.000Z"));
    const view = await read["subscriptionBilling"](base.tenantId, new Date());
    expect(view.access).toBe("read_only");
    expect(view.addons[0]).toMatchObject({ status: "expired", endsAt: "2026-09-20T09:00:00.000Z" });
  });
  it("freezes document names and period from catalog, prints them, and rejects stale seller review without issuance", async () => {
    const tenantId = await createOrganization(db);
    await db.insert(schema.tenantBillingProfiles).values({
      tenantId,
      revision: 1,
      kind: "legal_entity",
      fullName: "Buyer",
      displayName: "Buyer",
      inn: "7710140679",
      addressRaw: "Moscow",
      legalAddressRaw: "Moscow",
      isConfirmed: true,
      confirmedByPlatformUserId: actor.userId,
      confirmedAt: new Date(),
      createdByPlatformUserId: actor.userId,
    });
    const versionId = randomUUID(),
      itemId = randomUUID();
    await db.insert(schema.catalogItems).values({
      id: itemId,
      code: `annual-${itemId}`,
      kind: "plan",
      nameRu: "Marketing plan",
      nameEn: "Plan",
    });
    await db.insert(schema.catalogItemVersions).values({
      id: versionId,
      catalogItemId: itemId,
      kind: "plan",
      version: 1,
      nameRu: "Marketing plan",
      nameEn: "Plan",
      documentNameRu: terms.documentNameRu,
      documentNameEn: terms.documentNameEn,
      subject: "software_license",
      sellerPolicyRevision: 1,
      unit: "year",
      billingMode: "recurring",
      billingPeriod: "year",
      unitPrice: "69000.00",
      vatIncluded: false,
    });
    await db.insert(schema.planEntitlements).values({
      catalogVersionId: versionId,
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 0,
      maxCabinetUsers: 1,
    });
    await db
      .update(schema.catalogItemVersions)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(schema.catalogItemVersions.id, versionId));
    const draft = await billing.create(actor, {
      tenantId,
      applicationMode: "manual",
      lines: [
        {
          kind: "plan",
          catalogVersionId: versionId,
          quantity: 1,
          agreedUnitPrice: "69000.00",
          vatRateBps: null,
          vatIncluded: false,
          activationPolicy: "immediate",
        },
      ],
    });
    const detail = await billing.get(draft.id);
    expect(detail.lines[0]).toMatchObject({
      nameRu: terms.documentNameRu,
      commercialTerms: terms,
      unit: "year",
      lineTotal: "69000.00",
    });
    const model = toInvoicePrintModel(detail);
    expect(model.lines[0]?.description).toContain("1 год");
    expect(model.lines[0]?.description).toContain("применения оплаты");
    await db.update(schema.operatorBillingProfiles).set({ isCurrent: false });
    await db.insert(schema.operatorBillingProfiles).values({
      revision: 2,
      kind: "self_employed",
      fullName: "Seller",
      displayName: "Seller",
      inn: "123456789012",
      addressRaw: "Moscow",
      legalAddressRaw: "Moscow",
      taxPolicy: { kind: "without_vat", regime: "npd" },
      isConfirmed: true,
      confirmedByPlatformUserId: actor.userId,
      confirmedAt: new Date(),
      createdByPlatformUserId: actor.userId,
    });
    await expect(billing.issue(actor, draft.id)).rejects.toMatchObject({
      response: { code: "commercial_review_stale" },
    });
    expect((await billing.get(draft.id)).status).toBe("draft");
  });

  it("serializes real stored seller profiles on negotiated PUT and GET without leaking legacy aliases", async () => {
    const controller = new BillingProfilesController(
      new BillingProfilesService(db, new PlatformAuditService()),
    );
    const req = {
      headers: { "x-markiro-commercial-version": "2" },
      platformPrincipal: actor,
    } as unknown as RequestWithPlatformPrincipal;
    const saved = await controller.setOperator(req, {
      kind: "self_employed",
      fullName: "Seller",
      displayName: "Seller",
      inn: "123456789012",
      legalAddressRaw: "Moscow",
      actualAddress: { sameAsLegal: true },
      postalAddress: { sameAsLegal: true },
      contact: { name: null, email: null, phone: null },
      taxPolicy: { kind: "without_vat", regime: "npd" },
    });
    expect(saved).toMatchObject({ taxPolicy: { kind: "without_vat", regime: "npd" } });
    expect(saved).not.toHaveProperty("addressRaw");
    expect(saved).not.toHaveProperty("bankDetails");
    const json = vi.fn((value: unknown) => value);
    await controller.getOperator({ json } as unknown as Response, req);
    expect(json).toHaveBeenCalledWith(saved);
  });

  it("rolls back an overflowing add-on grant while retaining its failed application event", async () => {
    clock();
    const base = await createManagedSubscription(db);
    const addonVersionId = await createPublishedAddon(db, [
      { entitlementKey: "stations", increment: 2147483647 },
    ]);
    const sold = await invoice({
      tenantId: base.tenantId,
      kind: "addon",
      catalogVersionId: addonVersionId,
      quantity: 2147483647,
    });
    expect((await apply(sold)).results[0]).toMatchObject({
      status: "failed",
      errorCode: "subscription_entitlements_invalid",
    });
    expect(
      await db
        .select()
        .from(schema.subscriptionAddons)
        .where(eq(schema.subscriptionAddons.tenantId, base.tenantId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.platformAuditEvents)
        .where(
          and(
            eq(schema.platformAuditEvents.tenantId, base.tenantId),
            eq(schema.platformAuditEvents.action, "billing.invoice.addon_applied"),
          ),
        ),
    ).toHaveLength(0);
  });
  it("allows archived immutable catalog rights and preserves a same-period renewal anchor", async () => {
    clock("2026-01-31T09:00:00.000Z");
    const first = await invoice({ period: "month" });
    await apply(first);
    await db
      .update(schema.catalogItemVersions)
      .set({ status: "retired" })
      .where(eq(schema.catalogItemVersions.id, first.catalogVersionId));
    const renewal = await invoice({
      tenantId: first.tenantId,
      catalogVersionId: first.catalogVersionId,
      period: "month",
      activationPolicy: "after_current",
    });
    expect((await apply(renewal)).status).toBe("applied");
    const [row] = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.sourceInvoiceLineId, renewal.lineId));
    expect(row?.commercialPeriod).toMatchObject({
      anchorAt: "2026-01-31T09:00:00.000Z",
      startsAt: "2026-02-28T09:00:00.000Z",
      endsAt: "2026-03-31T09:00:00.000Z",
      cycle: 1,
    });
    expect(row?.status).toBe("scheduled");
  });

  async function derive(sold: Awaited<ReturnType<typeof acceptedOffer>>, quantity = 1) {
    return billing.create(actor, {
      tenantId: sold.tenantId,
      sourceOfferId: sold.id,
      idempotencyKey: randomUUID(),
      applicationMode: "manual",
      lines: [
        {
          kind: "plan",
          catalogVersionId: sold.catalogVersionId,
          quantity,
          agreedUnitPrice: "69000.00",
          vatRateBps: null,
          vatIncluded: false,
          activationPolicy: "immediate",
        },
      ],
    });
  }
  it("copies the frozen offer VAT breakdown on fractional kopecks without changing its snapshot", async () => {
    const tenantId = await createOrganization(db);
    await db.insert(schema.tenantBillingProfiles).values({
      tenantId,
      revision: 1,
      kind: "legal_entity",
      fullName: "Buyer",
      displayName: "Buyer",
      inn: "7707083893",
      kpp: "773601001",
      ogrn: "1027700132195",
      addressRaw: "Moscow",
      legalAddressRaw: "Moscow",
      isConfirmed: true,
      confirmedByPlatformUserId: actor.userId,
      confirmedAt: new Date(),
      createdByPlatformUserId: actor.userId,
    });
    const [seller] = await db
      .select()
      .from(schema.operatorBillingProfiles)
      .where(eq(schema.operatorBillingProfiles.isCurrent, true));
    if (!seller) throw new Error("seller fixture missing");
    await db
      .update(schema.operatorBillingProfiles)
      .set({
        taxPolicy: {
          kind: "vat",
          regime: "other",
          allowedRatesBps: [2000],
          defaultRateBps: 2000,
          defaultIncluded: true,
        },
      })
      .where(eq(schema.operatorBillingProfiles.id, seller.id));
    const serviceTerms = {
      version: 1 as const,
      subject: "service" as const,
      documentNameRu: "Услуга",
      documentNameEn: "Service",
      sellerPolicyRevision: seller.revision,
      billingPeriod: null,
      billingTimezone: null,
      activationRule: null,
    };
    const lines = [true, false].map((vatIncluded) => ({
      kind: "service" as const,
      catalogVersionId: null,
      nameRu: "Услуга",
      nameEn: "Service",
      quantity: 1,
      unit: "service",
      agreedUnitPrice: "0.03",
      vatRateBps: 2000,
      vatIncluded,
      activationPolicy: null,
      commercialTerms: serviceTerms,
    }));
    const draft = await offers.create(actor, { tenantId, lines });
    await offers.publish(actor, draft.id);
    await db
      .update(schema.operatorBillingProfiles)
      .set({ taxPolicy: seller.taxPolicy })
      .where(eq(schema.operatorBillingProfiles.id, seller.id));
    const userId = randomUUID();
    await db.insert(schema.user).values({
      id: userId,
      name: "Buyer",
      email: `${userId}@example.invalid`,
      emailVerified: true,
    });
    await db.insert(schema.commercialOfferDecisions).values({
      tenantId,
      offerId: draft.id,
      decision: "accepted",
      actorUserId: userId,
      idempotencyKey: randomUUID(),
    });
    const [snapshot] = await db
      .select()
      .from(schema.commercialOfferPrintSnapshots)
      .where(eq(schema.commercialOfferPrintSnapshots.offerId, draft.id));
    expect(snapshot).toMatchObject({ subtotal: "0.05", vatTotal: "0.02", total: "0.07" });
    const converted = await billing.create(actor, {
      tenantId,
      sourceOfferId: draft.id,
      applicationMode: "manual",
      idempotencyKey: randomUUID(),
      lines: lines.map((line) => ({ ...line, kind: "custom" as const })),
    });
    expect(converted).toMatchObject({ subtotal: "0.05", vatTotal: "0.02", total: "0.07" });
    expect((await billing.get(converted.id)).lines).toMatchObject([
      { lineSubtotal: "0.02", lineVat: "0.01", lineTotal: "0.03" },
      { lineSubtotal: "0.03", lineVat: "0.01", lineTotal: "0.04" },
    ]);
    expect(
      await db
        .select()
        .from(schema.commercialOfferPrintSnapshots)
        .where(eq(schema.commercialOfferPrintSnapshots.offerId, draft.id)),
    ).toEqual([snapshot]);
  });
  it("rejects a conflicting historical VAT split even with the same grand total and preserves its snapshot", async () => {
    const sold = await acceptedOffer();
    const lines = await db
      .select()
      .from(schema.commercialOfferLines)
      .where(eq(schema.commercialOfferLines.offerId, sold.id));
    const [snapshot] = await db
      .insert(schema.commercialOfferPrintSnapshots)
      .values({
        tenantId: sold.tenantId,
        offerId: sold.id,
        revision: 1,
        number: `KP-${sold.id}`,
        publishedAt: new Date(),
        sellerSnapshot: { legacy: true },
        buyerSnapshot: { legacy: true },
        linesSnapshot: lines,
        subtotal: "68999.99",
        vatTotal: "0.01",
        total: "69000.00",
      })
      .returning();
    await expect(derive(sold)).rejects.toMatchObject({
      response: { code: "commercial_source_review_required" },
    });
    expect(
      await db
        .select()
        .from(schema.commercialOfferPrintSnapshots)
        .where(eq(schema.commercialOfferPrintSnapshots.offerId, sold.id)),
    ).toEqual([snapshot]);
    expect(
      await db.select().from(schema.invoices).where(eq(schema.invoices.sourceOfferId, sold.id)),
    ).toEqual([]);
  });
  it("requires review when historical source totals disagree without rewriting the sold offer", async () => {
    const sold = await acceptedOffer(undefined, "69000.01");
    // Historical monetary facts are immutable even when inconsistent with their lines.
    const before = await db
      .select()
      .from(schema.commercialOffers)
      .where(eq(schema.commercialOffers.id, sold.id));
    await expect(
      billing.create(actor, {
        tenantId: sold.tenantId,
        sourceOfferId: sold.id,
        idempotencyKey: randomUUID(),
        applicationMode: "manual",
        lines: [
          {
            kind: "plan",
            catalogVersionId: sold.catalogVersionId,
            quantity: 1,
            agreedUnitPrice: "69000.00",
            vatRateBps: null,
            vatIncluded: false,
            activationPolicy: "immediate",
          },
        ],
      }),
    ).rejects.toMatchObject({ response: { code: "commercial_source_review_required" } });
    expect(
      await db
        .select()
        .from(schema.commercialOffers)
        .where(eq(schema.commercialOffers.id, sold.id)),
    ).toEqual(before);
  });
  it("rejects plan quantity two and gives concurrent duplicate invoice conversion one owner", async () => {
    const sold = await acceptedOffer();
    await expect(
      billing.create(actor, {
        tenantId: sold.tenantId,
        applicationMode: "manual",
        idempotencyKey: randomUUID(),
        lines: [
          {
            kind: "plan",
            catalogVersionId: sold.catalogVersionId,
            quantity: 2,
            agreedUnitPrice: "69000.00",
            vatRateBps: null,
            vatIncluded: false,
            activationPolicy: "immediate",
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: "ZodError",
      issues: [expect.objectContaining({ path: ["lines", 0, "quantity"] })],
    });
    expect(
      await db.select().from(schema.invoices).where(eq(schema.invoices.tenantId, sold.tenantId)),
    ).toEqual([]);
    const results = await Promise.allSettled([derive(sold), derive(sold)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { response: { code: "offer_invoice_exists" } },
    });
    expect(
      await db.select().from(schema.invoices).where(eq(schema.invoices.sourceOfferId, sold.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, sold.tenantId)),
    ).toEqual([]);
  });
  it("copies the accepted offer's exact frozen terms and reserves its whole sale for one invoice", async () => {
    const sold = await acceptedOffer();
    const draft = await derive(sold);
    expect((await billing.get(draft.id)).lines[0]).toMatchObject({
      nameRu: "Annual",
      commercialTerms: terms,
      quantity: 1,
      agreedUnitPrice: "69000.00",
    });
    await expect(derive(sold)).rejects.toMatchObject({
      response: { code: "offer_invoice_exists" },
    });
    await expect(
      offers.pay(actor, sold.id, randomUUID(), {
        amount: "69000.00",
        currency: "RUB",
        bankReference: "duplicate",
      }),
    ).rejects.toMatchObject({ response: { code: "offer_invoice_exists" } });
    await db
      .update(schema.invoices)
      .set({
        status: "issued",
        issueDate: new Date(),
        issuedAt: new Date(),
        issuedByPlatformUserId: actor.userId,
        sellerSnapshot: { exact: "seller" },
        buyerSnapshot: { exact: "buyer" },
      })
      .where(eq(schema.invoices.id, draft.id));
    await billing.cancel(actor, draft.id);
    expect(
      (
        await offers.pay(actor, sold.id, randomUUID(), {
          amount: "69000.00",
          currency: "RUB",
          bankReference: "after cancellation",
        })
      ).subscriptionId,
    ).toBeTruthy();
  });
  it("rejects a changed source-offer payload and gives concurrent conversion versus direct payment one owner", async () => {
    const sold = await acceptedOffer();
    await expect(
      billing.create(actor, {
        tenantId: sold.tenantId,
        sourceOfferId: sold.id,
        idempotencyKey: randomUUID(),
        applicationMode: "manual",
        lines: [
          {
            kind: "plan",
            catalogVersionId: sold.catalogVersionId,
            quantity: 1,
            agreedUnitPrice: "1.00",
            vatIncluded: false,
            activationPolicy: "immediate",
          },
        ],
      }),
    ).rejects.toMatchObject({ response: { code: "offer_invoice_lines_mismatch" } });
    const results = await Promise.allSettled([
      derive(sold),
      offers.pay(actor, sold.id, randomUUID(), {
        amount: "69000.00",
        currency: "RUB",
        bankReference: "race",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const invoices = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.sourceOfferId, sold.id));
    const subscriptions = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, sold.tenantId));
    expect(invoices.length + subscriptions.length).toBe(1);
  });

  it("returns strict negotiated offer details and truthful legacy projections for real stored lines", async () => {
    const sold = await acceptedOffer();
    const controller = new PlatformOffersController(
      offers,
      new OfferDocumentsService(db, {} as ObjectStorageService, new PlatformAuditService()),
      new OfferWorkspaceService(db),
      new OfferPreviewService(db),
    );
    const legacy = await controller.detail(
      { platformPrincipal: actor, headers: {} } as unknown as RequestWithPlatformPrincipal,
      sold.id,
    );
    expect(legacy.lines[0]).not.toHaveProperty("commercialTerms");
    const current = await controller.detail(
      {
        platformPrincipal: actor,
        headers: { "x-markiro-commercial-version": "2" },
      } as unknown as RequestWithPlatformPrincipal,
      sold.id,
    );
    expect(current.lines[0]).toMatchObject({ commercialTerms: terms });
    const currentWorkspace = await controller.workspace(
      {
        platformPrincipal: actor,
        headers: { "x-markiro-commercial-version": "2" },
      } as unknown as RequestWithPlatformPrincipal,
      sold.id,
    );
    expect(currentWorkspace.offer.lines[0]).toMatchObject({ commercialTerms: terms });
    expect(currentWorkspace.parties.seller).toBeNull();
    const legacyWorkspace = await controller.workspace(
      { platformPrincipal: actor, headers: {} } as unknown as RequestWithPlatformPrincipal,
      sold.id,
    );
    expect(legacyWorkspace.offer.lines[0]).not.toHaveProperty("commercialTerms");
    expect(legacyWorkspace.parties.seller).toBeNull();
  });

  it("rolls grants, journal and success audit back together when the final audit fails", async () => {
    clock();
    const sold = await invoice();
    const audit = application["audit"],
      record = audit.record.bind(audit);
    const fail = vi.spyOn(audit, "record").mockImplementation(async (tx, event) => {
      if (event.action === "billing.invoice.line_applied")
        throw new Error("injected final audit failure");
      return record(tx, event);
    });
    try {
      await expect(apply(sold)).rejects.toThrow("injected final audit failure");
    } finally {
      fail.mockRestore();
    }
    expect(
      await db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, sold.tenantId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.invoiceApplicationEvents)
        .where(eq(schema.invoiceApplicationEvents.invoiceId, sold.id)),
    ).toEqual([expect.objectContaining({ status: "pending", attempt: 1 })]);
    expect(
      await db
        .select()
        .from(schema.platformAuditEvents)
        .where(
          and(
            eq(schema.platformAuditEvents.tenantId, sold.tenantId),
            eq(schema.platformAuditEvents.action, "billing.invoice.plan_applied"),
          ),
        ),
    ).toHaveLength(0);
    expect((await apply(sold)).status).toBe("applied");
  });
  it("retains cancelled fulfilled ownership when applying an already-existing paid source invoice", async () => {
    const sold = await acceptedOffer();
    const live = await derive(sold);
    await db
      .update(schema.invoices)
      .set({
        status: "issued",
        issueDate: new Date(),
        issuedAt: new Date(),
        issuedByPlatformUserId: actor.userId,
        sellerSnapshot: { exact: "seller" },
        buyerSnapshot: { exact: "buyer" },
      })
      .where(eq(schema.invoices.id, live.id));
    await payments.recordManual(actor, live.id, {
      amount: "69000.00",
      paidAt: new Date(),
      bankReference: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    const [line] = await db
      .select()
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, live.id));
    if (!line) throw new Error("Missing source line");
    // Reproduce malformed historical state, without going through the modern conversion guard.
    const fulfilled = await invoice({
      tenantId: sold.tenantId,
      catalogVersionId: sold.catalogVersionId,
    });
    expect((await apply(fulfilled)).status).toBe("applied");
    await db
      .update(schema.invoices)
      .set({ sourceOfferId: sold.id, status: "cancelled" })
      .where(eq(schema.invoices.id, fulfilled.id));
    const grantsBefore = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, sold.tenantId));
    const successBefore = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.tenantId, sold.tenantId),
          eq(schema.platformAuditEvents.outcome, "success"),
        ),
      )
      .orderBy(schema.platformAuditEvents.id);
    const priorEvents = await db
      .select()
      .from(schema.invoiceApplicationEvents)
      .where(eq(schema.invoiceApplicationEvents.invoiceId, fulfilled.id));
    const priorInvoice = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, fulfilled.id));
    expect((await apply({ id: live.id, lineId: line.id })).results[0]).toMatchObject({
      status: "failed",
      errorCode: "commercial_source_review_required",
    });
    expect(
      await db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, sold.tenantId)),
    ).toEqual(grantsBefore);
    expect(
      await db
        .select()
        .from(schema.platformAuditEvents)
        .where(
          and(
            eq(schema.platformAuditEvents.tenantId, sold.tenantId),
            eq(schema.platformAuditEvents.outcome, "success"),
          ),
        )
        .orderBy(schema.platformAuditEvents.id),
    ).toEqual(successBefore);
    expect(
      await db
        .select()
        .from(schema.invoiceApplicationEvents)
        .where(eq(schema.invoiceApplicationEvents.invoiceId, fulfilled.id)),
    ).toEqual(priorEvents);
    expect(
      await db.select().from(schema.invoices).where(eq(schema.invoices.id, fulfilled.id)),
    ).toEqual(priorInvoice);
    const failedAudit = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.tenantId, sold.tenantId),
          eq(schema.platformAuditEvents.action, "billing.invoice.line_applied"),
          eq(schema.platformAuditEvents.outcome, "failed"),
        ),
      );
    expect(failedAudit).toEqual([
      expect.objectContaining({
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        tenantId: sold.tenantId,
        targetType: "invoice_line",
        targetId: line.id,
        outcome: "failed",
        after: {
          applicationStatus: "failed",
          kind: "plan",
          errorCode: "commercial_source_review_required",
        },
      }),
    ]);
  });
  it("does not release a fulfilled derived invoice and denies legacy source re-interpretation", async () => {
    const sold = await acceptedOffer(),
      draft = await derive(sold);
    await db
      .update(schema.invoices)
      .set({
        status: "issued",
        issueDate: new Date(),
        issuedAt: new Date(),
        issuedByPlatformUserId: actor.userId,
        sellerSnapshot: { exact: "seller" },
        buyerSnapshot: { exact: "buyer" },
      })
      .where(eq(schema.invoices.id, draft.id));
    await payments.recordManual(actor, draft.id, {
      amount: "69000.00",
      paidAt: new Date(),
      bankReference: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    const [line] = await db
      .select()
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, draft.id));
    if (!line) throw new Error("Missing derived line");
    expect((await apply({ id: draft.id, lineId: line.id })).status).toBe("applied");
    await expect(billing.cancel(actor, draft.id)).rejects.toMatchObject({
      response: { code: "invoice_paid" },
    });
    await expect(
      offers.pay(actor, sold.id, randomUUID(), {
        amount: "69000.00",
        currency: "RUB",
        bankReference: "second route",
      }),
    ).rejects.toMatchObject({ response: { code: "offer_invoice_exists" } });
    const historical = await invoice({ legacy: true });
    const legacySource = await acceptedOffer(historical.tenantId);
    // Existing source links have no authoritative per-line period, and must not be upgraded by inference.
    await db
      .update(schema.invoices)
      .set({ sourceOfferId: legacySource.id })
      .where(eq(schema.invoices.id, historical.id));
    expect((await apply(historical)).results[0]).toMatchObject({
      status: "failed",
      errorCode: "commercial_source_review_required",
    });
  });
});

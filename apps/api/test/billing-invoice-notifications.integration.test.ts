import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import type { CreateInvoiceDto } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BillingService } from "../src/modules/billing/billing.service";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import {
  createTestTenantBillingNotifications,
  failingTenantBillingNotifications,
} from "./support/tenant-billing-notifications";
import { createOrganization } from "./support/subscription-fixtures";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("invoice notifications on isolated Postgres", () => {
  const databaseName = `markiro_invoice_notifications_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratchUrl.toString(), { max: 6 });
  const audit = new PlatformAuditService();
  const actorId = `invoice-notifications-${randomUUID()}`;
  const tenantUserId = `invoice-notifications-tenant-${randomUUID()}`;
  const actor: PlatformPrincipal = {
    userId: actorId,
    role: "accountant",
    capabilities: platformCapabilitiesForRole("accountant"),
    twoFactorReady: true,
  };
  let tenantId = "";
  let billing: BillingService;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    tenantId = await createOrganization(connection.db);
    await connection.db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Invoice notification actor",
      email: `${actorId}@example.invalid`,
      role: actor.role,
      status: "active",
    });
    await connection.db.insert(schema.user).values({
      id: tenantUserId,
      name: "Invoice notification owner",
      email: `${tenantUserId}@example.invalid`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await connection.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenantId,
      userId: tenantUserId,
      role: "owner",
      createdAt: new Date(),
    });
    await connection.db.insert(schema.operatorBillingProfiles).values({
      ...profileValues(actorId, "Markiro Operator", "7707083893", "773601001", "1027700132195"),
    });
    await connection.db.insert(schema.tenantBillingProfiles).values({
      tenantId,
      ...profileValues(actorId, "Invoice Buyer", "7710140679", "771001001", "1027700132196"),
    });
    await connection.db.insert(schema.operatorBankAccounts).values({
      label: "Default",
      settlementAccount: "40702810900000000001",
      bic: "044525225",
      bankName: "Test bank",
      correspondentAccount: "30101810400000000225",
      currency: "RUB",
      isDefault: true,
      createdByPlatformUserId: actorId,
    });
    billing = new BillingService(
      connection.db,
      audit,
      createTestTenantBillingNotifications(connection.db),
    );
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await maintenance.pool.end();
  });

  it("commits one delivery and outbox with a concurrent authoritative invoice issue", async () => {
    const request = await insertRequest(connection.db, tenantId, tenantUserId);
    const invoice = await billing.create(actor, {
      ...invoiceInput(tenantId),
      sourceRequestId: request.id,
    });

    const outcomes = await Promise.allSettled([
      billing.issue(actor, invoice.id),
      billing.issue(actor, invoice.id),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(
      connection.db
        .select({ status: schema.invoices.status })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, invoice.id)),
    ).resolves.toEqual([{ status: "issued" }]);
    const deliveries = await connection.db
      .select()
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.sourceId, `billing:invoice_due_soon:${invoice.id}:1`));
    expect(deliveries).toEqual([
      expect.objectContaining({
        tenantId,
        recipient: `${tenantUserId}@example.invalid`,
        kind: "tenant-billing-notification",
        status: "queued",
      }),
    ]);
    await expect(
      connection.db
        .select()
        .from(schema.emailOutbox)
        .where(eq(schema.emailOutbox.deliveryId, deliveries[0]!.id)),
    ).resolves.toHaveLength(1);
    await expect(
      connection.db
        .select()
        .from(schema.tenantBillingRequestEvents)
        .where(
          and(
            eq(schema.tenantBillingRequestEvents.requestId, request.id),
            eq(schema.tenantBillingRequestEvents.kind, "status_changed"),
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({ fromStatus: "offer_prepared", toStatus: "awaiting_payment" }),
    ]);
  });

  it("rolls state and request history back when the mandatory notifier fails", async () => {
    const request = await insertRequest(connection.db, tenantId, tenantUserId);
    const invoice = await billing.create(actor, {
      ...invoiceInput(tenantId),
      sourceRequestId: request.id,
    });
    const historyBefore = await connection.db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(eq(schema.tenantBillingRequestEvents.requestId, request.id));
    const failed = new BillingService(
      connection.db,
      audit,
      failingTenantBillingNotifications(new Error("notification enqueue failed")),
    );

    await expect(failed.issue(actor, invoice.id)).rejects.toThrow("notification enqueue failed");
    await expect(
      connection.db
        .select({ status: schema.invoices.status })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, invoice.id)),
    ).resolves.toEqual([{ status: "draft" }]);
    await expect(
      connection.db
        .select()
        .from(schema.tenantBillingRequestEvents)
        .where(eq(schema.tenantBillingRequestEvents.requestId, request.id)),
    ).resolves.toEqual(historyBefore);
    await expect(
      connection.db
        .select()
        .from(schema.emailDeliveries)
        .where(eq(schema.emailDeliveries.sourceId, `billing:invoice_due_soon:${invoice.id}:1`)),
    ).resolves.toEqual([]);
  });
});

function invoiceInput(tenantId: string): CreateInvoiceDto {
  return {
    tenantId,
    idempotencyKey: randomUUID(),
    dueDate: "2026-08-30",
    applicationMode: "manual",
    lines: [
      {
        kind: "custom",
        catalogVersionId: null,
        nameRu: "Разовая услуга",
        nameEn: "One-time service",
        quantity: 1,
        unit: "услуга",
        agreedUnitPrice: "100.00",
        vatRateBps: null,
        vatIncluded: false,
        activationPolicy: null,
      },
    ],
  };
}

async function insertRequest(db: Db, tenantId: string, userId: string) {
  const [request] = await db
    .insert(schema.tenantBillingRequests)
    .values({
      tenantId,
      number: `BR-${randomUUID()}`,
      type: "other",
      status: "offer_prepared",
      description: "Invoice notification request",
      responsibleSide: "tenant",
      idempotencyKey: randomUUID(),
      createdByUserId: userId,
    })
    .returning();
  return request!;
}

function profileValues(actorId: string, fullName: string, inn: string, kpp: string, ogrn: string) {
  return {
    revision: 1,
    kind: "legal_entity" as const,
    fullName,
    displayName: fullName,
    inn,
    kpp,
    ogrn,
    addressRaw: "Moscow",
    legalAddressRaw: "Moscow",
    isConfirmed: true,
    confirmedByPlatformUserId: actorId,
    confirmedAt: new Date(),
    createdByPlatformUserId: actorId,
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

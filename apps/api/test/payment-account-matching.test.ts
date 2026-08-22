import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, schema } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BillingApplicationService } from "../src/modules/billing/billing-application.service";
import { BillingPaymentsService } from "../src/modules/billing-payments/billing-payments.service";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("payment payer-account matching", () => {
  const databaseName = `markiro_payment_matching_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratchUrl.toString());
  const migrationsFolder = join(__dirname, "../../../packages/db/migrations");
  const actorId = `payment-matching-${randomUUID()}`;
  const tenantId = `payment-matching-${randomUUID()}`;
  const foreignTenantId = `payment-matching-foreign-${randomUUID()}`;
  const principal: PlatformPrincipal = {
    userId: actorId,
    role: "accountant",
    capabilities: platformCapabilitiesForRole("accountant"),
    twoFactorReady: true,
  };
  const service = new BillingPaymentsService(
    connection.db,
    {} as BillingApplicationService,
    new PlatformAuditService(),
  );
  const activeAccountNumber = "40702810900000000001";
  const archivedAccountNumber = "40702810900000000002";
  let activeAccountId = "";
  let archivedAccountId = "";
  let foreignAccountId = "";
  const invoices = [
    { id: randomUUID(), number: "INV-700001" },
    { id: randomUUID(), number: "INV-700002" },
    { id: randomUUID(), number: "INV-700003" },
  ];

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(connection.db, { migrationsFolder });
    await connection.db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Payment matching actor",
      email: `${actorId}@example.invalid`,
      role: "accountant",
      status: "active",
    });
    await connection.db.insert(schema.organization).values({
      id: tenantId,
      name: "Payment matching tenant",
      slug: tenantId,
      createdAt: new Date(),
    });
    await connection.db.insert(schema.organization).values({
      id: foreignTenantId,
      name: "Foreign payment matching tenant",
      slug: foreignTenantId,
      createdAt: new Date(),
    });
    await connection.db.insert(schema.invoices).values(
      invoices.map((invoice) => ({
        id: invoice.id,
        tenantId,
        number: invoice.number,
        status: "issued" as const,
        issueDate: new Date("2026-08-20T00:00:00.000Z"),
        sellerSnapshot: { fullName: "ООО Маркиро" },
        buyerSnapshot: { fullName: "ООО Покупатель" },
        subtotal: "100.00",
        total: "100.00",
        applicationMode: "manual" as const,
        createdByPlatformUserId: actorId,
        issuedByPlatformUserId: actorId,
        issuedAt: new Date("2026-08-20T00:00:00.000Z"),
      })),
    );
    const [active] = await connection.db
      .insert(schema.tenantBankAccounts)
      .values({
        tenantId,
        ...accountValues("Активный", activeAccountNumber),
        isDefault: true,
        createdByPlatformUserId: actorId,
      })
      .returning();
    const [archived] = await connection.db
      .insert(schema.tenantBankAccounts)
      .values({
        tenantId,
        ...accountValues("Архивный", archivedAccountNumber),
        status: "archived",
        archivedByPlatformUserId: actorId,
        archivedAt: new Date(),
        createdByPlatformUserId: actorId,
      })
      .returning();
    activeAccountId = active!.id;
    archivedAccountId = archived!.id;
    const [foreign] = await connection.db
      .insert(schema.tenantBankAccounts)
      .values({
        tenantId: foreignTenantId,
        ...accountValues("Чужой", "40702810900000000003"),
        isDefault: true,
        createdByPlatformUserId: actorId,
      })
      .returning();
    foreignAccountId = foreign!.id;
  });

  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenance.pool.end();
  });

  it("suggests active known accounts and sends archived or unknown accounts to review", async () => {
    await service.importFile(principal, importInput(invoices[0]!.number, activeAccountNumber, "A"));
    await service.importFile(
      principal,
      importInput(invoices[1]!.number, archivedAccountNumber, "B"),
    );
    await service.importFile(
      principal,
      importInput(invoices[2]!.number, "40702810900000009999", "C"),
    );

    const { items } = await service.listMatches(tenantId);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invoiceId: invoices[0]!.id,
          status: "suggested",
          tenantBankAccountId: activeAccountId,
          payerAccountEvidence: {
            kind: "known",
            last4: "0001",
            accountStatus: "active",
            label: "Активный",
          },
        }),
        expect.objectContaining({
          invoiceId: invoices[1]!.id,
          status: "needs_review",
          tenantBankAccountId: archivedAccountId,
          payerAccountEvidence: {
            kind: "known",
            last4: "0002",
            accountStatus: "archived",
            label: "Архивный",
          },
        }),
        expect.objectContaining({
          invoiceId: invoices[2]!.id,
          status: "needs_review",
          tenantBankAccountId: null,
          payerAccountEvidence: { kind: "unknown", last4: "9999" },
        }),
      ]),
    );
    expect(JSON.stringify(items)).not.toContain(activeAccountNumber);
    expect(JSON.stringify(items)).not.toContain(archivedAccountNumber);
  });

  it("manually resolves an unknown payer without creating a tenant account", async () => {
    const { items } = await service.listMatches(tenantId);
    const unknown = items.find((item) => item.invoiceId === invoices[2]!.id);
    expect(unknown).toBeDefined();
    const accountsBefore = await connection.db
      .select({ id: schema.tenantBankAccounts.id })
      .from(schema.tenantBankAccounts)
      .where(eq(schema.tenantBankAccounts.tenantId, tenantId));

    const resolved = await service.resolveMatch(principal, unknown!.id, {
      decision: "matched",
      tenantId,
      invoiceId: invoices[2]!.id,
      tenantBankAccountId: null,
      reason: "operator_verified_external_account",
    });

    expect(resolved).toMatchObject({
      status: "matched",
      tenantBankAccountId: null,
      payerAccountEvidence: { kind: "unknown", last4: "9999" },
    });
    const accountsAfter = await connection.db
      .select({ id: schema.tenantBankAccounts.id })
      .from(schema.tenantBankAccounts)
      .where(eq(schema.tenantBankAccounts.tenantId, tenantId));
    expect(accountsAfter).toEqual(accountsBefore);
    const [payment] = await connection.db
      .select()
      .from(schema.billingPayments)
      .where(eq(schema.billingPayments.importRowId, unknown!.importRowId));
    expect(payment).toMatchObject({ source: "bank_import", invoiceId: invoices[2]!.id });

    const auditEvents = await connection.db
      .select({ after: schema.platformAuditEvents.after })
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.actorPlatformUserId, actorId));
    expect(JSON.stringify(auditEvents)).not.toContain("40702810900000009999");
    expect(JSON.stringify(auditEvents)).toContain("9999");

    const retried = await service.resolveMatch(principal, unknown!.id, {
      decision: "matched",
      tenantId,
      invoiceId: invoices[2]!.id,
      tenantBankAccountId: null,
      reason: "operator_verified_external_account",
    });
    expect(retried.decidedAt).toEqual(resolved.decidedAt);
    const decisionAudits = await connection.db
      .select({ id: schema.platformAuditEvents.id })
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.targetId, unknown!.id));
    expect(decisionAudits).toHaveLength(1);
    await expect(
      service.resolveMatch(principal, unknown!.id, {
        decision: "rejected",
        reason: "conflicting_retry",
      }),
    ).rejects.toMatchObject({ response: { code: "payment_match_already_decided" } });
  });

  it("denies resolving a tenant payment against another tenant's bank account", async () => {
    await service.importFile(
      principal,
      importInput(invoices[2]!.number, "40702810900000008888", "D"),
    );
    const { items } = await service.listMatches(tenantId);
    const unknown = items.find((item) => item.bankReference === "REF-D");
    expect(unknown).toBeDefined();

    await expect(
      service.resolveMatch(principal, unknown!.id, {
        decision: "matched",
        tenantId,
        invoiceId: invoices[2]!.id,
        tenantBankAccountId: foreignAccountId,
        reason: "cross_tenant_probe",
      }),
    ).rejects.toMatchObject({ response: { code: "billing_account_not_found" } });
  });

  it("audits a rejected archived-account suggestion without exposing account details", async () => {
    const { items } = await service.listMatches(tenantId);
    const archived = items.find((item) => item.invoiceId === invoices[1]!.id);
    expect(archived).toBeDefined();

    const rejected = await service.resolveMatch(principal, archived!.id, {
      decision: "rejected",
      reason: "payer_account_no_longer_accepted",
    });

    expect(rejected).toMatchObject({ status: "rejected", tenantBankAccountId: archivedAccountId });
    const auditEvents = await connection.db
      .select({
        action: schema.platformAuditEvents.action,
        after: schema.platformAuditEvents.after,
      })
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.targetId, archived!.id));
    expect(auditEvents).toEqual([
      {
        action: "billing.payment_match.resolved",
        after: { status: "rejected", tenantBankAccountId: archivedAccountId },
      },
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain(archivedAccountNumber);
  });

  function importInput(invoiceNumber: string, payerAccount: string, reference: string) {
    return {
      fileName: `${reference}.csv`,
      content: [
        "amount,date,currency,payer,payer_account,purpose,reference",
        `100.00,2026-08-21,RUB,ООО Плательщик,${payerAccount},Оплата ${invoiceNumber},REF-${reference}`,
      ].join("\n"),
    };
  }

  function accountValues(label: string, settlementAccount: string) {
    return {
      label,
      settlementAccount,
      bic: "044525225",
      bankName: "ПАО Сбербанк",
      correspondentAccount: "30101810400000000225",
      currency: "RUB",
    } as const;
  }
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}

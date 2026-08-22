import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, schema } from "@markiro/db";
import type { CreateInvoiceDto, CreateOfferDto } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BillingService } from "../src/modules/billing/billing.service";
import {
  toInvoicePrintModel,
  toOfferPrintModel,
} from "../src/modules/billing/print-document-model";
import { PlatformOffersService } from "../src/modules/platform-offers/platform-offers.service";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("commercial document account snapshots", () => {
  const databaseName = `markiro_document_snapshots_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratchUrl.toString());
  const migrationsFolder = join(__dirname, "../../../packages/db/migrations");
  const actorId = `document-snapshots-${randomUUID()}`;
  const tenantId = `document-snapshots-${randomUUID()}`;
  const principal: PlatformPrincipal = {
    userId: actorId,
    role: "accountant",
    capabilities: platformCapabilitiesForRole("accountant"),
    twoFactorReady: true,
  };
  const audit = new PlatformAuditService();
  const billing = new BillingService(connection.db, audit);
  const offers = new PlatformOffersService(connection.db, audit);
  let sellerAccountId = "";

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(connection.db, { migrationsFolder });
    await connection.db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Document snapshot actor",
      email: `${actorId}@example.invalid`,
      role: "accountant",
      status: "active",
    });
    await connection.db.insert(schema.organization).values({
      id: tenantId,
      name: "Document snapshot tenant",
      slug: tenantId,
      createdAt: new Date(),
    });
    await connection.db
      .insert(schema.operatorBillingProfiles)
      .values(profileValues(1, "ООО Маркиро", "7707083893", "773601001", "1027700132195"));
    await connection.db.insert(schema.tenantBillingProfiles).values({
      tenantId,
      ...profileValues(1, "ООО Покупатель", "7812014560", "781201001", "1027800000000"),
    });
    const [sellerAccount] = await connection.db
      .insert(schema.operatorBankAccounts)
      .values({
        ...accountValues("Основной счёт Маркиро", "0001"),
        isDefault: true,
        createdByPlatformUserId: actorId,
      })
      .returning();
    sellerAccountId = sellerAccount!.id;
    await connection.db.insert(schema.tenantBankAccounts).values({
      tenantId,
      ...accountValues("Основной счёт покупателя", "0002"),
      isDefault: true,
      createdByPlatformUserId: actorId,
    });
  });

  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenance.pool.end();
  });

  it("keeps invoice and offer parties unchanged after current details are replaced", async () => {
    const draftInvoice = await billing.create(principal, invoiceInput());
    const issuedInvoice = await billing.issue(principal, draftInvoice.id);
    const draftOffer = await offers.create(principal, offerInput());
    const publishedOffer = await offers.publish(principal, draftOffer.id);

    const invoiceBefore = await invoiceWithLines(issuedInvoice.id);
    const [offerSnapshotBefore] = await connection.db
      .select()
      .from(schema.commercialOfferPrintSnapshots)
      .where(eq(schema.commercialOfferPrintSnapshots.offerId, publishedOffer.id));
    expect(offerSnapshotBefore).toBeDefined();

    const frozenInvoiceFields = {
      sellerSnapshot: invoiceBefore.sellerSnapshot,
      buyerSnapshot: invoiceBefore.buyerSnapshot,
      sellerBankAccountSnapshot: invoiceBefore.sellerBankAccountSnapshot,
      buyerBankAccountSnapshot: invoiceBefore.buyerBankAccountSnapshot,
    };
    const frozenOfferFields = {
      sellerSnapshot: offerSnapshotBefore!.sellerSnapshot,
      buyerSnapshot: offerSnapshotBefore!.buyerSnapshot,
      sellerBankAccountSnapshot: offerSnapshotBefore!.sellerBankAccountSnapshot,
      buyerBankAccountSnapshot: offerSnapshotBefore!.buyerBankAccountSnapshot,
    };
    const invoicePrintBefore = toInvoicePrintModel(invoiceBefore);
    const offerPrintBefore = toOfferPrintModel({ ...offerSnapshotBefore!, status: "published" });

    await replaceCurrentDetails();

    const invoiceAfter = await invoiceWithLines(issuedInvoice.id);
    const [offerSnapshotAfter] = await connection.db
      .select()
      .from(schema.commercialOfferPrintSnapshots)
      .where(eq(schema.commercialOfferPrintSnapshots.offerId, publishedOffer.id));
    expect(invoiceAfter).toMatchObject(frozenInvoiceFields);
    expect(offerSnapshotAfter).toMatchObject(frozenOfferFields);
    expect(toInvoicePrintModel(invoiceAfter)).toEqual(invoicePrintBefore);
    expect(toOfferPrintModel({ ...offerSnapshotAfter!, status: "published" })).toEqual(
      offerPrintBefore,
    );
    expect(invoicePrintBefore.seller).toMatchObject({
      legalName: "ООО Маркиро",
      bankAccount: "40702810900000000001",
    });
    expect(offerPrintBefore.buyer).toMatchObject({
      legalName: "ООО Покупатель",
      bankAccount: "40702810900000000002",
    });

    const auditEvents = await connection.db
      .select({ after: schema.platformAuditEvents.after })
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.actorPlatformUserId, actorId));
    const serializedAudit = JSON.stringify(auditEvents);
    expect(serializedAudit).not.toContain("40702810900000000001");
    expect(serializedAudit).not.toContain("40702810900000000002");
    expect(serializedAudit).toContain("0001");
    expect(serializedAudit).toContain("0002");
  });

  async function invoiceWithLines(id: string) {
    const [invoice] = await connection.db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, id));
    const lines = await connection.db
      .select()
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, id));
    if (!invoice) throw new Error("invoice not found");
    return { ...invoice, lines };
  }

  async function replaceCurrentDetails() {
    await connection.db
      .update(schema.operatorBillingProfiles)
      .set({ isCurrent: false })
      .where(eq(schema.operatorBillingProfiles.isCurrent, true));
    await connection.db
      .insert(schema.operatorBillingProfiles)
      .values(profileValues(2, "ООО Маркиро Новое", "7707083893", "773601001", "1027700132195"));
    await connection.db
      .update(schema.tenantBillingProfiles)
      .set({ isCurrent: false })
      .where(eq(schema.tenantBillingProfiles.tenantId, tenantId));
    await connection.db.insert(schema.tenantBillingProfiles).values({
      tenantId,
      ...profileValues(2, "ООО Покупатель Новое", "7812014560", "781201001", "1027800000000"),
    });

    await connection.db
      .update(schema.operatorBankAccounts)
      .set({
        status: "archived",
        isDefault: false,
        archivedByPlatformUserId: actorId,
        archivedAt: new Date(),
      })
      .where(eq(schema.operatorBankAccounts.isDefault, true));
    await connection.db.insert(schema.operatorBankAccounts).values({
      ...accountValues("Новый счёт Маркиро", "0003"),
      isDefault: true,
      createdByPlatformUserId: actorId,
    });
    await connection.db
      .update(schema.tenantBankAccounts)
      .set({
        status: "archived",
        isDefault: false,
        archivedByPlatformUserId: actorId,
        archivedAt: new Date(),
      })
      .where(eq(schema.tenantBankAccounts.tenantId, tenantId));
    await connection.db.insert(schema.tenantBankAccounts).values({
      tenantId,
      ...accountValues("Новый счёт покупателя", "0004"),
      isDefault: true,
      createdByPlatformUserId: actorId,
    });
  }

  function invoiceInput(): CreateInvoiceDto {
    return {
      tenantId,
      sellerBankAccountId: sellerAccountId,
      dueDate: null,
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

  function offerInput(): CreateOfferDto {
    return {
      tenantId,
      sellerBankAccountId: sellerAccountId,
      expiresAt: null,
      lines: [
        {
          kind: "service",
          catalogVersionId: null,
          nameRu: "Разовая услуга",
          nameEn: "One-time service",
          quantity: 1,
          unit: "услуга",
          agreedUnitPrice: "100.00",
          vatRateBps: null,
          vatIncluded: false,
          priceOverrideReason: null,
          activationPolicy: null,
        },
      ],
    };
  }

  function profileValues(
    revision: number,
    fullName: string,
    inn: string,
    kpp: string,
    ogrn: string,
  ) {
    return {
      revision,
      kind: "legal_entity" as const,
      fullName,
      displayName: fullName,
      inn,
      kpp,
      ogrn,
      addressRaw: "Москва",
      legalAddressRaw: "Москва",
      postalSameAsLegal: true,
      isConfirmed: true,
      confirmedByPlatformUserId: actorId,
      confirmedAt: new Date(),
      createdByPlatformUserId: actorId,
    };
  }

  function accountValues(label: string, suffix: string) {
    return {
      label,
      settlementAccount: `4070281090000000${suffix}`,
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

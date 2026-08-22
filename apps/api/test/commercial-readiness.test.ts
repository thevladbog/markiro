import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, schema } from "@markiro/db";
import type { CreateInvoiceDto } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BillingService } from "../src/modules/billing/billing.service";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("commercial document readiness", () => {
  const databaseName = `markiro_commercial_readiness_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratchUrl.toString());
  const migrationsFolder = join(__dirname, "../../../packages/db/migrations");
  const actorId = `commercial-readiness-${randomUUID()}`;
  const tenantId = `commercial-readiness-${randomUUID()}`;
  const principal: PlatformPrincipal = {
    userId: actorId,
    role: "accountant",
    capabilities: platformCapabilitiesForRole("accountant"),
    twoFactorReady: true,
  };
  const service = new BillingService(connection.db, new PlatformAuditService());

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(connection.db, { migrationsFolder });
    await connection.db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Commercial readiness actor",
      email: `${actorId}@example.invalid`,
      role: "accountant",
      status: "active",
    });
    await connection.db.insert(schema.organization).values({
      id: tenantId,
      name: "Commercial readiness tenant",
      slug: tenantId,
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenance.pool.end();
  });

  it("allows incomplete drafts but blocks issue with a precise readiness reason", async () => {
    const draft = await service.create(principal, invoiceInput());

    await expect(service.issue(principal, draft.id)).rejects.toMatchObject({
      response: { code: "billing_seller_profile_required" },
    });
    expect(await invoiceStatus(draft.id)).toBe("draft");

    await connection.db.insert(schema.operatorBillingProfiles).values(
      profileValues({
        fullName: "ООО Маркиро",
        inn: "7707083893",
        kpp: "773601001",
        ogrn: "1027700132195",
      }),
    );
    await expect(service.issue(principal, draft.id)).rejects.toMatchObject({
      response: { code: "billing_buyer_profile_required" },
    });

    const [buyer] = await connection.db
      .insert(schema.tenantBillingProfiles)
      .values({
        tenantId,
        ...profileValues({
          fullName: "ООО Покупатель",
          inn: "7812014560",
          kpp: "781201001",
          ogrn: "1027800000000",
          isConfirmed: false,
        }),
      })
      .returning();
    expect(buyer).toBeDefined();
    await expect(service.issue(principal, draft.id)).rejects.toMatchObject({
      response: { code: "billing_profile_unconfirmed" },
    });

    await connection.db
      .update(schema.tenantBillingProfiles)
      .set({ isConfirmed: true, confirmedByPlatformUserId: actorId, confirmedAt: new Date() })
      .where(eq(schema.tenantBillingProfiles.id, buyer!.id));
    await expect(service.issue(principal, draft.id)).rejects.toMatchObject({
      response: { code: "billing_seller_account_required" },
    });
    expect(await invoiceStatus(draft.id)).toBe("draft");
  });

  it("rechecks a selected seller account when the draft is issued", async () => {
    await ensureConfirmedProfiles();
    const [selected] = await connection.db
      .insert(schema.operatorBankAccounts)
      .values({
        ...accountValues("Выбранный счёт", "0001"),
        isDefault: true,
        createdByPlatformUserId: actorId,
      })
      .returning();
    const draft = await service.create(
      principal,
      invoiceInput({ sellerBankAccountId: selected!.id }),
    );

    await connection.db
      .update(schema.operatorBankAccounts)
      .set({
        status: "archived",
        isDefault: false,
        archivedByPlatformUserId: actorId,
        archivedAt: new Date(),
      })
      .where(eq(schema.operatorBankAccounts.id, selected!.id));

    await expect(service.issue(principal, draft.id)).rejects.toMatchObject({
      response: { code: "billing_seller_account_inactive" },
    });
    expect(await invoiceStatus(draft.id)).toBe("draft");
  });

  it("issues a confirmed buyer invoice without a default buyer account", async () => {
    await ensureConfirmedProfiles();
    await connection.db.insert(schema.operatorBankAccounts).values({
      ...accountValues("Основной счёт продавца", "0002"),
      isDefault: true,
      createdByPlatformUserId: actorId,
    });
    const draft = await service.create(principal, invoiceInput());

    const issued = await service.issue(principal, draft.id);

    expect(issued.status).toBe("issued");
    expect(issued.buyerBankAccountSnapshot).toBeNull();
  });

  async function invoiceStatus(id: string) {
    const [invoice] = await connection.db
      .select({ status: schema.invoices.status })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, id));
    return invoice?.status;
  }

  async function ensureConfirmedProfiles() {
    const [seller] = await connection.db
      .select({ id: schema.operatorBillingProfiles.id })
      .from(schema.operatorBillingProfiles)
      .where(eq(schema.operatorBillingProfiles.isCurrent, true));
    if (!seller) {
      await connection.db.insert(schema.operatorBillingProfiles).values(
        profileValues({
          fullName: "ООО Маркиро",
          inn: "7707083893",
          kpp: "773601001",
          ogrn: "1027700132195",
        }),
      );
    }
    const [buyer] = await connection.db
      .select({ id: schema.tenantBillingProfiles.id })
      .from(schema.tenantBillingProfiles)
      .where(eq(schema.tenantBillingProfiles.tenantId, tenantId));
    if (!buyer) {
      await connection.db.insert(schema.tenantBillingProfiles).values({
        tenantId,
        ...profileValues({
          fullName: "ООО Покупатель",
          inn: "7812014560",
          kpp: "781201001",
          ogrn: "1027800000000",
        }),
      });
    }
  }

  function invoiceInput(
    overrides: Partial<Pick<CreateInvoiceDto, "sellerBankAccountId">> = {},
  ): CreateInvoiceDto {
    return {
      tenantId,
      dueDate: null,
      applicationMode: "manual",
      ...overrides,
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

  function profileValues(input: {
    fullName: string;
    inn: string;
    kpp: string;
    ogrn: string;
    isConfirmed?: boolean;
  }) {
    const isConfirmed = input.isConfirmed ?? true;
    return {
      revision: 1,
      kind: "legal_entity" as const,
      fullName: input.fullName,
      displayName: input.fullName,
      inn: input.inn,
      kpp: input.kpp,
      ogrn: input.ogrn,
      addressRaw: "Москва",
      legalAddressRaw: "Москва",
      postalSameAsLegal: true,
      isConfirmed,
      confirmedByPlatformUserId: isConfirmed ? actorId : null,
      confirmedAt: isConfirmed ? new Date() : null,
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

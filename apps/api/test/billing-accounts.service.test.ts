import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, schema } from "@markiro/db";
import type { BankAccountInput } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BillingAccountsService } from "../src/modules/billing-accounts/billing-accounts.service";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("BillingAccountsService", () => {
  const databaseName = `markiro_billing_accounts_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratchUrl.toString());
  const migrationsFolder = join(__dirname, "../../../packages/db/migrations");
  const actorId = `bank-service-${randomUUID()}`;
  const tenantA = `bank-service-a-${randomUUID()}`;
  const tenantB = `bank-service-b-${randomUUID()}`;
  const principal: PlatformPrincipal = {
    userId: actorId,
    role: "accountant",
    capabilities: platformCapabilitiesForRole("accountant"),
    twoFactorReady: true,
  };
  const service = new BillingAccountsService(connection.db, new PlatformAuditService());

  function account(sequence: number): BankAccountInput {
    const suffix = sequence.toString().padStart(4, "0");
    return {
      label: `Счёт ${sequence}`,
      settlementAccount: `4070281090000000${suffix}`,
      bic: "044525225",
      bankName: "ПАО Сбербанк",
      correspondentAccount: "30101810400000000225",
      currency: "RUB",
    };
  }

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(connection.db, { migrationsFolder });
    await connection.db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Bank service actor",
      email: `${actorId}@example.invalid`,
      role: "accountant",
      status: "active",
    });
    const createdAt = new Date();
    await connection.db.insert(schema.organization).values([
      { id: tenantA, name: "Bank tenant A", slug: tenantA, createdAt },
      { id: tenantB, name: "Bank tenant B", slug: tenantB, createdAt },
    ]);
  });

  afterAll(async () => {
    await connection.db
      .delete(schema.tenantBankAccounts)
      .where(inArray(schema.tenantBankAccounts.tenantId, [tenantA, tenantB]));
    await connection.db
      .delete(schema.operatorBankAccounts)
      .where(eq(schema.operatorBankAccounts.createdByPlatformUserId, actorId));
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenance.pool.end();
  });

  it("keeps one operator default through create, replace, and archive transitions", async () => {
    const first = await service.createOperator(principal, account(1));
    const second = await service.createOperator(principal, account(2));
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    const newDefault = await service.setOperatorDefault(principal, second.id);
    expect(newDefault.isDefault).toBe(true);

    const archivedFirst = await service.archiveOperator(principal, first.id, {});
    expect(archivedFirst).toMatchObject({ status: "archived", isDefault: false });
    await expect(service.archiveOperator(principal, second.id, {})).rejects.toMatchObject({
      response: { code: "billing_account_replacement_required" },
    });

    const third = await service.createOperator(principal, account(3));
    expect(third.isDefault).toBe(false);
    const archivedSecond = await service.archiveOperator(principal, second.id, {
      replacementAccountId: third.id,
    });
    expect(archivedSecond).toMatchObject({ status: "archived", isDefault: false });

    const listed = await service.listOperator();
    expect(listed.filter((item) => item.status === "active" && item.isDefault)).toHaveLength(1);
    expect(listed.find((item) => item.id === third.id)?.isDefault).toBe(true);

    const events = await connection.db
      .select({
        action: schema.platformAuditEvents.action,
        before: schema.platformAuditEvents.before,
        after: schema.platformAuditEvents.after,
      })
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.actorPlatformUserId, actorId));
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "billing.operator_account.created",
        "billing.operator_account.default_changed",
        "billing.operator_account.archived",
      ]),
    );
    const serializedAudit = JSON.stringify(events);
    expect(serializedAudit).not.toContain(account(1).settlementAccount);
    expect(serializedAudit).not.toContain(account(2).settlementAccount);
    expect(serializedAudit).toContain(account(3).settlementAccount.slice(-4));
  });

  it("does not disclose a tenant account through another tenant scope", async () => {
    const foreign = await service.createTenant(principal, tenantB, account(4));

    await expect(service.setTenantDefault(principal, tenantA, foreign.id)).rejects.toMatchObject({
      status: 404,
      response: { code: "billing_account_not_found" },
    });
    expect(
      await connection.db
        .select({ tenantId: schema.tenantBankAccounts.tenantId })
        .from(schema.tenantBankAccounts)
        .where(
          and(
            eq(schema.tenantBankAccounts.id, foreign.id),
            eq(schema.tenantBankAccounts.tenantId, tenantB),
          ),
        ),
    ).toEqual([{ tenantId: tenantB }]);
  });
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}

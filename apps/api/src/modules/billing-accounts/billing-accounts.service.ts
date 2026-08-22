import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type { BankAccountArchiveInput, BankAccountInput } from "./dto";

type OperatorAccount = typeof schema.operatorBankAccounts.$inferSelect;
type TenantAccount = typeof schema.tenantBankAccounts.$inferSelect;

@Injectable()
export class BillingAccountsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
  ) {}

  listOperator(): Promise<OperatorAccount[]> {
    return this.db
      .select()
      .from(schema.operatorBankAccounts)
      .orderBy(
        asc(schema.operatorBankAccounts.status),
        desc(schema.operatorBankAccounts.isDefault),
        desc(schema.operatorBankAccounts.createdAt),
      );
  }

  createOperator(principal: PlatformPrincipal, input: BankAccountInput): Promise<OperatorAccount> {
    return this.db.transaction(async (tx) => {
      await lockParty(tx, "operator");
      const [currentDefault] = await tx
        .select({ id: schema.operatorBankAccounts.id })
        .from(schema.operatorBankAccounts)
        .where(
          and(
            eq(schema.operatorBankAccounts.status, "active"),
            eq(schema.operatorBankAccounts.isDefault, true),
          ),
        )
        .limit(1);
      const [created] = await tx
        .insert(schema.operatorBankAccounts)
        .values({ ...input, isDefault: !currentDefault, createdByPlatformUserId: principal.userId })
        .returning();
      if (!created) throw new ConflictException({ code: "billing_account_create_failed" });
      await recordAccountAudit(this.audit, tx, principal, {
        action: "billing.operator_account.created",
        tenantId: null,
        targetType: "operator_bank_account",
        account: created,
        before: null,
        after: accountAuditSummary(created),
      });
      return created;
    });
  }

  setOperatorDefault(principal: PlatformPrincipal, accountId: string): Promise<OperatorAccount> {
    return this.db.transaction(async (tx) => {
      await lockParty(tx, "operator");
      const target = await findActiveOperatorAccount(tx, accountId);
      if (target.isDefault) return target;
      const [previous] = await tx
        .select()
        .from(schema.operatorBankAccounts)
        .where(
          and(
            eq(schema.operatorBankAccounts.status, "active"),
            eq(schema.operatorBankAccounts.isDefault, true),
          ),
        )
        .limit(1);
      if (previous) {
        await tx
          .update(schema.operatorBankAccounts)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(eq(schema.operatorBankAccounts.id, previous.id));
      }
      const [updated] = await tx
        .update(schema.operatorBankAccounts)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(schema.operatorBankAccounts.id, target.id))
        .returning();
      if (!updated) throw new ConflictException({ code: "billing_account_default_failed" });
      await recordAccountAudit(this.audit, tx, principal, {
        action: "billing.operator_account.default_changed",
        tenantId: null,
        targetType: "operator_bank_account",
        account: updated,
        before: {
          previousDefault: previous ? accountAuditSummary(previous) : null,
          account: accountAuditSummary(target),
        },
        after: { account: accountAuditSummary(updated) },
      });
      return updated;
    });
  }

  archiveOperator(
    principal: PlatformPrincipal,
    accountId: string,
    input: BankAccountArchiveInput,
  ): Promise<OperatorAccount> {
    return this.db.transaction(async (tx) => {
      await lockParty(tx, "operator");
      const target = await findActiveOperatorAccount(tx, accountId);
      const replacement = await resolveOperatorReplacement(tx, target, input);
      const [archived] = await tx
        .update(schema.operatorBankAccounts)
        .set({
          status: "archived",
          isDefault: false,
          archivedByPlatformUserId: principal.userId,
          archivedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.operatorBankAccounts.id, target.id))
        .returning();
      if (!archived) throw new ConflictException({ code: "billing_account_archive_failed" });
      const activatedReplacement = replacement
        ? await setOperatorReplacementDefault(tx, replacement)
        : null;
      await recordAccountAudit(this.audit, tx, principal, {
        action: "billing.operator_account.archived",
        tenantId: null,
        targetType: "operator_bank_account",
        account: archived,
        before: { account: accountAuditSummary(target) },
        after: {
          account: accountAuditSummary(archived),
          replacement: activatedReplacement ? accountAuditSummary(activatedReplacement) : null,
        },
      });
      return archived;
    });
  }

  async listTenant(tenantId: string): Promise<TenantAccount[]> {
    await assertTenantExists(this.db, tenantId);
    return this.db
      .select()
      .from(schema.tenantBankAccounts)
      .where(eq(schema.tenantBankAccounts.tenantId, tenantId))
      .orderBy(
        asc(schema.tenantBankAccounts.status),
        desc(schema.tenantBankAccounts.isDefault),
        desc(schema.tenantBankAccounts.createdAt),
      );
  }

  createTenant(
    principal: PlatformPrincipal,
    tenantId: string,
    input: BankAccountInput,
  ): Promise<TenantAccount> {
    return this.db.transaction(async (tx) => {
      await assertTenantExists(tx, tenantId);
      await lockParty(tx, `tenant:${tenantId}`);
      const [currentDefault] = await tx
        .select({ id: schema.tenantBankAccounts.id })
        .from(schema.tenantBankAccounts)
        .where(
          and(
            eq(schema.tenantBankAccounts.tenantId, tenantId),
            eq(schema.tenantBankAccounts.status, "active"),
            eq(schema.tenantBankAccounts.isDefault, true),
          ),
        )
        .limit(1);
      const [created] = await tx
        .insert(schema.tenantBankAccounts)
        .values({
          ...input,
          tenantId,
          isDefault: !currentDefault,
          createdByPlatformUserId: principal.userId,
        })
        .returning();
      if (!created) throw new ConflictException({ code: "billing_account_create_failed" });
      await recordAccountAudit(this.audit, tx, principal, {
        action: "billing.tenant_account.created",
        tenantId,
        targetType: "tenant_bank_account",
        account: created,
        before: null,
        after: accountAuditSummary(created),
      });
      return created;
    });
  }

  setTenantDefault(
    principal: PlatformPrincipal,
    tenantId: string,
    accountId: string,
  ): Promise<TenantAccount> {
    return this.db.transaction(async (tx) => {
      await assertTenantExists(tx, tenantId);
      await lockParty(tx, `tenant:${tenantId}`);
      const target = await findActiveTenantAccount(tx, tenantId, accountId);
      if (target.isDefault) return target;
      const [previous] = await tx
        .select()
        .from(schema.tenantBankAccounts)
        .where(
          and(
            eq(schema.tenantBankAccounts.tenantId, tenantId),
            eq(schema.tenantBankAccounts.status, "active"),
            eq(schema.tenantBankAccounts.isDefault, true),
          ),
        )
        .limit(1);
      if (previous) {
        await tx
          .update(schema.tenantBankAccounts)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(schema.tenantBankAccounts.tenantId, tenantId),
              eq(schema.tenantBankAccounts.id, previous.id),
            ),
          );
      }
      const [updated] = await tx
        .update(schema.tenantBankAccounts)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(
          and(
            eq(schema.tenantBankAccounts.tenantId, tenantId),
            eq(schema.tenantBankAccounts.id, target.id),
          ),
        )
        .returning();
      if (!updated) throw new ConflictException({ code: "billing_account_default_failed" });
      await recordAccountAudit(this.audit, tx, principal, {
        action: "billing.tenant_account.default_changed",
        tenantId,
        targetType: "tenant_bank_account",
        account: updated,
        before: {
          previousDefault: previous ? accountAuditSummary(previous) : null,
          account: accountAuditSummary(target),
        },
        after: { account: accountAuditSummary(updated) },
      });
      return updated;
    });
  }

  archiveTenant(
    principal: PlatformPrincipal,
    tenantId: string,
    accountId: string,
    input: BankAccountArchiveInput,
  ): Promise<TenantAccount> {
    return this.db.transaction(async (tx) => {
      await assertTenantExists(tx, tenantId);
      await lockParty(tx, `tenant:${tenantId}`);
      const target = await findActiveTenantAccount(tx, tenantId, accountId);
      const replacement = await resolveTenantReplacement(tx, tenantId, target, input);
      const [archived] = await tx
        .update(schema.tenantBankAccounts)
        .set({
          status: "archived",
          isDefault: false,
          archivedByPlatformUserId: principal.userId,
          archivedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.tenantBankAccounts.tenantId, tenantId),
            eq(schema.tenantBankAccounts.id, target.id),
          ),
        )
        .returning();
      if (!archived) throw new ConflictException({ code: "billing_account_archive_failed" });
      const [activatedReplacement] = replacement
        ? await tx
            .update(schema.tenantBankAccounts)
            .set({ isDefault: true, updatedAt: new Date() })
            .where(
              and(
                eq(schema.tenantBankAccounts.tenantId, tenantId),
                eq(schema.tenantBankAccounts.id, replacement.id),
              ),
            )
            .returning()
        : [null];
      await recordAccountAudit(this.audit, tx, principal, {
        action: "billing.tenant_account.archived",
        tenantId,
        targetType: "tenant_bank_account",
        account: archived,
        before: { account: accountAuditSummary(target) },
        after: {
          account: accountAuditSummary(archived),
          replacement: activatedReplacement ? accountAuditSummary(activatedReplacement) : null,
        },
      });
      return archived;
    });
  }
}

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type AccountForAudit = Pick<
  OperatorAccount,
  "id" | "isDefault" | "label" | "settlementAccount" | "status"
>;

async function lockParty(tx: Transaction, party: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`billing-bank-account:${party}`}, 0))`,
  );
}

async function assertTenantExists(db: Pick<Db, "select">, tenantId: string): Promise<void> {
  const [tenant] = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, tenantId))
    .limit(1);
  if (!tenant) throw new NotFoundException({ code: "tenant_not_found" });
}

async function findActiveOperatorAccount(
  tx: Transaction,
  accountId: string,
): Promise<OperatorAccount> {
  const [account] = await tx
    .select()
    .from(schema.operatorBankAccounts)
    .where(
      and(
        eq(schema.operatorBankAccounts.id, accountId),
        eq(schema.operatorBankAccounts.status, "active"),
      ),
    )
    .limit(1);
  if (!account) throw new NotFoundException({ code: "billing_account_not_found" });
  return account;
}

async function findActiveTenantAccount(
  tx: Transaction,
  tenantId: string,
  accountId: string,
): Promise<TenantAccount> {
  const [account] = await tx
    .select()
    .from(schema.tenantBankAccounts)
    .where(
      and(
        eq(schema.tenantBankAccounts.tenantId, tenantId),
        eq(schema.tenantBankAccounts.id, accountId),
        eq(schema.tenantBankAccounts.status, "active"),
      ),
    )
    .limit(1);
  if (!account) throw new NotFoundException({ code: "billing_account_not_found" });
  return account;
}

async function resolveOperatorReplacement(
  tx: Transaction,
  target: OperatorAccount,
  input: BankAccountArchiveInput,
): Promise<OperatorAccount | null> {
  if (!target.isDefault) {
    if (input.replacementAccountId)
      throw new ConflictException({ code: "billing_account_replacement_not_allowed" });
    return null;
  }
  if (!input.replacementAccountId || input.replacementAccountId === target.id) {
    throw new ConflictException({ code: "billing_account_replacement_required" });
  }
  return findActiveOperatorAccount(tx, input.replacementAccountId);
}

async function resolveTenantReplacement(
  tx: Transaction,
  tenantId: string,
  target: TenantAccount,
  input: BankAccountArchiveInput,
): Promise<TenantAccount | null> {
  if (!target.isDefault) {
    if (input.replacementAccountId)
      throw new ConflictException({ code: "billing_account_replacement_not_allowed" });
    return null;
  }
  if (!input.replacementAccountId || input.replacementAccountId === target.id) {
    throw new ConflictException({ code: "billing_account_replacement_required" });
  }
  return findActiveTenantAccount(tx, tenantId, input.replacementAccountId);
}

async function setOperatorReplacementDefault(
  tx: Transaction,
  replacement: OperatorAccount,
): Promise<OperatorAccount> {
  const [updated] = await tx
    .update(schema.operatorBankAccounts)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(eq(schema.operatorBankAccounts.id, replacement.id))
    .returning();
  if (!updated) throw new ConflictException({ code: "billing_account_default_failed" });
  return updated;
}

function accountAuditSummary(account: AccountForAudit) {
  return {
    id: account.id,
    label: account.label,
    status: account.status,
    isDefault: account.isDefault,
    settlementAccountLast4: account.settlementAccount.slice(-4),
  };
}

async function recordAccountAudit(
  audit: PlatformAuditService,
  tx: Transaction,
  principal: PlatformPrincipal,
  event: {
    action: string;
    tenantId: string | null;
    targetType: string;
    account: AccountForAudit;
    before: unknown;
    after: unknown;
  },
): Promise<void> {
  await audit.record(tx, {
    actorPlatformUserId: principal.userId,
    actorRole: principal.role,
    action: event.action,
    outcome: "success",
    tenantId: event.tenantId,
    targetType: event.targetType,
    targetId: event.account.id,
    reason: null,
    before: event.before,
    after: event.after,
    requestId: null,
  });
}

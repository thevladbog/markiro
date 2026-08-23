import { ConflictException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type OperatorProfile = typeof schema.operatorBillingProfiles.$inferSelect;
type TenantProfile = typeof schema.tenantBillingProfiles.$inferSelect;
type OperatorAccount = typeof schema.operatorBankAccounts.$inferSelect;
type TenantAccount = typeof schema.tenantBankAccounts.$inferSelect;

export async function resolveCommercialBillingDetails(
  tx: DbTransaction,
  tenantId: string,
  selectedSellerBankAccountId: string | null,
) {
  const [seller] = await tx
    .select()
    .from(schema.operatorBillingProfiles)
    .where(eq(schema.operatorBillingProfiles.isCurrent, true))
    .for("update")
    .limit(1);
  if (!seller) throw new ConflictException({ code: "billing_seller_profile_required" });

  const [buyer] = await tx
    .select()
    .from(schema.tenantBillingProfiles)
    .where(
      and(
        eq(schema.tenantBillingProfiles.tenantId, tenantId),
        eq(schema.tenantBillingProfiles.isCurrent, true),
      ),
    )
    .for("update")
    .limit(1);
  if (!buyer) throw new ConflictException({ code: "billing_buyer_profile_required" });
  if (!seller.isConfirmed || !buyer.isConfirmed) {
    throw new ConflictException({ code: "billing_profile_unconfirmed" });
  }

  const [selectedSellerAccount] = selectedSellerBankAccountId
    ? await tx
        .select()
        .from(schema.operatorBankAccounts)
        .where(eq(schema.operatorBankAccounts.id, selectedSellerBankAccountId))
        .for("update")
        .limit(1)
    : await tx
        .select()
        .from(schema.operatorBankAccounts)
        .where(
          and(
            eq(schema.operatorBankAccounts.status, "active"),
            eq(schema.operatorBankAccounts.isDefault, true),
          ),
        )
        .for("update")
        .limit(1);
  if (selectedSellerBankAccountId && selectedSellerAccount?.status !== "active") {
    throw new ConflictException({ code: "billing_seller_account_inactive" });
  }
  if (!selectedSellerAccount) {
    throw new ConflictException({ code: "billing_seller_account_required" });
  }

  const [buyerAccount] = await tx
    .select()
    .from(schema.tenantBankAccounts)
    .where(
      and(
        eq(schema.tenantBankAccounts.tenantId, tenantId),
        eq(schema.tenantBankAccounts.status, "active"),
        eq(schema.tenantBankAccounts.isDefault, true),
      ),
    )
    .for("update")
    .limit(1);
  return {
    seller,
    buyer,
    sellerAccount: selectedSellerAccount,
    buyerAccount: buyerAccount ?? null,
  };
}

export function billingProfileSnapshot(profile: OperatorProfile | TenantProfile) {
  return {
    kind: profile.kind,
    fullName: profile.fullName,
    displayName: profile.displayName,
    inn: profile.inn,
    kpp: profile.kpp,
    ogrn: profile.ogrn,
    ogrnip: profile.ogrnip,
    legalAddressRaw: profile.legalAddressRaw,
    legalAddress: profile.legalAddress,
    actualSameAsLegal: profile.actualSameAsLegal,
    actualAddressRaw: profile.actualAddressRaw,
    actualAddress: profile.actualAddress,
    postalSameAsLegal: profile.postalSameAsLegal,
    postalAddressRaw: profile.postalAddressRaw,
    postalAddress: profile.postalAddress,
    contact: profile.contact,
    revision: profile.revision,
    confirmedAt: profile.confirmedAt,
  };
}

export function bankAccountSnapshot(account: OperatorAccount | TenantAccount) {
  return {
    id: account.id,
    label: account.label,
    settlementAccount: account.settlementAccount,
    bic: account.bic,
    bankName: account.bankName,
    correspondentAccount: account.correspondentAccount,
    currency: account.currency,
  };
}

export function bankAccountLast4(account: OperatorAccount | TenantAccount) {
  return account.settlementAccount.slice(-4);
}

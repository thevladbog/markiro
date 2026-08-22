import { Combobox, type ComboboxOption } from "@markiro/ui";
import type { OperatorBankAccount } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

export function SellerAccountPicker({
  accounts,
  value,
  loading,
  onValueChange,
}: {
  accounts: readonly OperatorBankAccount[];
  value?: string | null;
  loading: boolean;
  onValueChange: (accountId: string) => void;
}) {
  const { t } = useTranslation();
  const activeAccounts = accounts.filter((account) => account.status === "active");
  const options: ComboboxOption[] = activeAccounts.map((account) => ({
    value: account.id,
    label: `${account.label} · •••• ${account.settlementAccount.slice(-4)} · ${account.bankName}`,
    keywords: [account.label, account.settlementAccount.slice(-4), account.bankName, account.bic],
  }));

  return (
    <div className="seller-account-picker">
      <Combobox
        label={t("documents.sellerAccount")}
        options={options}
        {...(value ? { value } : {})}
        onValueChange={onValueChange}
        placeholder={t("documents.sellerAccountPlaceholder")}
        searchPlaceholder={t("documents.sellerAccountSearch")}
        emptyText={t("documents.sellerAccountEmpty")}
        loadingText={t("documents.sellerAccountLoading")}
        loading={loading}
      />
      {activeAccounts.length === 0 && !loading ? (
        <Link to="/settings/organization">{t("documents.sellerAccountSettings")}</Link>
      ) : null}
      <p>{t("documents.snapshotNotice")}</p>
    </div>
  );
}

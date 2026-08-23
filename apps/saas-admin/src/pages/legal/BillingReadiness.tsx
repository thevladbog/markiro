import { useTranslation } from "react-i18next";
import type { BankAccount, BillingProfile } from "@markiro/platform-contracts";

export function BillingReadiness({
  scope,
  profile,
  accounts,
}: {
  scope: "operator" | "tenant";
  profile: BillingProfile | null;
  accounts: BankAccount[];
}) {
  const { t } = useTranslation();
  const profileItem = {
    ready: profile?.isConfirmed === true,
    label: t("legal.readiness.profile"),
  };
  const legalAddressItem = {
    ready: Boolean(profile?.legalAddressRaw),
    label: t("legal.readiness.address"),
  };
  const defaultAccountItem = {
    ready: accounts.some((account) => account.status === "active" && account.isDefault),
    label: t(
      scope === "operator"
        ? "legal.readiness.defaultAccount"
        : "legal.readiness.optionalBuyerAccount",
    ),
  };
  const blockingItems = [
    profileItem,
    legalAddressItem,
    ...(scope === "operator" ? [defaultAccountItem] : []),
  ];
  const items = [...blockingItems, ...(scope === "tenant" ? [defaultAccountItem] : [])];
  const ready = blockingItems.every((item) => item.ready);

  return (
    <aside className="billing-readiness" aria-labelledby="billing-readiness-title">
      <div>
        <span className="panel-coordinate">BILLING / READINESS</span>
        <h2 id="billing-readiness-title">{t("legal.readiness.title")}</h2>
      </div>
      <strong data-ready={ready}>
        {t(ready ? "legal.readiness.ready" : "legal.readiness.missing")}
      </strong>
      <ul>
        {items.map((item) => (
          <li key={item.label} data-ready={item.ready}>
            <span aria-hidden="true">{item.ready ? "✓" : "○"}</span>
            {item.label}
          </li>
        ))}
      </ul>
      <p>{t("legal.readiness.nonBlocking")}</p>
    </aside>
  );
}

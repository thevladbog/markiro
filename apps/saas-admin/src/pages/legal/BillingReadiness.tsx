import { useTranslation } from "react-i18next";
import type { BankAccount, BillingProfile } from "@markiro/platform-contracts";

export function BillingReadiness({
  profile,
  accounts,
}: {
  profile: BillingProfile | null;
  accounts: BankAccount[];
}) {
  const { t } = useTranslation();
  const items = [
    { ready: profile !== null, label: t("legal.readiness.profile") },
    { ready: Boolean(profile?.legalAddressRaw), label: t("legal.readiness.address") },
    {
      ready: accounts.some((account) => account.status === "active" && account.isDefault),
      label: t("legal.readiness.defaultAccount"),
    },
  ];
  const ready = items.every((item) => item.ready);

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

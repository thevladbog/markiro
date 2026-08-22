import type { TFunction } from "i18next";
import { Link } from "react-router";

import { StatusChip } from "@markiro/ui";
import type { OperationsDecisionItem } from "@markiro/platform-contracts";

function decisionDestination(item: OperationsDecisionItem): string {
  if (item.kind === "overdue_invoice") return `/invoices/${item.invoiceId}`;
  if (item.kind === "subscription_ending") {
    return `/tenants/${item.tenantId}#tenant-subscription`;
  }
  if (item.party === "tenant") return `/tenants/${item.tenantId}?tab=legal`;
  return "/settings/organization";
}

function decisionTitle(item: OperationsDecisionItem, t: TFunction): string {
  if (item.kind === "overdue_invoice") {
    return t("overview.decisions.overdue", {
      number: item.invoiceNumber,
      tenant: item.tenantName,
    });
  }
  if (item.kind === "subscription_ending") {
    return t("overview.decisions.subscription", { tenant: item.tenantName });
  }
  if (item.party === "tenant") {
    return t("overview.decisions.tenantLegal", { tenant: item.tenantName });
  }
  return t("overview.decisions.operatorLegal");
}

export function DecisionQueue({ items, t }: { items: OperationsDecisionItem[]; t: TFunction }) {
  if (items.length === 0) {
    return <p className="overview-empty">{t("overview.decisions.empty")}</p>;
  }

  return (
    <ol className="decision-queue">
      {items.map((item) => (
        <li className="decision-queue__item" key={item.id}>
          <StatusChip
            status={
              item.severity === "critical" ? "error" : item.severity === "warning" ? "warn" : "info"
            }
            label={t(`overview.severity.${item.severity}`)}
          />
          <Link className="decision-queue__link" to={decisionDestination(item)}>
            {decisionTitle(item, t)}
          </Link>
          <span className="decision-queue__action">{t("overview.decisions.open")}</span>
        </li>
      ))}
    </ol>
  );
}

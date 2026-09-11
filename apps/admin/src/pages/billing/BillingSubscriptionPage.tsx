import { useTranslation } from "react-i18next";

import { Alert, Button, Card, EmptyState } from "@markiro/ui";

import { EntitlementSnapshotView } from "./EntitlementSnapshotView.js";
import { useBillingEntitlements } from "./entitlements-api.js";
import { useBillingSubscription } from "./api.js";
import { BillingStatusChip, SubscriptionSummary } from "./BillingSections.js";
import { BillingError, BillingLoading } from "./BillingOverviewPage.js";
import { formatBillingDate } from "./format.js";

/** Subscription detail is a read projection; it deliberately has no entitlement-changing control. */
export function BillingSubscriptionPage() {
  const { t, i18n } = useTranslation();
  const query = useBillingSubscription();
  const entitlements = useBillingEntitlements();

  if (query.isPending) return <BillingLoading />;
  if (query.isError || !query.data)
    return (
      <BillingError
        title={t("pages.billing.subscription.loadError")}
        onRetry={() => void query.refetch()}
      />
    );

  return (
    <section className="mk-billing-subscription" aria-label={t("pages.billing.tabs.subscription")}>
      {query.data.access === "unmanaged" ? (
        <EmptyState
          title={t("pages.billing.subscription.unmanagedTitle")}
          hint={t("pages.billing.subscription.unmanagedHint")}
        />
      ) : null}
      {entitlements.isPending ? (
        <BillingLoading />
      ) : entitlements.isError || !entitlements.data ? (
        <Alert tone="error">
          {t("entitlements.loadError")}
          <Button onClick={() => void entitlements.refetch()}>{t("entitlements.retry")}</Button>
        </Alert>
      ) : (
        <EntitlementSnapshotView snapshot={entitlements.data} />
      )}
      {query.data.subscription ? (
        <Card title={t("pages.billing.subscription.current")} titleAs="h2">
          <SubscriptionSummary subscription={query.data.subscription} access={query.data.access} />
        </Card>
      ) : null}

      {query.data.scheduledSubscription ? (
        <Card title={t("pages.billing.subscription.scheduled")} titleAs="h2">
          <SubscriptionSummary
            subscription={query.data.scheduledSubscription}
            access={query.data.access}
          />
        </Card>
      ) : null}

      {query.data.addons.length ? (
        <Card title={t("pages.billing.subscription.addons")} titleAs="h2">
          <ul className="mk-billing-item-list">
            {query.data.addons.map((addon) => (
              <li key={addon.id}>
                <div>
                  <strong>{addon.name}</strong>
                  <span>{t("pages.billing.subscription.quantity", { count: addon.quantity })}</span>
                </div>
                <BillingStatusChip kind="addon" value={addon.status} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {query.data.services.length ? (
        <Card title={t("pages.billing.subscription.services")} titleAs="h2">
          <ul className="mk-billing-item-list">
            {query.data.services.map((service) => (
              <li key={service.id}>
                <div>
                  <strong>{service.name}</strong>
                  <span>
                    {t("pages.billing.subscription.serviceMeta", {
                      quantity: service.quantity,
                      unit: service.unit,
                      date: formatBillingDate(service.orderedAt, i18n.language),
                    })}
                  </span>
                </div>
                <BillingStatusChip kind="service" value={service.status} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}

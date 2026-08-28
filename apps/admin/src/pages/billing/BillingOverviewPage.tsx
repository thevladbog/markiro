import { Link } from "react-router";
import { useTranslation } from "react-i18next";

import { Button, Card, EmptyState, Spinner } from "@markiro/ui";

import { useBillingOverview } from "./api.js";
import { BillingLimitCards, BillingStatusChip, SubscriptionSummary } from "./BillingSections.js";
import { formatBillingDate, formatMoney } from "./format.js";

/** Compact tenant billing control room: server projections are rendered without local entitlement logic. */
export function BillingOverviewPage() {
  const { t, i18n } = useTranslation();
  const query = useBillingOverview();

  if (query.isPending) return <BillingLoading />;
  if (query.isError || !query.data) {
    return (
      <BillingError
        title={t("pages.billing.overview.loadError")}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.data.access === "unmanaged" || !query.data.subscription) {
    return (
      <EmptyState
        title={t("pages.billing.overview.unmanagedTitle")}
        hint={t("pages.billing.overview.unmanagedHint")}
      />
    );
  }

  const { subscription, actionableOffer, recentOperations, activeRequest, attentionCount } =
    query.data;
  return (
    <section className="mk-billing-overview" aria-label={t("pages.billing.tabs.overview")}>
      <Card title={t("pages.billing.overview.currentSubscription")} titleAs="h2">
        <SubscriptionSummary subscription={subscription} access={query.data.access} />
      </Card>

      {actionableOffer ? (
        <Card title={t("pages.billing.overview.currentOffer")} titleAs="h2">
          <div className="mk-billing-offer-summary">
            <div>
              <strong>
                {actionableOffer.number ?? t("pages.billing.overview.offerWithoutNumber")}
              </strong>
              <span className="mk-billing-money">
                {formatMoney(actionableOffer.total, "RUB", i18n.language)}
              </span>
            </div>
            <Link className="mk-billing-action-link" to={`/billing/offers/${actionableOffer.id}`}>
              {t("pages.billing.overview.openOffer")}
            </Link>
          </div>
        </Card>
      ) : null}

      <Card title={t("pages.billing.overview.limits")} titleAs="h2">
        <BillingLimitCards limitPresentation={query.data.limitPresentation} />
      </Card>

      <div className="mk-billing-card-grid">
        <Card title={t("pages.billing.overview.recentOperations")} titleAs="h2">
          {recentOperations.length ? (
            <ul className="mk-billing-operations-list">
              {recentOperations.map((operation) => (
                <li key={operation.id}>
                  <div>
                    <strong>{operation.label}</strong>
                    <span>{formatBillingDate(operation.occurredAt, i18n.language)}</span>
                  </div>
                  <BillingStatusChip kind="operation" value={operation.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mk-billing-muted">{t("pages.billing.overview.noOperations")}</p>
          )}
        </Card>
        <Card title={t("pages.billing.overview.activeRequest")} titleAs="h2">
          {activeRequest ? (
            <div className="mk-billing-request-summary">
              <div>
                <strong>{activeRequest.number}</strong>
                <BillingStatusChip kind="request" value={activeRequest.status} />
              </div>
              <Link className="mk-billing-inline-link" to={`/billing/requests/${activeRequest.id}`}>
                {t("pages.billing.overview.openRequest")}
              </Link>
            </div>
          ) : (
            <p className="mk-billing-muted">{t("pages.billing.overview.noActiveRequest")}</p>
          )}
          {attentionCount > 0 ? (
            <p className="mk-billing-attention">
              {t("pages.billing.overview.attention", { count: attentionCount })}
            </p>
          ) : null}
        </Card>
      </div>
    </section>
  );
}

export function BillingLoading() {
  const { t } = useTranslation();
  return (
    <div className="mk-billing-state">
      <Spinner label={t("pages.billing.overview.loading")} />
    </div>
  );
}

export function BillingError({ title, onRetry }: { title: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      title={title}
      action={
        <Button variant="secondary" onClick={onRetry}>
          {t("pages.billing.retry")}
        </Button>
      }
    />
  );
}

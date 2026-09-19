import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Alert, Button, EmptyState, Spinner, StatusChip } from "@markiro/ui";

import { useServicePeriods } from "./api.js";
import { formatBillingDate } from "./format.js";

export function ServicePeriodsPage() {
  const { t, i18n } = useTranslation();
  const query = useServicePeriods({ limit: 50 });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  if (query.isPending) return <Spinner label={t("pages.billing.servicePeriods.loading")} />;
  if (query.isError)
    return (
      <Alert tone="error">
        {t("pages.billing.servicePeriods.loadError")}
        <Button onClick={() => void query.refetch()}>{t("pages.billing.retry")}</Button>
      </Alert>
    );

  const periods = query.data.pages.flatMap((page) => page.items);
  if (!periods.length)
    return (
      <EmptyState
        title={t("pages.billing.servicePeriods.emptyTitle")}
        hint={t("pages.billing.servicePeriods.emptyHint")}
      />
    );

  return (
    <section
      className="mk-billing-service-periods"
      aria-labelledby="billing-service-periods-heading"
    >
      <div className="mk-billing-section-intro">
        <div>
          <h2 className="mk-billing-section-heading" id="billing-service-periods-heading">
            {t("pages.billing.servicePeriods.heading")}
          </h2>
          <p>{t("pages.billing.servicePeriods.description")}</p>
        </div>
      </div>
      <div className="mk-billing-service-period-grid">
        {periods.map((period) => {
          const name = i18n.language.startsWith("ru") ? period.nameRu : period.nameEn;
          const exhausted = period.state === "active" && period.balance.remaining === 0;
          return (
            <article className="mk-billing-service-period-card" aria-label={name} key={period.id}>
              <div className="mk-billing-service-period-card__header">
                <div>
                  <h3>{name}</h3>
                  <p>
                    {formatBillingDate(period.startsAt, i18n.language)} —{" "}
                    {formatBillingDate(period.endsAt, i18n.language)}
                  </p>
                </div>
                <StatusChip
                  phase={period.state === "active" && !exhausted ? "active" : "retired"}
                  label={t(
                    exhausted
                      ? "pages.billing.servicePeriods.state.exhausted"
                      : `pages.billing.servicePeriods.state.${period.state}`,
                  )}
                />
              </div>
              <dl className="mk-billing-service-balance">
                <div>
                  <dt>{t("pages.billing.servicePeriods.balance.includedLabel")}</dt>
                  <dd>
                    {t("pages.billing.servicePeriods.balance.included", {
                      count: period.balance.included,
                    })}
                  </dd>
                </div>
                <div>
                  <dt>{t("pages.billing.servicePeriods.balance.consumedLabel")}</dt>
                  <dd>
                    {t("pages.billing.servicePeriods.balance.consumed", {
                      count: period.balance.consumed,
                    })}
                  </dd>
                </div>
                <div>
                  <dt>{t("pages.billing.servicePeriods.balance.remainingLabel")}</dt>
                  <dd>
                    {t("pages.billing.servicePeriods.balance.remaining", {
                      count: period.balance.remaining,
                    })}
                  </dd>
                </div>
              </dl>
              {period.balance.externallyApproved > 0 ? (
                <p className="mk-billing-service-period-card__approved">
                  {t("pages.billing.servicePeriods.balance.approved", {
                    count: period.balance.externallyApproved,
                  })}
                </p>
              ) : null}
              <Link className="mk-billing-action-link" to={`/billing/services/${period.id}`}>
                {t("pages.billing.servicePeriods.open")}
              </Link>
            </article>
          );
        })}
      </div>
    </section>
  );
}

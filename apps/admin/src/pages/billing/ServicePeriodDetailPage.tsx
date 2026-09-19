import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { Alert, Badge, Button, Card, Spinner, StatusChip } from "@markiro/ui";
import type { BadgeTone } from "@markiro/ui";

import type { TenantServicePeriodDetail } from "./api.js";
import { useServicePeriod } from "./api.js";
import { formatBillingDate, formatBillingDateTime, servicePeriodPhase } from "./format.js";

type Entry = TenantServicePeriodDetail["entries"][number];

// Minor 1 (final review): `classification` is a two-value category axis --
// service work billed from the package vs. a product-defect correction that
// is not -- not a lifecycle. Neither is "better" than the other, so it
// belongs on `Badge` with equal-loudness category tones, not `StatusChip`
// with `attention`/`none`, which used to mark `product_defect` as needing
// intervention and `customer_service` (the ordinary case) as having no
// value at all. Order matches the actual union
// (`serviceUsageClassificationSchema`, `packages/platform-contracts/src/
// service-periods.ts`): `customer_service` first, `product_defect` second.
export const ENTRY_CLASSIFICATION_TO_TONE: Record<Entry["classification"], BadgeTone> = {
  customer_service: "violet",
  product_defect: "teal",
};

function MinuteDelta({ value }: { value: number }) {
  const { t } = useTranslation();
  return (
    <span>
      {t("pages.billing.servicePeriods.minuteDelta", {
        value: value > 0 ? `+${value}` : value,
      })}
    </span>
  );
}

function Corrections({ entries, originalId }: { entries: Entry[]; originalId: string }) {
  const { t, i18n } = useTranslation();
  const corrections = entries.filter(
    (entry) => entry.kind === "correction" && entry.originalEntryId === originalId,
  );
  if (!corrections.length) return null;
  return (
    <ul
      className="mk-billing-service-corrections"
      aria-label={t("pages.billing.servicePeriods.detail.corrections")}
    >
      {corrections.map((entry) => (
        <li key={entry.id}>
          <strong>{t("pages.billing.servicePeriods.detail.correction")}</strong>
          <p>{entry.description}</p>
          <div className="mk-billing-service-entry__minutes">
            <span>{t("pages.billing.servicePeriods.detail.actual")}: </span>
            <MinuteDelta value={entry.actualMinutesDelta} />
            <span>{t("pages.billing.servicePeriods.detail.allowance")}: </span>
            <MinuteDelta value={entry.allowanceMinutesDelta} />
          </div>
          <span className="mk-billing-muted">
            {t("pages.billing.servicePeriods.detail.posted", {
              date: formatBillingDateTime(entry.postedAt, i18n.language),
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ServicePeriodDetailPage() {
  const { t, i18n } = useTranslation();
  const { periodId = "" } = useParams();
  const query = useServicePeriod(periodId);

  if (query.isPending) return <Spinner label={t("pages.billing.servicePeriods.loading")} />;
  if (query.isError || !query.data)
    return (
      <Alert tone="error">
        {t("pages.billing.servicePeriods.detail.loadError")}
        <Button onClick={() => void query.refetch()}>{t("pages.billing.retry")}</Button>
      </Alert>
    );

  const period = query.data;
  const name = i18n.language.startsWith("ru") ? period.nameRu : period.nameEn;
  const exhausted = period.state === "active" && period.balance.remaining === 0;
  const rootEntries = period.entries.filter((entry) => entry.kind === "usage");
  return (
    <section
      className="mk-billing-service-period-detail"
      aria-labelledby="billing-service-period-heading"
    >
      <div className="mk-billing-section-intro">
        <div>
          <h2 className="mk-billing-section-heading" id="billing-service-period-heading">
            {name}
          </h2>
          <p>
            {formatBillingDate(period.startsAt, i18n.language)} —{" "}
            {formatBillingDate(period.endsAt, i18n.language)}
          </p>
        </div>
        <Link className="mk-billing-inline-link" to="/billing/services">
          {t("pages.billing.servicePeriods.detail.back")}
        </Link>
      </div>

      <Card title={t("pages.billing.servicePeriods.detail.balanceTitle")} titleAs="h3">
        <div className="mk-billing-service-detail-summary">
          <StatusChip
            phase={servicePeriodPhase(period.state, exhausted)}
            label={t(
              exhausted
                ? "pages.billing.servicePeriods.state.exhausted"
                : `pages.billing.servicePeriods.state.${period.state}`,
            )}
          />
          <dl className="mk-billing-service-balance">
            <div>
              <dt>{t("pages.billing.servicePeriods.balance.includedLabel")}</dt>
              <dd>
                {t("pages.billing.servicePeriods.minutes", { count: period.balance.included })}
              </dd>
            </div>
            <div>
              <dt>{t("pages.billing.servicePeriods.balance.approvedLabel")}</dt>
              <dd>
                {t("pages.billing.servicePeriods.minutes", {
                  count: period.balance.externallyApproved,
                })}
              </dd>
            </div>
            <div>
              <dt>{t("pages.billing.servicePeriods.balance.consumedLabel")}</dt>
              <dd>
                {t("pages.billing.servicePeriods.minutes", { count: period.balance.consumed })}
              </dd>
            </div>
            <div>
              <dt>{t("pages.billing.servicePeriods.balance.remainingLabel")}</dt>
              <dd>
                {t("pages.billing.servicePeriods.minutes", { count: period.balance.remaining })}
              </dd>
            </div>
          </dl>
        </div>
      </Card>

      <Card title={t("pages.billing.servicePeriods.detail.history")} titleAs="h3">
        {rootEntries.length ? (
          <ol
            className="mk-billing-service-ledger"
            aria-label={t("pages.billing.servicePeriods.detail.history")}
          >
            {rootEntries.map((entry) => (
              <li aria-label={entry.workReference} key={entry.id}>
                <div className="mk-billing-service-entry__header">
                  <strong>{entry.workReference}</strong>
                  <Badge tone={ENTRY_CLASSIFICATION_TO_TONE[entry.classification]}>
                    {t(`pages.billing.servicePeriods.classification.${entry.classification}`)}
                  </Badge>
                </div>
                <p>{entry.description}</p>
                <div className="mk-billing-service-entry__minutes">
                  <span>
                    {t("pages.billing.servicePeriods.detail.actual")}:{" "}
                    {t("pages.billing.servicePeriods.minutes", {
                      count: entry.actualMinutesDelta,
                    })}
                  </span>
                  <span>
                    {t("pages.billing.servicePeriods.detail.allowance")}:{" "}
                    {t("pages.billing.servicePeriods.minutes", {
                      count: entry.allowanceMinutesDelta,
                    })}
                  </span>
                </div>
                <div className="mk-billing-service-entry__dates">
                  <span>
                    {t("pages.billing.servicePeriods.detail.performed", {
                      date: formatBillingDateTime(entry.performedAt, i18n.language),
                    })}
                  </span>
                  <span>
                    {t("pages.billing.servicePeriods.detail.posted", {
                      date: formatBillingDateTime(entry.postedAt, i18n.language),
                    })}
                  </span>
                </div>
                <Corrections entries={period.entries} originalId={entry.id} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="mk-billing-muted">{t("pages.billing.servicePeriods.detail.empty")}</p>
        )}
      </Card>
    </section>
  );
}

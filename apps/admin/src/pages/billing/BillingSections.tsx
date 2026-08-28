import { Link } from "react-router";
import { useTranslation } from "react-i18next";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { StatusChip } from "@markiro/ui";
import type { StatusChipStatus } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import type {
  BillingLimitKey,
  TenantBillingLimitPresentation,
  TenantBillingSubscription,
  TenantSubscriptionBillingDto,
} from "./api.js";
import { formatBillingDate, formatMoney } from "./format.js";

export const BILLING_LIMIT_KEYS: BillingLimitKey[] = [
  "lines",
  "stations",
  "kiosks",
  "cabinetUsers",
];

function chipStatusFor(value: string): StatusChipStatus {
  if (["active", "trial", "normal", "paid", "completed", "confirmed"].includes(value)) return "ok";
  if (
    [
      "approaching",
      "reached",
      "exceeded",
      "expired",
      "overdue",
      "cancelled",
      "revoked",
      "clarification_required",
      "awaiting_payment",
    ].includes(value)
  )
    return "warn";
  if (["superseded", "draft"].includes(value)) return "neutral";
  return "info";
}

export function BillingStatusChip({
  kind,
  value,
}: {
  kind: "subscription" | "access" | "limit" | "addon" | "service" | "operation" | "request";
  value: string;
}) {
  const { t } = useTranslation();
  return (
    <StatusChip status={chipStatusFor(value)} label={t(`pages.billing.status.${kind}.${value}`)} />
  );
}

export function SubscriptionSummary({
  subscription,
  access,
}: {
  subscription: TenantBillingSubscription;
  access: TenantSubscriptionBillingDto["access"];
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="mk-billing-subscription-summary">
      <div>
        <strong>{subscription.planName ?? t("pages.billing.value.notAvailable")}</strong>
        <dl className="mk-billing-definition-list">
          <div>
            <dt>{t("pages.billing.subscription.period")}</dt>
            <dd>
              {subscription.billingPeriod
                ? t(`pages.billing.subscription.periods.${subscription.billingPeriod}`)
                : t("pages.billing.value.notAvailable")}
            </dd>
          </div>
          <div>
            <dt>{t("pages.billing.subscription.startsAt")}</dt>
            <dd>{formatBillingDate(subscription.startsAt, i18n.language)}</dd>
          </div>
          <div>
            <dt>{t("pages.billing.subscription.endsAt")}</dt>
            <dd>{formatBillingDate(subscription.endsAt, i18n.language)}</dd>
          </div>
          <div>
            <dt>{t("pages.billing.subscription.price")}</dt>
            <dd className="mk-billing-money">
              {formatMoney(subscription.price, "RUB", i18n.language)}
            </dd>
          </div>
        </dl>
      </div>
      <div className="mk-billing-chip-stack">
        <BillingStatusChip kind="subscription" value={subscription.status} />
        <BillingStatusChip kind="access" value={access} />
      </div>
    </div>
  );
}

function capacityRequestPath(key: BillingLimitKey): string {
  return `/billing/requests/new?${new URLSearchParams({ type: "capacity_change", contextType: "limit", contextId: key }).toString()}`;
}

export function BillingLimitCards({
  limitPresentation,
}: {
  limitPresentation: TenantSubscriptionBillingDto["limitPresentation"];
}) {
  const canCreateRequest = useCan(CABINET_CAPABILITY.BILLING_REQUEST);
  return (
    <ul className="mk-billing-limit-list">
      {BILLING_LIMIT_KEYS.map((key) => (
        <BillingLimitCard
          key={key}
          limitKey={key}
          presentation={limitPresentation[key]}
          canCreateRequest={canCreateRequest}
        />
      ))}
    </ul>
  );
}

function BillingLimitCard({
  limitKey,
  presentation,
  canCreateRequest,
}: {
  limitKey: BillingLimitKey;
  presentation: TenantBillingLimitPresentation;
  canCreateRequest: boolean;
}) {
  const { t } = useTranslation();
  const assigned = presentation.assigned;
  const progressValue = assigned && assigned > 0 ? Math.min(presentation.used, assigned) : null;
  return (
    <li className="mk-billing-limit-card">
      <div className="mk-billing-limit-card__header">
        <strong>{t(`pages.billing.limits.${limitKey}`)}</strong>
        <BillingStatusChip kind="limit" value={presentation.state} />
      </div>
      <span className="mk-billing-limit-card__value">
        {assigned === null
          ? t("pages.billing.limits.unlimited", { used: presentation.used })
          : t("pages.billing.limits.usedOf", { used: presentation.used, assigned })}
      </span>
      {progressValue !== null ? (
        <progress
          aria-label={t("pages.billing.limits.progress", {
            name: t(`pages.billing.limits.${limitKey}`),
            used: presentation.used,
            assigned: assigned ?? 0,
          })}
          value={progressValue}
          max={assigned ?? 1}
        />
      ) : null}
      {canCreateRequest && ["approaching", "reached", "exceeded"].includes(presentation.state) ? (
        <Link className="mk-billing-inline-link" to={capacityRequestPath(limitKey)}>
          {t("pages.billing.limits.increase", {
            name: t(`pages.billing.limits.requestNames.${limitKey}`),
          })}
        </Link>
      ) : null}
    </li>
  );
}

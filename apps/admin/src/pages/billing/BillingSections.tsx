import { Link } from "react-router";
import { useTranslation } from "react-i18next";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { StatusChip } from "@markiro/ui";
import type { TagPhase } from "@markiro/ui";

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

/**
 * Перечень значений взят из `apps/admin/src/i18n/ru.json`, ветка
 * `pages.billing.status`, и покрывает все семь видов целиком. `cancelled`,
 * `revoked` и `expired` — вывод из оборота (`retired`), а не тревога
 * (`warn`): отмена и истечение не требуют вмешательства. `ordered` и
 * `in_progress` расходятся на ожидание (`planned`) и выполнение (`running`),
 * а не делят один статус. Неизвестное значение — `none`, а не `info`.
 */
function chipPhaseFor(value: string): TagPhase {
  if (["active", "trial", "normal", "managed", "published"].includes(value)) return "active";
  if (["paid", "completed", "confirmed"].includes(value)) return "done";
  if (["pending_activation", "scheduled", "new", "ordered"].includes(value)) return "planned";
  if (["issued", "in_progress", "under_review", "offer_prepared"].includes(value)) return "running";
  if (
    [
      "approaching",
      "reached",
      "exceeded",
      "overdue",
      "awaiting_payment",
      "clarification_required",
      "partially_paid",
      "read_only",
      "unmanaged",
    ].includes(value)
  )
    return "attention";
  if (["cancelled", "revoked", "superseded", "expired"].includes(value)) return "retired";
  if (value === "draft") return "draft";
  return "none";
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
    <StatusChip phase={chipPhaseFor(value)} label={t(`pages.billing.status.${kind}.${value}`)} />
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

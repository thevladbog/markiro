import { useTranslation } from "react-i18next";

import { Card, PageHeader } from "@markiro/ui";

import { useAccess } from "../../access/context.js";

const QUOTAS = ["lines", "stations", "kiosks", "cabinetUsers"] as const;

export function SubscriptionPage() {
  const { t, i18n } = useTranslation();
  const access = useAccess();
  const subscription = access.subscription;
  const planName = subscription?.plan
    ? i18n.language.startsWith("en")
      ? subscription.plan.nameEn
      : subscription.plan.nameRu
    : t("subscription.unmanaged");
  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("subscription.page.title")} />
      <Card title={planName}>
        <p role="status">{t(`subscription.status.${subscription?.status ?? "unmanaged"}`)}</p>
        <div style={{ display: "grid", gap: 14 }}>
          {QUOTAS.map((key) => {
            const used = access.usage?.[key] ?? 0;
            const limit = access.quotas?.[key] ?? null;
            const percent =
              limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
            return (
              <div key={key}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>{t(`subscription.quota.${key}`)}</span>
                  <span>{limit === null ? t("subscription.unlimited") : `${used} / ${limit}`}</span>
                </div>
                <div
                  aria-label={t(`subscription.quota.${key}`)}
                  style={{ height: 8, background: "var(--surface-2)", borderRadius: 4 }}
                >
                  <div
                    style={{
                      width: `${percent}%`,
                      height: "100%",
                      background: percent >= 100 ? "var(--danger)" : "var(--accent)",
                      borderRadius: 4,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      {access.scheduled ? (
        <Card title={t("subscription.page.scheduled")}>{access.scheduled.plan?.nameRu}</Card>
      ) : null}
      {subscription?.addons.length ? (
        <Card title={t("subscription.page.addons")}>
          <ul>
            {subscription.addons.map((addon) => (
              <li key={addon.catalogVersionId}>
                {addon.catalogVersionId} × {addon.quantity}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

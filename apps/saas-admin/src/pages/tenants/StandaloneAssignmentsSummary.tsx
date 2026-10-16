import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Alert } from "@markiro/ui";

import { getTenant } from "./api.js";
import { useStandaloneDate } from "./standalone-format.js";

/**
 * The rights of a tenant without a cabinet are its direct plan and add-on
 * assignments (spec 2026-10-16 §10). The summary names them and links back to
 * the «Прямое назначение» section, where they are changed.
 */
export function StandaloneAssignmentsSummary({ tenantId }: { tenantId: string }) {
  const { t, i18n } = useTranslation();
  const formatDate = useStandaloneDate();
  const english = i18n.resolvedLanguage?.startsWith("en") ?? false;
  const tenant = useQuery({
    queryKey: ["platform", "tenants", tenantId],
    queryFn: () => getTenant(tenantId),
  });
  const detail = tenant.data;
  const term = (endsAt: string | null) =>
    endsAt
      ? t("tenants.detail.standalone.assignments.until", { date: formatDate(endsAt) })
      : t("tenants.detail.standalone.assignments.open");
  const rows = detail
    ? [
        ...(detail.currentSubscription
          ? [
              {
                key: detail.currentSubscription.id,
                text: t("tenants.detail.standalone.assignments.plan", {
                  name: english
                    ? detail.currentSubscription.planVersion.nameEn
                    : detail.currentSubscription.planVersion.nameRu,
                  version: detail.currentSubscription.planVersion.version,
                  term: term(detail.currentSubscription.endsAt),
                }),
              },
            ]
          : []),
        ...detail.activeAddons.map((addon) => ({
          key: addon.id,
          text: t("tenants.detail.standalone.assignments.addon", {
            name: english ? addon.addonVersion.nameEn : addon.addonVersion.nameRu,
            version: addon.addonVersion.version,
            quantity: addon.quantity,
            term: term(addon.endsAt),
          }),
        })),
      ]
    : [];
  const changeLink = (
    <Link to={`/tenants/${tenantId}#tenant-subscription`}>
      {t("tenants.detail.standalone.assignments.change")}
    </Link>
  );
  return (
    <section
      aria-label={t("tenants.detail.standalone.assignments.title")}
      className="standalone-assignments"
    >
      <h3>{t("tenants.detail.standalone.assignments.title")}</h3>
      {tenant.isError ? (
        <Alert tone="error" role="alert">
          {t("tenants.detail.standalone.assignments.loadError")}
        </Alert>
      ) : null}
      {detail && rows.length === 0 ? (
        <Alert tone="warn" role="alert" action={changeLink}>
          {t("tenants.detail.standalone.assignments.empty")}
        </Alert>
      ) : null}
      {rows.length > 0 ? (
        <>
          <ul>
            {rows.map((row) => (
              <li key={row.key}>{row.text}</li>
            ))}
          </ul>
          {changeLink}
        </>
      ) : null}
      {tenant.isError ? changeLink : null}
    </section>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, StatusChip, Table, type TableColumn } from "@markiro/ui";
import type { StandaloneSite } from "@markiro/platform-contracts";

import { getStandaloneSites } from "./standalone-api.js";
import { licensePhase, standaloneSitesKey, useStandaloneDate } from "./standalone-format.js";
import { StandaloneIssuanceHistory } from "./StandaloneIssuanceHistory.js";

/** «Автоном: площадки и офлайн-лицензии» (spec 2026-10-13 §6.2). */
export function StandaloneSitesPanel({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const formatDate = useStandaloneDate();
  const query = useQuery({
    queryKey: standaloneSitesKey(tenantId),
    queryFn: () => getStandaloneSites(tenantId),
  });
  const [historyFor, setHistoryFor] = useState<StandaloneSite | null>(null);
  const now = new Date();
  const columns: TableColumn<StandaloneSite>[] = [
    {
      key: "name",
      title: t("tenants.detail.standalone.columns.name"),
      render: (site) => site.name,
    },
    {
      key: "host",
      title: t("tenants.detail.standalone.columns.host"),
      mono: true,
      render: (site) => site.hostId.slice(0, 8),
    },
    {
      key: "inn",
      title: t("tenants.detail.standalone.columns.inn"),
      mono: true,
      render: (site) => site.requestInn ?? t("tenants.detail.standalone.noValue"),
    },
    {
      key: "license",
      title: t("tenants.detail.standalone.columns.license"),
      wrap: true,
      render: (site) => {
        const phase = licensePhase(site, now);
        return (
          <span className="standalone-license-cell">
            <StatusChip phase={phase} label={t(`tenants.detail.standalone.phase.${phase}`)} />{" "}
            {site.latestIssuance ? (
              <span>
                {t("tenants.detail.standalone.licenseLine", {
                  sequence: site.latestIssuance.sequence,
                  validUntil: formatDate(site.latestIssuance.validUntil),
                })}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "actions",
      title: t("tenants.detail.standalone.columns.actions"),
      render: (site) => (
        <span className="standalone-site-actions">
          <Button variant="secondary" size="compact" onClick={() => setHistoryFor(site)}>
            {t("tenants.detail.standalone.history.open")}
          </Button>
        </span>
      ),
    },
  ];
  return (
    <Card
      title={t("tenants.detail.standalone.title")}
      titleAs="h3"
      className="standalone-sites-panel"
    >
      <p>{t("tenants.detail.standalone.description")}</p>
      {query.isPending ? (
        <p role="status">{t("tenants.detail.standalone.loading")}</p>
      ) : !query.data ? (
        <Alert
          tone="error"
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {t("tenants.detail.standalone.retry")}
            </Button>
          }
        >
          {t("tenants.detail.standalone.loadError")}
        </Alert>
      ) : (
        <>
          {!query.data.signingConfigured ? (
            <Alert tone="info">{t("tenants.detail.standalone.signingUnavailable")}</Alert>
          ) : null}
          {query.data.issuanceSource === "offline" ? (
            <Alert tone="info">{t("tenants.detail.standalone.offlineTenant")}</Alert>
          ) : null}
          {query.data.sites
            .filter((site) => licensePhase(site, now) === "attention")
            .map((site) => (
              <Alert key={`renewal-${site.id}`} tone="warn">
                {t("tenants.detail.standalone.renewalDue", {
                  name: site.name,
                  validUntil: site.latestIssuance ? formatDate(site.latestIssuance.validUntil) : "",
                })}
              </Alert>
            ))}
          <Table
            columns={columns}
            rows={query.data.sites}
            getRowKey={(site) => site.id}
            empty={t("tenants.detail.standalone.empty")}
            scrollLabel={t("tenants.detail.standalone.scrollLabel")}
          />
        </>
      )}
      {historyFor ? (
        <StandaloneIssuanceHistory
          tenantId={tenantId}
          site={historyFor}
          onClose={() => setHistoryFor(null)}
        />
      ) : null}
    </Card>
  );
}

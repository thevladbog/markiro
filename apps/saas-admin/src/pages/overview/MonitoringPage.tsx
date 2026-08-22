import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { SectionHeader } from "@markiro/ui";

import { PanelState } from "../../components/PanelState.js";
import { HealthSummary } from "./HealthSummary.js";
import { getPlatformMonitoring } from "./api.js";

export function MonitoringPage() {
  const { t } = useTranslation();
  const monitoring = useQuery({
    queryKey: ["platform", "operations", "monitoring"],
    queryFn: getPlatformMonitoring,
  });
  return (
    <section className="overview-page">
      <SectionHeader
        eyebrow="PLATFORM / DIAGNOSTICS"
        title={t("monitoring.title")}
        description={t("monitoring.description")}
      />
      <section
        className="overview-panel overview-panel--health"
        aria-labelledby="monitoring-health-title"
      >
        <header className="overview-panel__header">
          <div>
            <p>{t("overview.health.eyebrow")}</p>
            <h2 id="monitoring-health-title">{t("overview.health.title")}</h2>
          </div>
        </header>
        <PanelState
          loading={monitoring.isPending}
          empty={false}
          error={monitoring.error}
          onRetry={() => void monitoring.refetch()}
          loadingText={t("overview.health.loading")}
        >
          {monitoring.data ? <HealthSummary health={monitoring.data} t={t} /> : null}
        </PanelState>
      </section>
    </section>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { MetricStrip, SectionHeader, StatusChip } from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { PanelState } from "../../components/PanelState.js";
import { DecisionQueue } from "./DecisionQueue.js";
import { HealthSummary } from "./HealthSummary.js";
import { getOperationsOverview, getPlatformMonitoring } from "./api.js";

export function OverviewPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const canReadDiagnostics = principal.capabilities.includes("diagnostics.read");
  const overview = useQuery({
    queryKey: ["platform", "operations", "overview"],
    queryFn: getOperationsOverview,
  });
  const monitoring = useQuery({
    queryKey: ["platform", "operations", "monitoring"],
    queryFn: getPlatformMonitoring,
    enabled: canReadDiagnostics,
  });

  return (
    <section className="overview-page">
      <SectionHeader
        eyebrow="PLATFORM / OPERATIONS"
        title={t("overview.title")}
        description={t("overview.description")}
      />

      <PanelState
        loading={overview.isPending}
        empty={false}
        error={overview.error}
        onRetry={() => void overview.refetch()}
        loadingText={t("overview.loading")}
      >
        {overview.data ? (
          <>
            <MetricStrip
              label={t("overview.metrics.label")}
              items={[
                {
                  id: "active",
                  label: t("overview.metrics.active"),
                  value: overview.data.activeTenants,
                  hint: t("overview.metrics.activeHint"),
                  tone: "positive",
                },
                {
                  id: "restriction",
                  label: t("overview.metrics.restriction"),
                  value: overview.data.tenantsApproachingRestriction,
                  hint: t("overview.metrics.restrictionHint", {
                    days: overview.data.definitions.tenantsApproachingRestriction.windowDays,
                  }),
                  tone: overview.data.tenantsApproachingRestriction > 0 ? "warning" : "neutral",
                },
                ...(overview.data.overdueInvoices === null
                  ? []
                  : [
                      {
                        id: "overdue",
                        label: t("overview.metrics.overdue"),
                        value: overview.data.overdueInvoices,
                        hint: t("overview.metrics.overdueHint"),
                        tone:
                          overview.data.overdueInvoices > 0
                            ? ("critical" as const)
                            : ("neutral" as const),
                      },
                    ]),
              ]}
            />

            <div className="overview-grid">
              <section
                className="overview-panel overview-panel--decisions"
                aria-labelledby="decision-title"
              >
                <header className="overview-panel__header">
                  <div>
                    <p>{t("overview.decisions.eyebrow")}</p>
                    <h2 id="decision-title">{t("overview.decisions.title")}</h2>
                  </div>
                  <span className="overview-count">{overview.data.decisionQueue.length}</span>
                </header>
                <DecisionQueue items={overview.data.decisionQueue} t={t} />
              </section>

              <section className="overview-panel" aria-labelledby="activity-title">
                <header className="overview-panel__header">
                  <div>
                    <p>{t("overview.activity.eyebrow")}</p>
                    <h2 id="activity-title">{t("overview.activity.title")}</h2>
                  </div>
                </header>
                {overview.data.recentActivity.length === 0 ? (
                  <p className="overview-empty">{t("overview.activity.empty")}</p>
                ) : (
                  <ol className="activity-list">
                    {overview.data.recentActivity.map((event) => (
                      <li key={event.id}>
                        <StatusChip
                          status={
                            event.outcome === "success"
                              ? "ok"
                              : event.outcome === "denied"
                                ? "warn"
                                : "error"
                          }
                          label={t(`audit.outcomes.${event.outcome}`)}
                        />
                        <span className="activity-list__action">{event.action}</span>
                        <time dateTime={event.createdAt}>
                          {new Date(event.createdAt).toLocaleString()}
                        </time>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </>
        ) : null}
      </PanelState>

      {canReadDiagnostics ? (
        <section className="overview-panel overview-panel--health" aria-labelledby="health-title">
          <header className="overview-panel__header">
            <div>
              <p>{t("overview.health.eyebrow")}</p>
              <h2 id="health-title">{t("overview.health.title")}</h2>
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
      ) : null}
    </section>
  );
}

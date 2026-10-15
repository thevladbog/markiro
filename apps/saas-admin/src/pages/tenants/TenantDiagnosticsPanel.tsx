import { useTranslation } from "react-i18next";

import { DiagnosticsHistory } from "./DiagnosticsHistory.js";
import { DiagnosticsIngestForm } from "./DiagnosticsIngestForm.js";
import { DiagnosticsOverview } from "./DiagnosticsOverview.js";
import { DiagnosticsStatistics } from "./DiagnosticsStatistics.js";

/** The «Диагностика» tab of a tenant: what its «Markiro Автоном» sites reported (plan ДИАГ У1). */
export function TenantDiagnosticsPanel({
  tenantId,
  canWrite,
}: {
  tenantId: string;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className="tenant-diagnostics" aria-labelledby="tenant-diagnostics-title">
      <header className="tenant-diagnostics__header">
        <h2 id="tenant-diagnostics-title">{t("tenants.detail.diagnostics.title")}</h2>
        <p>{t("tenants.detail.diagnostics.description")}</p>
      </header>
      <DiagnosticsOverview tenantId={tenantId} canWrite={canWrite} />
      {canWrite ? <DiagnosticsIngestForm tenantId={tenantId} /> : null}
      <DiagnosticsStatistics tenantId={tenantId} />
      <DiagnosticsHistory tenantId={tenantId} />
    </section>
  );
}

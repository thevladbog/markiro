import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Alert, PageHeader, Spinner, StatusChip, Table } from "@markiro/ui";
import { listAuditEvents, type AuditEvent } from "./api.js";

export function AuditPage() {
  const { t } = useTranslation();
  const audit = useQuery({
    queryKey: ["platform", "audit"],
    queryFn: () => listAuditEvents({ limit: 100 }),
  });
  if (audit.isPending) return <Spinner label={t("audit.loading")} />;
  if (audit.error) return <Alert tone="error">{t("audit.loadError")}</Alert>;
  return (
    <section className="catalog-page">
      <PageHeader title={t("audit.title")} />
      <Table
        columns={[
          {
            key: "createdAt",
            title: t("audit.time"),
            mono: true,
            render: (event: AuditEvent) => new Date(event.createdAt).toLocaleString(),
          },
          { key: "action", title: t("audit.action"), mono: true },
          {
            key: "tenantId",
            title: t("audit.tenant"),
            mono: true,
            render: (event: AuditEvent) => event.tenantId ?? "—",
          },
          {
            key: "outcome",
            title: t("audit.outcome"),
            render: (event: AuditEvent) => (
              <StatusChip
                status={
                  event.outcome === "success" ? "ok" : event.outcome === "denied" ? "warn" : "error"
                }
                label={t(`audit.outcomes.${event.outcome}`)}
              />
            ),
          },
        ]}
        rows={audit.data?.items ?? []}
        empty={t("audit.empty")}
      />
    </section>
  );
}

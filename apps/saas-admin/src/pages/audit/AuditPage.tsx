import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Alert, SectionHeader, Spinner, StatusChip, Table } from "@markiro/ui";
import { listAuditEvents, type AuditEvent } from "./api.js";

export function AuditPage() {
  const { t } = useTranslation();
  const audit = useQuery({
    queryKey: ["platform", "audit"],
    queryFn: () => listAuditEvents({ limit: 100 }),
  });
  if (audit.isPending)
    return (
      <section className="platform-page">
        <SectionHeader
          eyebrow="PLATFORM / AUDIT"
          title={t("audit.title")}
          description={t("audit.description")}
        />
        <Spinner label={t("audit.loading")} />
      </section>
    );
  if (audit.error)
    return (
      <section className="platform-page">
        <SectionHeader
          eyebrow="PLATFORM / AUDIT"
          title={t("audit.title")}
          description={t("audit.description")}
        />
        <Alert tone="error">{t("audit.loadError")}</Alert>
      </section>
    );
  return (
    <section className="platform-page">
      <SectionHeader
        eyebrow="PLATFORM / AUDIT"
        title={t("audit.title")}
        description={t("audit.description")}
      />
      <section className="commerce-ledger" aria-labelledby="audit-ledger-title">
        <header className="commerce-ledger__header">
          <div>
            <span className="commerce-ledger__eyebrow">{t("audit.registryEyebrow")}</span>
            <h2 id="audit-ledger-title">{t("audit.registryTitle")}</h2>
          </div>
          <span className="commerce-ledger__count">{audit.data?.items.length ?? 0}</span>
        </header>
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
                    event.outcome === "success"
                      ? "ok"
                      : event.outcome === "denied"
                        ? "warn"
                        : "error"
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
    </section>
  );
}

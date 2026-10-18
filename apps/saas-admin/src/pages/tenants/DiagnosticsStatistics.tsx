import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Select, Table, type TableColumn } from "@markiro/ui";
import type { StandaloneDiagnosticsStatistics } from "@markiro/platform-contracts";

import { DiagnosticsBars } from "./DiagnosticsBars.js";
import { diagnosticsKey, getDiagnosticsStatistics } from "./diagnostics-api.js";
import { monthRange, monthRow } from "./diagnostics-format.js";

const ALL_HOSTS = "all";
type Row =
  | { month: string; present: true; row: ReturnType<typeof monthRow> }
  | { month: string; present: false };

/** «Статистика по месяцам» (spec 3.7, block 3): a table, then bars; a missing month is a gap, not zero. */
export function DiagnosticsStatistics({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const [host, setHost] = useState<string>(ALL_HOSTS);
  const query = useQuery({
    queryKey: diagnosticsKey(tenantId, "statistics", host),
    queryFn: () => getDiagnosticsStatistics(tenantId, host === ALL_HOSTS ? undefined : host),
  });
  const prefix = "tenants.detail.diagnostics.statistics";
  const data: StandaloneDiagnosticsStatistics | undefined = query.data;
  const present = new Map(data?.months.map((item) => [item.month, item.stats]) ?? []);
  const keys = monthRange([...present.keys()]);
  const rows: Row[] = keys.map((month) => {
    const stats = present.get(month);
    return stats === undefined
      ? { month, present: false }
      : { month, present: true, row: monthRow(stats) };
  });
  const noData = t(`${prefix}.noData`);
  const cell =
    (pick: (row: ReturnType<typeof monthRow>) => number | null, first = false) =>
    (row: Row) =>
      row.present ? (pick(row.row) ?? "—") : first ? noData : "—";
  const column = (
    key: string,
    pick: (row: ReturnType<typeof monthRow>) => number | null,
    first = false,
  ): TableColumn<Row> => ({
    key,
    title: t(`${prefix}.columns.${key}`),
    align: "right",
    mono: true,
    wrapTitle: true,
    render: cell(pick, first),
  });
  const columns: TableColumn<Row>[] = [
    { key: "month", title: t(`${prefix}.columns.month`), mono: true, render: (row) => row.month },
    column("aggregation", (r) => r.aggregation, true),
    column("validation", (r) => r.validation),
    column("validationPrint", (r) => r.validationPrint),
    column("withPallets", (r) => r.withPallets),
    column("accepted", (r) => r.accepted),
    column("duplicates", (r) => r.duplicates),
    column("rejected", (r) => r.rejected),
    column("boxes", (r) => r.boxes),
    column("codesPerBox", (r) => r.codesPerBox),
    column("pallets", (r) => r.pallets),
    column("exceptions", (r) => r.exceptions),
    column("conflicts", (r) => r.conflicts),
    column("reprints", (r) => r.reprints),
    column("disaggregation", (r) => r.disaggregation),
    column("syncRejected", (r) => r.syncRejected),
  ];
  const series = (pick: (row: ReturnType<typeof monthRow>) => number) =>
    rows.map((row) => (row.present ? pick(row.row) : null));
  return (
    <Card title={t(`${prefix}.title`)} titleAs="h3" className="diagnostics-statistics">
      {query.isPending ? (
        <p role="status">{t("tenants.detail.diagnostics.loading")}</p>
      ) : !data ? (
        <Alert
          tone="error"
          action={
            <Button size="compact" variant="secondary" onClick={() => void query.refetch()}>
              {t("tenants.detail.diagnostics.retry")}
            </Button>
          }
        >
          {t("tenants.detail.diagnostics.loadError")}
        </Alert>
      ) : (
        <>
          {data.hosts.length > 1 || host !== ALL_HOSTS ? (
            <Select
              native
              label={t(`${prefix}.hostLabel`)}
              value={host}
              onValueChange={setHost}
              options={[
                { value: ALL_HOSTS, label: t(`${prefix}.allHosts`) },
                ...[...new Set([...data.hosts, ...(host === ALL_HOSTS ? [] : [host])])].map(
                  (key) => ({ value: key, label: key === "unknown" ? "—" : key.slice(0, 8) }),
                ),
              ]}
            />
          ) : null}
          {data.multipleHosts ? <p>{t(`${prefix}.severalHosts`)}</p> : null}
          <Table
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.month}
            tableLabel={t(`${prefix}.tableLabel`)}
            scrollLabel={t(`${prefix}.scrollLabel`)}
            empty={t(`${prefix}.empty`)}
          />
          {rows.length > 0 ? (
            <div className="diagnostics-bars" role="group" aria-label={t(`${prefix}.chartsTitle`)}>
              <DiagnosticsBars
                title={t(`${prefix}.chartShifts`)}
                months={keys}
                series={[
                  {
                    key: "aggregation",
                    label: t(`${prefix}.columns.aggregation`),
                    tone: "accent",
                    values: series((r) => r.aggregation),
                  },
                  {
                    key: "validation",
                    label: t(`${prefix}.columns.validation`),
                    tone: "muted",
                    values: series((r) => r.validation + r.validationPrint),
                  },
                ]}
              />
              <DiagnosticsBars
                title={t(`${prefix}.chartScans`)}
                months={keys}
                series={[
                  {
                    key: "accepted",
                    label: t(`${prefix}.columns.accepted`),
                    tone: "accent",
                    values: series((r) => r.accepted),
                  },
                  {
                    key: "rejected",
                    label: t(`${prefix}.columns.rejected`),
                    tone: "muted",
                    values: series((r) => r.rejected),
                  },
                ]}
              />
              <DiagnosticsBars
                title={t(`${prefix}.chartErrors`)}
                months={keys}
                series={[
                  {
                    key: "exceptions",
                    label: t(`${prefix}.columns.exceptions`),
                    tone: "accent",
                    values: series((r) => r.exceptions),
                  },
                  {
                    key: "syncRejected",
                    label: t(`${prefix}.columns.syncRejected`),
                    tone: "muted",
                    values: series((r) => r.syncRejected),
                  },
                ]}
              />
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

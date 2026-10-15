import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Drawer, Table, type TableColumn } from "@markiro/ui";
import {
  STANDALONE_SUPPORT_FEATURE_KEYS,
  STANDALONE_SUPPORT_QUOTA_KEYS,
  type StandaloneDiagnosticSummary,
} from "@markiro/platform-contracts";

import { diagnosticsKey, getDiagnostic, getDiagnosticsHistory } from "./diagnostics-api.js";
import {
  diagnosticLicenseState,
  monthRow,
  quotaText,
  useDiagnosticsDate,
} from "./diagnostics-format.js";

function DiagnosticDetail({ tenantId, id }: { tenantId: string; id: string }) {
  const { t } = useTranslation();
  const formatDate = useDiagnosticsDate();
  const prefix = "tenants.detail.diagnostics";
  const query = useQuery({
    queryKey: diagnosticsKey(tenantId, "detail", id),
    queryFn: () => getDiagnostic(tenantId, id),
  });
  if (query.isPending) return <p role="status">{t(`${prefix}.loading`)}</p>;
  if (!query.data) return <Alert tone="error">{t(`${prefix}.loadError`)}</Alert>;
  const { diagnostic, devices, license, months } = query.data;
  const noValue = t(`${prefix}.noValue`);
  const system = [diagnostic.os, diagnostic.arch, diagnostic.webview].filter(Boolean).join(", ");
  return (
    <div className="diagnostics-detail">
      <dl className="tenant-facts diagnostics-facts">
        <div>
          <dt>{t(`${prefix}.history.generated`)}</dt>
          <dd>{formatDate(diagnostic.generatedAt)}</dd>
        </div>
        <div>
          <dt>{t(`${prefix}.overview.system`)}</dt>
          <dd>{system === "" ? noValue : system}</dd>
        </div>
        <div>
          <dt>{t(`${prefix}.overview.devices`)}</dt>
          <dd>
            {t(`${prefix}.overview.deviceCounts`, {
              station: devices.station,
              office: devices.office,
              handheld: devices.handheld,
            })}
          </dd>
        </div>
        <div>
          <dt>{t(`${prefix}.overview.license`)}</dt>
          <dd title={license?.state}>{diagnosticLicenseState(t, license?.state ?? null)}</dd>
        </div>
      </dl>
      {license === null ? null : (
        <ul className="diagnostics-features">
          {STANDALONE_SUPPORT_QUOTA_KEYS.map((key) => (
            <li key={key}>
              {t(`entitlements.quotas.${key}`)}: {quotaText(t, license.quotas[key])}
            </li>
          ))}
          {STANDALONE_SUPPORT_FEATURE_KEYS.map((key) => (
            <li key={key}>
              {t(`entitlements.features.${key}`)}:{" "}
              {t(license.features[key] ? `${prefix}.overview.on` : `${prefix}.overview.off`)}
            </li>
          ))}
        </ul>
      )}
      <ul className="diagnostics-features">
        {months.map((month) => {
          const row = monthRow(month);
          return (
            <li key={month.month}>
              <span className="mono">{month.month}</span>:{" "}
              {t(`${prefix}.history.monthLine`, {
                accepted: row.accepted,
                duplicates: row.duplicates,
                rejected: row.rejected,
                boxes: row.boxes,
              })}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** «История» (spec 3.7, block 4): the stored reports, newest first, one opens in a drawer. */
export function DiagnosticsHistory({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const formatDate = useDiagnosticsDate();
  const [openId, setOpenId] = useState<string | null>(null);
  const prefix = "tenants.detail.diagnostics.history";
  const query = useInfiniteQuery({
    queryKey: diagnosticsKey(tenantId, "history"),
    queryFn: ({ pageParam }) => getDiagnosticsHistory(tenantId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const noValue = t("tenants.detail.diagnostics.noValue");
  const columns: TableColumn<StandaloneDiagnosticSummary>[] = [
    {
      key: "received",
      title: t(`${prefix}.received`),
      render: (row) => formatDate(row.receivedAt),
    },
    {
      key: "generated",
      title: t(`${prefix}.generated`),
      render: (row) => formatDate(row.generatedAt),
    },
    {
      key: "host",
      title: t(`${prefix}.host`),
      mono: true,
      render: (row) => (row.hostKey === "unknown" ? noValue : row.hostKey.slice(0, 8)),
    },
    {
      key: "role",
      title: t(`${prefix}.role`),
      render: (row) => t(`tenants.detail.diagnostics.role.${row.pcRole ?? "development"}`),
    },
    {
      key: "appVersion",
      title: t(`${prefix}.appVersion`),
      mono: true,
      render: (row) => row.appVersion ?? noValue,
    },
    {
      key: "hostVersion",
      title: t(`${prefix}.hostVersion`),
      mono: true,
      render: (row) => row.hostVersion ?? noValue,
    },
    {
      key: "license",
      title: t(`${prefix}.license`),
      render: (row) => (
        <span title={row.licenseState ?? undefined}>
          {diagnosticLicenseState(t, row.licenseState)}
        </span>
      ),
    },
    {
      key: "open",
      title: t(`${prefix}.open`),
      render: (row) => (
        <Button
          variant="secondary"
          size="compact"
          aria-label={t(`${prefix}.openLabel`, { date: formatDate(row.generatedAt) })}
          onClick={() => setOpenId(row.id)}
        >
          {t(`${prefix}.open`)}
        </Button>
      ),
    },
  ];
  return (
    <Card title={t(`${prefix}.title`)} titleAs="h3" className="diagnostics-history">
      {query.isPending ? (
        <p role="status">{t("tenants.detail.diagnostics.loading")}</p>
      ) : query.isError ? (
        <Alert
          tone="error"
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {t("tenants.detail.diagnostics.retry")}
            </Button>
          }
        >
          {t("tenants.detail.diagnostics.loadError")}
        </Alert>
      ) : (
        <>
          <Table
            columns={columns}
            rows={items}
            getRowKey={(row) => row.id}
            tableLabel={t(`${prefix}.title`)}
            scrollLabel={t(`${prefix}.scrollLabel`)}
            empty={t(`${prefix}.empty`)}
          />
          {query.hasNextPage ? (
            <Button
              variant="secondary"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t(`${prefix}.more`)}
            </Button>
          ) : null}
        </>
      )}
      <Drawer
        open={openId !== null}
        title={t(`${prefix}.detailTitle`)}
        closeLabel={t(`${prefix}.close`)}
        onClose={() => setOpenId(null)}
      >
        {openId === null ? null : <DiagnosticDetail tenantId={tenantId} id={openId} />}
      </Drawer>
    </Card>
  );
}

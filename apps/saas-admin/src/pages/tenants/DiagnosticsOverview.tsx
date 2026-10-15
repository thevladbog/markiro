import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, StatusChip } from "@markiro/ui";
import {
  STANDALONE_SUPPORT_FEATURE_KEYS,
  STANDALONE_SUPPORT_QUOTA_KEYS,
  type StandaloneDiagnosticsOverview,
} from "@markiro/platform-contracts";

import { diagnosticsKey, getDiagnosticsOverview } from "./diagnostics-api.js";
import { daysAgo, quotaText, STALE_DAYS, useDiagnosticsDate } from "./diagnostics-format.js";

type Host = StandaloneDiagnosticsOverview["hosts"][number];

function HostCard({ host, latest }: { host: Host; latest: string | null }) {
  const { t } = useTranslation();
  const formatDate = useDiagnosticsDate();
  const prefix = "tenants.detail.diagnostics.overview";
  const noValue = t("tenants.detail.diagnostics.noValue");
  const { last, license } = host;
  const age = daysAgo(last.receivedAt, new Date());
  const system = [last.os, last.arch, last.webview].filter(Boolean).join(", ");
  const sequence = license?.sequence ?? null;
  return (
    <Card
      className="diagnostics-host"
      title={host.siteName ?? t(`${prefix}.noSite`)}
      titleAs="h3"
      actions={
        <span className="diagnostics-host__badges">
          {age > STALE_DAYS ? <StatusChip phase="attention" label={t(`${prefix}.stale`)} /> : null}
          {host.outdated === true ? (
            <StatusChip
              phase="attention"
              label={t(`${prefix}.outdated`, { latest: latest ?? noValue })}
            />
          ) : null}
        </span>
      }
    >
      <dl className="tenant-facts diagnostics-facts">
        <div>
          <dt>{t(`${prefix}.host`)}</dt>
          <dd className="mono">
            {host.hostKey === "unknown" ? noValue : host.hostKey.slice(0, 8)}
          </dd>
        </div>
        <div>
          <dt>{t(`${prefix}.role`)}</dt>
          <dd>{t(`tenants.detail.diagnostics.role.${last.pcRole ?? "development"}`)}</dd>
        </div>
        <div>
          <dt>{t(`${prefix}.appVersion`)}</dt>
          <dd className="mono">{last.appVersion ?? noValue}</dd>
        </div>
        <div>
          <dt>{t(`${prefix}.hostVersion`)}</dt>
          <dd className="mono">{last.hostVersion ?? noValue}</dd>
        </div>
        <div>
          <dt>{t(`${prefix}.received`)}</dt>
          <dd>
            {formatDate(last.receivedAt)} ({t(`${prefix}.receivedAgo`, { n: age })})
          </dd>
        </div>
        <div>
          <dt>{t(`${prefix}.system`)}</dt>
          <dd>{system === "" ? noValue : system}</dd>
        </div>
        <div>
          <dt>{t(`${prefix}.devices`)}</dt>
          <dd>
            {t(`${prefix}.deviceCounts`, {
              station: host.devices.station,
              office: host.devices.office,
              handheld: host.devices.handheld,
            })}
          </dd>
        </div>
        <div>
          <dt>{t(`${prefix}.license`)}</dt>
          <dd>
            {license === null ? (
              noValue
            ) : (
              <>
                <code>{license.state}</code>
                {license.plan === null ? "" : `, ${license.plan}`}
                {license.validUntil === null
                  ? ""
                  : `, ${t(`${prefix}.validUntil`)} ${formatDate(license.validUntil)}`}
                {license.daysLeft === null
                  ? ""
                  : ` (${t(`${prefix}.daysLeft`, { n: license.daysLeft })})`}
              </>
            )}
          </dd>
        </div>
      </dl>
      {license === null ? null : (
        <>
          <dl className="tenant-facts diagnostics-facts">
            {STANDALONE_SUPPORT_QUOTA_KEYS.map((key) => {
              const quota = license.quotas[key];
              return (
                <div key={key}>
                  <dt>{t(`entitlements.quotas.${key}`)}</dt>
                  <dd>
                    {quotaText(t, quota)}{" "}
                    {quota.over ? (
                      <StatusChip phase="attention" label={t(`${prefix}.over`)} />
                    ) : null}
                  </dd>
                </div>
              );
            })}
          </dl>
          <ul className="diagnostics-features" aria-label={t(`${prefix}.features`)}>
            {STANDALONE_SUPPORT_FEATURE_KEYS.map((key) => (
              <li key={key}>
                {t(`entitlements.features.${key}`)}:{" "}
                {t(license.features[key] ? `${prefix}.on` : `${prefix}.off`)}
              </li>
            ))}
          </ul>
        </>
      )}
      {sequence === null ? null : (
        <p className="diagnostics-file-compare">
          {host.cloudLicense === null
            ? t(`${prefix}.fileOnly`, { pc: sequence })
            : host.cloudLicense.sequence === sequence
              ? t(`${prefix}.fileSame`, { pc: sequence })
              : t(`${prefix}.fileDiffers`, { pc: sequence, cloud: host.cloudLicense.sequence })}
        </p>
      )}
    </Card>
  );
}

/** «Сводка» of the tab: the last report of every host of the tenant. */
export function DiagnosticsOverview({
  tenantId,
  canWrite,
}: {
  tenantId: string;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: diagnosticsKey(tenantId, "overview"),
    queryFn: () => getDiagnosticsOverview(tenantId),
  });
  if (query.isPending) return <p role="status">{t("tenants.detail.diagnostics.loading")}</p>;
  if (!query.data)
    return (
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
    );
  if (query.data.hosts.length === 0)
    return (
      <p className="diagnostics-empty">
        {t(
          canWrite
            ? "tenants.detail.diagnostics.empty"
            : "tenants.detail.diagnostics.emptyReadOnly",
        )}
      </p>
    );
  return (
    <div className="diagnostics-hosts">
      {query.data.hosts.map((host) => (
        <HostCard key={host.hostKey} host={host} latest={query.data.latestPublishedVersion} />
      ))}
    </div>
  );
}

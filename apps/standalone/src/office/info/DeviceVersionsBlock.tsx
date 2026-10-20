import type { i18n, TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Card, StatusChip, type TableColumn } from "@markiro/ui";

import { PagedTable } from "../paging/PagedTable.js";
import type { DeviceVersion, OfficeUpdateStatus } from "../../host/distribution.js";
import { formatSize } from "../backups/backup-format.js";
import { useBackupTime } from "../backups/backup-time.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { DEVICE_STATE_PHASE, packageStateKey, summarize } from "./update-status.js";

/**
 * «Устройства и версии» (spec §10.11.7, extension point T5): the host's
 * version and package, each device's version, protocol and state in words,
 * its last download and installation, when it was last seen; then the
 * update history. Both office roles read it.
 */
export function DeviceVersionsBlock() {
  const { t } = useTranslation();
  const status = useOfficeQuery(officeKeys.updateStatus, (api, token) =>
    api.getUpdateStatus(token),
  );
  const time = useBackupTime(status.isSuccess);
  let body;
  if (status.isPending || (status.isSuccess && !time.ready)) body = <PageLoading />;
  else if (status.isError)
    body = <LoadError error={status.error} onRetry={() => void status.refetch()} />;
  else body = <Versions status={status.data} format={time.format} />;
  return (
    <Card title={t("office.about.update.devices.title")} titleAs="h3">
      {body}
    </Card>
  );
}

function summaryText(status: OfficeUpdateStatus, t: TFunction): string {
  const summary = summarize(status);
  const parts = [
    t("office.about.update.devices.summary", {
      host: summary.hostVersion,
      compatible: summary.compatible,
      total: summary.total,
    }),
  ];
  for (const [state, count] of [
    ["incompatible", summary.incompatible],
    ["hostOlder", summary.hostOlder],
    ["unknown", summary.unknown],
  ] as const) {
    if (count > 0) parts.push(t(`office.about.update.devices.count.${state}`, { count }));
  }
  return parts.join("; ");
}

/** An action a newer host names and this app does not know reads as a generic event. */
function historyActionKey(action: string, i18n: i18n): string {
  const key = `office.about.update.history.action.${action}`;
  return i18n.exists(key) ? key : "office.about.update.history.action.unknown";
}

function Versions({
  status,
  format,
}: {
  status: OfficeUpdateStatus;
  format: (instant: string) => string;
}) {
  const { t, i18n } = useTranslation();
  const columns: TableColumn<DeviceVersion>[] = [
    {
      key: "name",
      title: t("office.about.update.devices.device"),
      wrap: true,
      render: (device) =>
        `${device.name} · ${t(`office.about.update.devices.kind.${device.kind}`)}`,
    },
    {
      key: "line",
      title: t("office.about.update.devices.line"),
      render: (device) => device.lineName ?? "—",
    },
    {
      key: "version",
      title: t("office.about.update.devices.version"),
      mono: true,
      render: (device) =>
        t("office.about.update.devices.versionProtocol", {
          version: device.appVersion,
          protocol: device.protocol,
        }),
    },
    {
      key: "state",
      title: t("office.about.update.devices.state.title"),
      render: (device) => (
        <StatusChip
          phase={DEVICE_STATE_PHASE[device.state]}
          label={t(`office.about.update.devices.state.${device.state}`)}
        />
      ),
    },
    {
      key: "package",
      title: t("office.about.update.devices.package"),
      wrap: true,
      render: (device) =>
        [
          device.downloaded === null
            ? null
            : t("office.about.update.devices.downloaded", { when: format(device.downloaded.at) }),
          device.installStarted === null
            ? null
            : t("office.about.update.devices.installStarted", {
                when: format(device.installStarted.at),
              }),
        ]
          .filter((part): part is string => part !== null)
          .join("; ") || "—",
    },
    {
      key: "seen",
      title: t("office.about.update.devices.seen"),
      render: (device) => (device.lastSeenAt === null ? "—" : format(device.lastSeenAt)),
    },
  ];
  const state = packageStateKey(status.package.state);
  return (
    <>
      <p>{summaryText(status, t)}</p>
      <p>
        {t(`office.about.update.package.${state}`, { version: status.package.version ?? "" })}{" "}
        {t("office.about.update.package.disk", { size: formatSize(status.package.diskBytes, t) })}
      </p>
      {status.package.staged !== null && (
        <p>{t("office.about.update.package.staged", { version: status.package.staged })}</p>
      )}
      <PagedTable
        tableId="device-versions"
        columns={columns}
        rows={status.devices}
        scrollLabel={t("office.about.update.devices.table")}
        empty={t("office.about.update.devices.empty")}
      />
      <section className="office-section-intro">
        <h4>{t("office.about.update.history.title")}</h4>
        {status.history.length === 0 ? (
          <p className="office-note">{t("office.about.update.history.empty")}</p>
        ) : (
          <ul className="update-history">
            {status.history.map((item, index) => (
              // Equal entries can repeat (one second, one actor): the order is the identity.
              <li key={`${index}:${item.at}:${item.action}:${item.actor ?? ""}`}>
                {format(item.at)} —{" "}
                {t(historyActionKey(item.action, i18n), {
                  actor: item.actor ?? "—",
                  version: item.version ?? item.to ?? "",
                  from: item.from ?? "",
                  to: item.to ?? "",
                })}
                {item.result === "ok" ? "" : ` (${t("office.about.update.history.failed")})`}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

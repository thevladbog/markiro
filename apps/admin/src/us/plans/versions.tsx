import { Button, StatusChip, Table, type TableColumn } from "@markiro/ui";
import type { UsPlanListResponse } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";

export function planDate(value: string, locale: string, timeZone = "UTC", instant = false) {
  return new Intl.DateTimeFormat(
    locale,
    instant
      ? { dateStyle: "medium", timeStyle: "long", timeZone }
      : { year: "numeric", month: "2-digit", day: "2-digit", timeZone },
  ).format(new Date(value));
}
export function PlanVersions({
  list,
  timeZone,
  selectedId,
  onSelect,
}: {
  list: UsPlanListResponse;
  timeZone: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const columns: TableColumn<UsPlanListResponse["items"][number]>[] = [
    {
      key: "version",
      title: t("usPlan.version"),
      mono: true,
      render: (row) => `v${row.versionNumber}`,
    },
    {
      key: "status",
      title: t("usPlan.status"),
      render: (row) => (
        <StatusChip
          status={row.status === "effective" ? "ok" : "neutral"}
          label={t(`usPlan.${row.status}`)}
        />
      ),
    },
    {
      key: "date",
      title: (
        <>
          {t("usPlan.effectiveDate")}
          <span className="us-plan-source">{timeZone}</span>
        </>
      ),
      wrap: true,
      render: (row) =>
        row.status === "draft" ? (
          t("usPlan.notEffective")
        ) : (
          <time dateTime={row.approvedAt}>{planDate(row.approvedAt, i18n.language, timeZone)}</time>
        ),
    },
    {
      key: "provenance",
      title: t("usPlan.provenance"),
      wrap: true,
      render: (row) => (
        <StatusChip
          status="neutral"
          label={t(
            row.provenance === "trusted_synthetic" ? "usPlan.synthetic" : "usPlan.operational",
          )}
        />
      ),
    },
    {
      key: "retention",
      title: t("usPlan.retention"),
      wrap: true,
      render: (row) =>
        row.status === "draft" ? (
          "—"
        ) : row.status === "effective" ? (
          t("usPlan.noExpiry")
        ) : row.retainThrough ? (
          <time dateTime={row.retainThrough}>
            {planDate(`${row.retainThrough}T12:00:00Z`, i18n.language)}
          </time>
        ) : (
          t("usPlan.indefinite")
        ),
    },
    {
      key: "actions",
      title: t("usPlan.actions"),
      render: (row) => (
        <Button
          variant="secondary"
          data-plan-version={row.id}
          aria-pressed={selectedId === row.id}
          onClick={() => onSelect(row.id)}
        >
          {t("usPlan.view", { version: row.versionNumber })}
        </Button>
      ),
    },
  ];
  return (
    <Table<UsPlanListResponse["items"][number]>
      className="us-plan-versions"
      scrollLabel={t("usPlan.versions")}
      rows={[...list.items].sort((a, b) => b.versionNumber - a.versionNumber)}
      columns={columns.map((column) => ({
        ...column,
        render: (row) => (
          <>
            <span aria-hidden="true" className="us-plan-mobile-label">
              {column.title}
            </span>
            {column.render?.(row)}
          </>
        ),
      }))}
    />
  );
}

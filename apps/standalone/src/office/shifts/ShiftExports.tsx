import { getPalletExportFormat, getShiftExportFormat } from "@markiro/domain";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Card, Table, type TableColumn } from "@markiro/ui";

import type { OfficeShiftExport } from "../../host/review.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import type { OfficeShift } from "../../host/protocol.js";

/** Counts with the thousands apart by a no-break space: «1 200». */
const COUNT = new Intl.NumberFormat("ru");

/** A format's name as the export dialog offers it; a format a newer host records, as its id. */
function formatLabel(row: OfficeShiftExport): string {
  try {
    return row.palletId === null
      ? getShiftExportFormat(row.formatId, row.formatVersion).label
      : getPalletExportFormat(row.formatId, row.formatVersion).label;
  } catch {
    return `${row.formatId} v${row.formatVersion}`;
  }
}

/**
 * «Выгрузки» of the shift's drawer: the history of what the office saved from
 * it (the audit trail's `shift.export` rows, newest first) — when, by whom, in
 * which format and how many codes, boxes, pallets and parts. The files lie in
 * the folder the export dialog named; a new export is the drawer's
 * «Выгрузка».
 */
export function ShiftExports({
  shift,
  at,
}: {
  shift: OfficeShift;
  /** An instant in the organization's zone, or «—». */
  at: (instant: string | null) => string;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const exports = useOfficeQuery(officeKeys.shiftExports(shift.id), (api, token) =>
    api.listShiftExports(token, shift.id),
  );

  const columns: TableColumn<OfficeShiftExport>[] = [
    {
      key: "at",
      title: t("office.shiftCard.exports.at"),
      wrap: true,
      minWidth: 130,
      render: (row) => at(row.recordedAt),
    },
    {
      key: "format",
      title: t("office.shiftCard.exports.format"),
      wrap: true,
      minWidth: 220,
      render: (row) => (
        <span className="shift-cell">
          <span>{formatLabel(row)}</span>
          {row.palletId !== null && (
            <span className="shift-cell__quiet">{t("office.shiftCard.exports.ofPallet")}</span>
          )}
          {row.maxLines !== null && (
            <span className="shift-cell__quiet">
              {t("office.shiftCard.exports.maxLines", { count: COUNT.format(row.maxLines) })}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "codes",
      title: t("office.shiftCard.exports.codes"),
      mono: true,
      align: "right",
      render: (row) => COUNT.format(row.codeCount),
    },
    {
      key: "boxes",
      title: t("office.shiftCard.exports.boxes"),
      mono: true,
      align: "right",
      render: (row) => COUNT.format(row.boxCount),
    },
    {
      key: "pallets",
      title: t("office.shiftCard.exports.pallets"),
      mono: true,
      align: "right",
      render: (row) => COUNT.format(row.palletCount),
    },
    {
      key: "parts",
      title: t("office.shiftCard.exports.parts"),
      mono: true,
      align: "right",
      render: (row) => COUNT.format(row.partCount),
    },
    {
      key: "user",
      title: t("office.shiftCard.exports.user"),
      wrap: true,
      render: (row) => row.userName ?? t("office.common.none"),
    },
  ];

  return (
    <section className="shift-card__section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("office.shiftCard.exports.title")}</h2>
      <Card>
        <p className="office-note">{t("office.shiftCard.exports.hint")}</p>
        {exports.isPending ? (
          <PageLoading />
        ) : exports.isError ? (
          <LoadError error={exports.error} onRetry={() => void exports.refetch()} />
        ) : (
          <Table
            columns={columns}
            rows={exports.data.items}
            getRowKey={(row) => String(row.id)}
            empty={t("office.shiftCard.exports.empty")}
            scrollLabel={t("office.shiftCard.exports.table")}
          />
        )}
      </Card>
    </section>
  );
}

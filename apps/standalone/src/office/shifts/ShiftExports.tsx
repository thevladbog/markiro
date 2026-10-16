import { getPalletExportFormat, getShiftExportFormat } from "@markiro/domain";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Card, type TableColumn } from "@markiro/ui";

import { PagedTable } from "../paging/PagedTable.js";
import type { ExportFile } from "../../host/export-files.js";
import type { OfficeShiftExport } from "../../host/review.js";
import { StoredFiles } from "../exports/StoredFiles.js";
import { StoreSettings } from "../exports/StoreSettings.js";
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
 * which format and how many codes, boxes, pallets and parts — and, for each
 * export, the files the host keeps (host migration `0029`): «Скачать» gives
 * back the exact bytes, SHA-256 checked, whatever became of the copy in the
 * Documents folder. An export made before files were kept says so. Below: the
 * printed forms of the shift the host keeps, and the retention of the store.
 * A new export is the drawer's «Выгрузка».
 */
export function ShiftExports({
  shift,
  at,
  timeZone,
}: {
  shift: OfficeShift;
  /** An instant in the organization's zone, or «—». */
  at: (instant: string | null) => string;
  /** The organization's zone: it names the folder a download goes to. */
  timeZone: string;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const formsTitleId = useId();
  const settingsTitleId = useId();
  const forms = useOfficeQuery(officeKeys.shiftForms(shift.id), (api, token) =>
    api.listExportFiles(token, { shiftId: shift.id, kind: "form" }),
  );
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
      minWidth: 260,
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
          {row.files.length === 0 ? (
            <span className="shift-cell__quiet">{t("office.storedFiles.notStored")}</span>
          ) : (
            <StoredFiles files={row.files} label={shift.number} timeZone={timeZone} />
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

  const formColumns: TableColumn<ExportFile>[] = [
    {
      key: "at",
      title: t("office.shiftCard.exports.at"),
      wrap: true,
      minWidth: 130,
      render: (row) => at(row.createdAt),
    },
    {
      key: "user",
      title: t("office.shiftCard.exports.user"),
      wrap: true,
      render: (row) => row.userName ?? t("office.common.none"),
    },
    {
      key: "file",
      title: t("office.shiftCard.exports.files"),
      wrap: true,
      minWidth: 240,
      render: (row) => <StoredFiles files={[row]} label={shift.number} timeZone={timeZone} />,
    },
  ];

  return (
    <>
      <section className="shift-card__section" aria-labelledby={titleId}>
        <h2 id={titleId}>{t("office.shiftCard.exports.title")}</h2>
        <Card>
          <p className="office-note">{t("office.shiftCard.exports.hint")}</p>
          {exports.isPending ? (
            <PageLoading />
          ) : exports.isError ? (
            <LoadError error={exports.error} onRetry={() => void exports.refetch()} />
          ) : (
            <PagedTable
              tableId="shift-exports"
              columns={columns}
              rows={exports.data.items}
              getRowKey={(row) => String(row.id)}
              empty={t("office.shiftCard.exports.empty")}
              scrollLabel={t("office.shiftCard.exports.table")}
            />
          )}
        </Card>
      </section>
      <section className="shift-card__section" aria-labelledby={formsTitleId}>
        <h2 id={formsTitleId}>{t("office.shiftCard.exports.formsTitle")}</h2>
        <Card>
          <p className="office-note">{t("office.shiftCard.exports.formsHint")}</p>
          {forms.isPending ? (
            <PageLoading />
          ) : forms.isError ? (
            <LoadError error={forms.error} onRetry={() => void forms.refetch()} />
          ) : (
            <PagedTable
              tableId="shift-export-files"
              columns={formColumns}
              rows={forms.data.items}
              getRowKey={(row) => row.id}
              empty={t("office.shiftCard.exports.formsEmpty")}
              scrollLabel={t("office.shiftCard.exports.formsTable")}
            />
          )}
        </Card>
      </section>
      <section className="shift-card__section" aria-labelledby={settingsTitleId}>
        <h2 id={settingsTitleId}>{t("office.storedFiles.settings.title")}</h2>
        <Card>
          <StoreSettings />
        </Card>
      </section>
    </>
  );
}

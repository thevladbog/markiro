import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";

import { Card, type TableColumn } from "@markiro/ui";

import { PagedTable } from "../paging/PagedTable.js";
import type { ExportFile, ExportTargetType } from "../../host/export-files.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { StoredFiles } from "./StoredFiles.js";

/**
 * «Сохранённые файлы» of a box's, a pallet's or a disaggregation document's
 * card (host migration `0029`): the printed forms and ЧЗ files made from it,
 * which the host keeps, each with «Скачать». The section is left out while
 * the card has none, and while the list is not read: it is information, never a
 * reason to stop the card.
 */
export function CardFiles({
  targetType,
  targetId,
  label,
  at,
  timeZone,
}: {
  targetType: ExportTargetType;
  targetId: string;
  /** What the folder of a download is named by: the box's or pallet's SSCC, the document's number. */
  label: string;
  at: (instant: string) => string;
  timeZone: string;
}) {
  const { t } = useTranslation();
  const files = useOfficeQuery(officeKeys.cardFiles(targetType, targetId), (api, token) =>
    api.listExportFiles(token, { targetType, targetId }),
  );
  const items = files.data?.items ?? [];
  const { hash, key: navigationKey } = useLocation();
  const section = useRef<HTMLElement>(null);
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (hash !== "#stored-files") {
      focused.current = null;
      return;
    }
    const key = `${navigationKey}:${targetType}:${targetId}`;
    if (items.length === 0 || focused.current === key || section.current === null) return;
    focused.current = key;
    section.current.scrollIntoView({ block: "start" });
    section.current.focus({ preventScroll: true });
  }, [hash, navigationKey, targetType, targetId, items.length]);
  if (items.length === 0) return null;
  const columns: TableColumn<ExportFile>[] = [
    {
      key: "at",
      title: t("office.storedFiles.card.at"),
      wrap: true,
      minWidth: 130,
      render: (row) => at(row.createdAt),
    },
    {
      key: "user",
      title: t("office.storedFiles.card.user"),
      wrap: true,
      render: (row) => row.userName ?? t("office.common.none"),
    },
    {
      key: "file",
      title: t("office.storedFiles.card.file"),
      wrap: true,
      minWidth: 240,
      render: (row) => <StoredFiles files={[row]} label={label} timeZone={timeZone} />,
    },
  ];
  return (
    <section ref={section} id="stored-files" tabIndex={-1} className="shift-card__section">
      <h2>{t("office.storedFiles.card.title")}</h2>
      <Card>
        <p className="office-note">{t("office.storedFiles.card.hint")}</p>
        <PagedTable
          tableId="card-files"
          columns={columns}
          rows={items}
          getRowKey={(row) => row.id}
          empty=""
          scrollLabel={t("office.storedFiles.card.table")}
        />
      </Card>
    </section>
  );
}

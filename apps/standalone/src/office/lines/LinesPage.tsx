import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, PageHeader, RowActions, Table, type TableColumn } from "@markiro/ui";

import type { OfficeLine } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName, ArchiveStatus, useStoreRecord } from "../records.js";
import { ArchiveLineDialog } from "./ArchiveLineDialog.js";
import { LineDialog, type LineDialogMode } from "./LineDialog.js";

type LinesDialog = LineDialogMode | { kind: "archive"; line: OfficeLine };

/**
 * Production lines (spec §4.3, §4.8), archived ones included. Administrators
 * add, rename, archive and bring back lines; technologists read the list.
 */
export function LinesPage() {
  const { t } = useTranslation();
  const canEdit = useCan("editReference");
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const store = useStoreRecord<OfficeLine>(officeKeys.lines);
  const [dialog, setDialog] = useState<LinesDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: LinesDialog) => {
    setNotice(null);
    setDialog(next);
  };
  const saved = (line: OfficeLine, message: string) => {
    store(line);
    setDialog(null);
    setNotice(message);
  };
  const savedNotice = (kind: LineDialogMode["kind"], line: OfficeLine) => {
    switch (kind) {
      case "create":
        return t("office.lines.created", { name: line.name });
      case "rename":
        return t("office.common.saved");
      case "restore":
        return t("office.lines.restored", { name: line.name });
    }
  };
  const reload = () => {
    setDialog(null);
    void lines.refetch();
  };

  const columns: TableColumn<OfficeLine>[] = [
    { key: "name", title: t("office.lines.table.name"), render: (line) => line.name },
    {
      key: "status",
      title: t("office.lines.table.status"),
      render: (line) => <ArchiveStatus archived={line.archived} />,
    },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      title: t("office.lines.table.actions"),
      render: (line) =>
        line.archived ? (
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.lines.restoreNamed", { name: line.name })}
            onClick={() => open({ kind: "restore", line })}
          >
            {t("office.lines.restore")}
          </Button>
        ) : (
          <RowActions>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.lines.renameNamed", { name: line.name })}
              onClick={() => open({ kind: "rename", line })}
            >
              {t("office.lines.rename")}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.lines.archiveNamed", { name: line.name })}
              onClick={() => open({ kind: "archive", line })}
            >
              {t("office.lines.archive")}
            </Button>
          </RowActions>
        ),
    });
  }

  const content = () => {
    if (lines.isPending) return <PageLoading />;
    if (lines.isError)
      return <LoadError error={lines.error} onRetry={() => void lines.refetch()} />;
    return (
      <Card>
        <Table
          columns={columns}
          rows={activeFirstByName(lines.data)}
          getRowKey={(line) => line.id}
          empty={t("office.lines.empty")}
          scrollLabel={t("office.lines.title")}
        />
        {!canEdit && <p className="office-note">{t("office.common.readOnly")}</p>}
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.lines.title")}
        actions={
          canEdit ? (
            <Button onClick={() => open({ kind: "create" })}>{t("office.lines.add")}</Button>
          ) : null
        }
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {content()}
      {canEdit && dialog !== null && dialog.kind === "archive" && (
        <ArchiveLineDialog
          line={dialog.line}
          onClose={() => setDialog(null)}
          onArchived={(line) => saved(line, t("office.lines.archived", { name: line.name }))}
          onReload={reload}
        />
      )}
      {canEdit && dialog !== null && dialog.kind !== "archive" && (
        <LineDialog
          mode={dialog}
          onClose={() => setDialog(null)}
          onSaved={(line) => saved(line, savedNotice(dialog.kind, line))}
          onReload={reload}
        />
      )}
    </>
  );
}

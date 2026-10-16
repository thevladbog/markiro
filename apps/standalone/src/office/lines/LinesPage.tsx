import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, PageHeader, type TableColumn } from "@markiro/ui";

import { listViewState } from "../list/list-state.js";
import { ListCard } from "../list/ListCard.js";
import { ListEmpty, ListError, ListSkeleton } from "../list/ListStates.js";
import { RowActionBar } from "../list/RowActionBar.js";
import { OfficeIcon } from "../OfficeIcon.js";
import { PagedTable } from "../paging/PagedTable.js";
import type { OfficeLine } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
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
      stickyEnd: true,
      title: t("office.lines.table.actions"),
      render: (line) => (
        <RowActionBar
          actions={[
            line.archived
              ? {
                  key: "restore",
                  label: t("office.lines.restoreNamed", { name: line.name }),
                  icon: "reset",
                  onSelect: () => open({ kind: "restore", line }),
                }
              : {
                  key: "rename",
                  label: t("office.lines.renameNamed", { name: line.name }),
                  icon: "pencil",
                  onSelect: () => open({ kind: "rename", line }),
                },
          ]}
          {...(line.archived
            ? {}
            : {
                menu: {
                  label: t("office.common.rowActions", { name: line.name }),
                  items: [
                    {
                      key: "archive",
                      label: t("office.lines.archive"),
                      ariaLabel: t("office.lines.archiveNamed", { name: line.name }),
                      icon: "archive" as const,
                      destructive: true,
                      onSelect: () => open({ kind: "archive", line }),
                    },
                  ],
                },
              })}
        />
      ),
    });
  }

  const rows = lines.isSuccess ? activeFirstByName(lines.data) : [];
  const view = listViewState({
    pending: lines.isPending,
    failed: lines.isError,
    total: rows.length,
    found: rows.length,
  });
  const state =
    view === "loading" ? (
      <ListSkeleton />
    ) : view === "error" ? (
      <ListError error={lines.error} onRetry={() => void lines.refetch()} />
    ) : view === "empty" ? (
      <ListEmpty
        icon="factory"
        title={t("office.lines.empty")}
        {...(canEdit
          ? {
              action: (
                <Button
                  icon={<OfficeIcon name="plus" size={20} />}
                  onClick={() => open({ kind: "create" })}
                >
                  {t("office.lines.add")}
                </Button>
              ),
            }
          : {})}
      />
    ) : null;
  const content = (
    <ListCard>
      <PagedTable
        tableId="lines"
        columns={columns}
        rows={rows}
        getRowKey={(line) => line.id}
        empty={state}
        scrollLabel={t("office.lines.title")}
      />
      {!canEdit && (
        <p className="office-list-note office-list-foot">{t("office.common.readOnly")}</p>
      )}
    </ListCard>
  );

  return (
    <>
      <PageHeader
        title={t("office.lines.title")}
        description={t("office.lines.subtitle")}
        actions={
          canEdit ? (
            <Button onClick={() => open({ kind: "create" })}>{t("office.lines.add")}</Button>
          ) : null
        }
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {content}
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

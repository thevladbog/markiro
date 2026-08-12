import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useNavigate } from "react-router";

import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  AdminPage,
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  RowActions,
  Spinner,
  Table,
} from "@markiro/ui";
import type { TableColumn } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import i18n from "../../i18n/index.js";
import { formatCreatedAt } from "../../lib/datetime.js";
import { toast } from "../../lib/toast.js";
import { useDeleteLine, useLines, type LineDto } from "../shifts/api.js";
import type { LinesPanelContext, LinesPanelLocationState } from "./LinePanelRoute.js";
import "./lines.css";

function AuthorizedCreateLineAction() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Button
      type="button"
      onClick={() =>
        void navigate("new", {
          state: { linesBackground: true } satisfies LinesPanelLocationState,
        })
      }
    >
      {t("pages.lines.addAction")}
    </Button>
  );
}

function AuthorizedLineRowActions({ line }: { line: LineDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const deleteMutation = useDeleteLine();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    try {
      setDeleteError(null);
      await deleteMutation.mutateAsync(line.id);
      toast("ok", t("pages.lines.toasts.deleteSuccess"));
      setDeleting(false);
    } catch (cause) {
      setDeleteError(
        cause instanceof ApiRequestError && cause.status === 409
          ? t("pages.lines.deleteReferencedError")
          : t("pages.lines.toasts.deleteError"),
      );
    }
  };

  return (
    <>
      <RowActions>
        <Button
          type="button"
          size="compact"
          variant="secondary"
          onClick={() =>
            void navigate(`${line.id}/edit`, {
              state: { linesBackground: true } satisfies LinesPanelLocationState,
            })
          }
        >
          {t("pages.lines.edit")}
        </Button>
        <Button
          type="button"
          size="compact"
          variant="destructive"
          onClick={() => {
            setDeleteError(null);
            setDeleting(true);
          }}
        >
          {t("pages.lines.delete")}
        </Button>
      </RowActions>
      <ConfirmDialog
        open={deleting}
        title={t("pages.lines.deleteConfirmTitle")}
        description={t("pages.lines.deleteConfirmBody")}
        entity={line.name}
        error={deleteError}
        cancelLabel={t("pages.lines.cancel")}
        confirmLabel={t("pages.lines.deleteConfirmAction")}
        tone="destructive"
        busy={deleteMutation.isPending}
        onCancel={() => setDeleting(false)}
        onConfirm={() => void handleDelete()}
      />
    </>
  );
}

export function LinesPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const query = useLines();
  const items = query.data ?? [];

  const columns: TableColumn<LineDto>[] = useMemo(() => {
    const referenceColumns: TableColumn<LineDto>[] = [
      { key: "name", title: t("pages.lines.table.name") },
      {
        key: "createdAt",
        title: t("pages.lines.table.createdAt"),
        mono: true,
        render: (line) => (
          <time dateTime={line.createdAt}>{formatCreatedAt(line.createdAt, i18n.language)}</time>
        ),
      },
    ];
    return canWrite
      ? [
          ...referenceColumns,
          {
            key: "actions",
            title: t("pages.lines.table.actions"),
            align: "right",
            render: (line) => <AuthorizedLineRowActions line={line} />,
          },
        ]
      : referenceColumns;
  }, [canWrite, t]);

  return (
    <AdminPage className="mk-lines-page" data-testid="lines-page">
      <PageHeader
        title={t("pages.lines.title")}
        actions={canWrite ? <AuthorizedCreateLineAction /> : null}
      />

      <p className="mk-lines-description">{t("pages.lines.description")}</p>
      <p className="mk-lines-result" aria-live="polite">
        {!query.isPending && !query.isError
          ? t("pages.lines.resultCount", { count: items.length })
          : ""}
      </p>

      {query.isPending ? (
        <div className="mk-line-section-state">
          <Spinner label={t("common.loading")} />
        </div>
      ) : query.isError ? (
        <div className="mk-line-section-state">
          <Alert tone="error">{t("common.loadError")}</Alert>
          <Button type="button" variant="secondary" onClick={() => void query.refetch()}>
            {t("pages.lines.retry")}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("pages.lines.emptyTitle")}
          hint={t("pages.lines.emptyHint")}
          action={canWrite ? <AuthorizedCreateLineAction /> : null}
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}

      <Outlet
        context={
          {
            lines: items,
            linesPending: query.isPending,
            linesError: query.isError,
            retryPanelData: async () => {
              await query.refetch();
            },
          } satisfies LinesPanelContext
        }
      />
    </AdminPage>
  );
}

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
import { toast } from "../../lib/toast.js";
import { useCounterparties, useDeleteCounterparty, type CounterpartyDto } from "./api.js";
import type {
  CounterpartiesPanelContext,
  CounterpartiesPanelLocationState,
} from "./CounterpartyPanelRoute.js";
import "./counterparties.css";

function AuthorizedCreateCounterpartyAction() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Button
      type="button"
      onClick={() =>
        void navigate("new", {
          state: { counterpartiesBackground: true } satisfies CounterpartiesPanelLocationState,
        })
      }
    >
      {t("pages.counterparties.addAction")}
    </Button>
  );
}

function AuthorizedCounterpartyRowActions({ counterparty }: { counterparty: CounterpartyDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const deleteMutation = useDeleteCounterparty();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    try {
      setDeleteError(null);
      await deleteMutation.mutateAsync(counterparty.id);
      toast("ok", t("pages.counterparties.toasts.deleteSuccess"));
      setDeleting(false);
    } catch (error) {
      setDeleteError(
        error instanceof ApiRequestError
          ? error.message
          : t("pages.counterparties.toasts.deleteError"),
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
            void navigate(`${counterparty.id}/edit`, {
              state: { counterpartiesBackground: true } satisfies CounterpartiesPanelLocationState,
            })
          }
        >
          {t("pages.counterparties.edit")}
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
          {t("pages.counterparties.delete")}
        </Button>
      </RowActions>
      <ConfirmDialog
        open={deleting}
        title={t("pages.counterparties.deleteConfirmTitle")}
        description={
          <>
            <p>{t("pages.counterparties.deleteConfirmBody", { name: counterparty.name })}</p>
            {deleteError ? <Alert tone="error">{deleteError}</Alert> : null}
          </>
        }
        entity={counterparty.gln}
        cancelLabel={t("pages.counterparties.cancel")}
        confirmLabel={t("pages.counterparties.deleteConfirmAction")}
        tone="destructive"
        busy={deleteMutation.isPending}
        onCancel={() => setDeleting(false)}
        onConfirm={() => void handleDelete()}
      />
    </>
  );
}

export function CounterpartiesPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const query = useCounterparties();
  const items = query.data ?? [];

  const columns: TableColumn<CounterpartyDto>[] = useMemo(
    () => [
      { key: "name", title: t("pages.counterparties.table.name") },
      { key: "gln", title: t("pages.counterparties.table.gln"), mono: true },
      {
        key: "inn",
        title: t("pages.counterparties.table.inn"),
        mono: true,
        render: (row) => row.inn ?? "—",
      },
      {
        key: "prefixes",
        title: t("pages.counterparties.table.prefixes"),
        align: "right",
        render: (row) => row.gs1Prefixes.length,
      },
      {
        key: "actions",
        title: t("pages.counterparties.table.actions"),
        align: "right",
        render: (row) =>
          canWrite ? <AuthorizedCounterpartyRowActions counterparty={row} /> : null,
      },
    ],
    [canWrite, t],
  );

  return (
    <AdminPage className="mk-counterparties-page" data-testid="counterparties-page">
      <PageHeader
        title={t("pages.counterparties.title")}
        actions={canWrite ? <AuthorizedCreateCounterpartyAction /> : null}
      />

      <p className="mk-counterparties-result" aria-live="polite">
        {!query.isPending && !query.isError
          ? t("pages.counterparties.resultCount", { count: items.length })
          : ""}
      </p>

      {query.isPending ? (
        <div className="mk-counterparty-section-state">
          <Spinner label={t("common.loading")} />
        </div>
      ) : query.isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("pages.counterparties.emptyTitle")}
          hint={t("pages.counterparties.emptyHint")}
          action={canWrite ? <AuthorizedCreateCounterpartyAction /> : null}
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}

      <Outlet
        context={
          {
            counterparties: items,
            counterpartiesPending: query.isPending,
            counterpartiesError: query.isError,
            retryPanelData: async () => {
              await query.refetch();
            },
          } satisfies CounterpartiesPanelContext
        }
      />
    </AdminPage>
  );
}

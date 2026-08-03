import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, EmptyState, Modal, PageHeader, Spinner, Table } from "@markiro/ui";
import type { TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { CounterpartyForm, type CounterpartyFormValues } from "./CounterpartyForm.js";
import {
  useCounterparties,
  useCreateCounterparty,
  useDeleteCounterparty,
  useUpdateCounterparty,
  type CounterpartyDto,
  type CreateCounterpartyInput,
} from "./api.js";

function AuthorizedCreateCounterpartyAction() {
  const { t } = useTranslation();
  const createMutation = useCreateCounterparty();
  const [open, setOpen] = useState(false);

  const handleSubmit = async (input: CreateCounterpartyInput) => {
    try {
      await createMutation.mutateAsync(input);
      toast("ok", t("pages.counterparties.toasts.createSuccess"));
      setOpen(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.counterparties.toasts.createError"),
      );
    }
  };

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t("pages.counterparties.addAction")}
      </Button>
      {open ? (
        <CounterpartyForm
          open
          mode="create"
          submitting={createMutation.isPending}
          onSubmit={handleSubmit}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function AuthorizedCounterpartyRowActions({ counterparty }: { counterparty: CounterpartyDto }) {
  const { t } = useTranslation();
  const updateMutation = useUpdateCounterparty();
  const deleteMutation = useDeleteCounterparty();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const initialValues: CounterpartyFormValues = {
    name: counterparty.name,
    gln: counterparty.gln,
    inn: counterparty.inn ?? "",
    gs1Prefixes: counterparty.gs1Prefixes.join(", "),
    notes: counterparty.notes ?? "",
  };

  const handleUpdate = async (input: CreateCounterpartyInput) => {
    try {
      await updateMutation.mutateAsync({ id: counterparty.id, input });
      toast("ok", t("pages.counterparties.toasts.updateSuccess"));
      setEditing(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.counterparties.toasts.updateError"),
      );
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(counterparty.id);
      toast("ok", t("pages.counterparties.toasts.deleteSuccess"));
      setDeleting(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.counterparties.toasts.deleteError"),
      );
    }
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button type="button" size="compact" variant="secondary" onClick={() => setEditing(true)}>
          {t("pages.counterparties.edit")}
        </Button>
        <Button
          type="button"
          size="compact"
          variant="destructive"
          onClick={() => setDeleting(true)}
        >
          {t("pages.counterparties.delete")}
        </Button>
      </div>
      {editing ? (
        <CounterpartyForm
          open
          mode="edit"
          initialValues={initialValues}
          counterpartyId={counterparty.id}
          submitting={updateMutation.isPending}
          onSubmit={handleUpdate}
          onClose={() => setEditing(false)}
        />
      ) : null}
      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        closeLabel={t("common.close")}
        title={t("pages.counterparties.deleteConfirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setDeleting(false)}>
              {t("pages.counterparties.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={deleteMutation.isPending}
              onClick={() => void handleDelete()}
            >
              {t("pages.counterparties.deleteConfirmAction")}
            </Button>
          </>
        }
      >
        <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
          {t("pages.counterparties.deleteConfirmBody", { name: counterparty.name })}
        </p>
      </Modal>
    </>
  );
}

/** Admin counterparties CRUD screen -- Plan 03 Task 11 (list/create/edit/delete). */
export function CounterpartiesPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const { data, isPending, isError } = useCounterparties();

  const items = data ?? [];

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
    [t, canWrite],
  );

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.counterparties.title")}
        actions={canWrite ? <AuthorizedCreateCounterpartyAction /> : null}
      />

      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
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
    </div>
  );
}

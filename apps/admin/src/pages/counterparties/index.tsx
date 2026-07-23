import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, EmptyState, Modal, PageHeader, Spinner, Table, toast } from "@markiro/ui";
import type { TableColumn } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { CounterpartyForm, type CounterpartyFormValues } from "./CounterpartyForm.js";
import {
  useCounterparties,
  useCreateCounterparty,
  useDeleteCounterparty,
  useUpdateCounterparty,
  type CounterpartyDto,
  type CreateCounterpartyInput,
} from "./api.js";

type FormModalState = { mode: "create" } | { mode: "edit"; counterparty: CounterpartyDto } | null;

/** Admin counterparties CRUD screen -- Plan 03 Task 11 (list/create/edit/delete). */
export function CounterpartiesPage() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useCounterparties();
  const createMutation = useCreateCounterparty();
  const updateMutation = useUpdateCounterparty();
  const deleteMutation = useDeleteCounterparty();

  const [formState, setFormState] = useState<FormModalState>(null);
  const [deleteTarget, setDeleteTarget] = useState<CounterpartyDto | null>(null);

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
        render: (row) => (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button
              type="button"
              size="compact"
              variant="secondary"
              onClick={() => setFormState({ mode: "edit", counterparty: row })}
            >
              {t("pages.counterparties.edit")}
            </Button>
            <Button
              type="button"
              size="compact"
              variant="destructive"
              onClick={() => setDeleteTarget(row)}
            >
              {t("pages.counterparties.delete")}
            </Button>
          </div>
        ),
      },
    ],
    [t],
  );

  const editingCounterparty = formState?.mode === "edit" ? formState.counterparty : undefined;
  const initialValues: CounterpartyFormValues | undefined = editingCounterparty
    ? {
        name: editingCounterparty.name,
        gln: editingCounterparty.gln,
        inn: editingCounterparty.inn ?? "",
        gs1Prefixes: editingCounterparty.gs1Prefixes.join(", "),
        notes: editingCounterparty.notes ?? "",
      }
    : undefined;

  const handleSubmit = async (input: CreateCounterpartyInput) => {
    const isEdit = formState?.mode === "edit";
    try {
      if (formState?.mode === "edit") {
        await updateMutation.mutateAsync({ id: formState.counterparty.id, input });
        toast("ok", t("pages.counterparties.toasts.updateSuccess"));
      } else {
        await createMutation.mutateAsync(input);
        toast("ok", t("pages.counterparties.toasts.createSuccess"));
      }
      setFormState(null);
    } catch (error) {
      const fallback = isEdit
        ? t("pages.counterparties.toasts.updateError")
        : t("pages.counterparties.toasts.createError");
      toast("error", error instanceof ApiRequestError ? error.message : fallback);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      toast("ok", t("pages.counterparties.toasts.deleteSuccess"));
      setDeleteTarget(null);
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
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.counterparties.title")}
        actions={
          <Button type="button" onClick={() => setFormState({ mode: "create" })}>
            {t("pages.counterparties.addAction")}
          </Button>
        }
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
          action={
            <Button type="button" onClick={() => setFormState({ mode: "create" })}>
              {t("pages.counterparties.addAction")}
            </Button>
          }
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}

      <CounterpartyForm
        open={formState !== null}
        mode={formState?.mode ?? "create"}
        {...(initialValues ? { initialValues } : {})}
        submitting={createMutation.isPending || updateMutation.isPending}
        onSubmit={handleSubmit}
        onClose={() => setFormState(null)}
      />

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t("pages.counterparties.deleteConfirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setDeleteTarget(null)}>
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
        {deleteTarget && (
          <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
            {t("pages.counterparties.deleteConfirmBody", { name: deleteTarget.name })}
          </p>
        )}
      </Modal>
    </div>
  );
}

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, EmptyState, Modal, PageHeader, Spinner, StatusChip, Table } from "@markiro/ui";
import type { StatusChipStatus, TableColumn } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { EmployeeForm, type EmployeeFormValues } from "./EmployeeForm.js";
import {
  useArchiveEmployee,
  useCreateEmployee,
  useEmployees,
  useUpdateEmployee,
  type CreateEmployeeInput,
  type EmployeeDto,
  type EmployeeStatus,
} from "./api.js";

type FormModalState = { mode: "create" } | { mode: "edit"; employee: EmployeeDto } | null;

const STATUS_TO_CHIP: Record<EmployeeStatus, StatusChipStatus> = {
  active: "ok",
  archived: "neutral",
};

/** Admin employees CRUD screen -- Plan A Task 16 (list/create/edit/archive + badge issue/revoke). */
export function EmployeesPage() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useEmployees();
  const createMutation = useCreateEmployee();
  const updateMutation = useUpdateEmployee();
  const archiveMutation = useArchiveEmployee();

  const [formState, setFormState] = useState<FormModalState>(null);
  const [archiveTarget, setArchiveTarget] = useState<EmployeeDto | null>(null);

  const items = data ?? [];

  const columns: TableColumn<EmployeeDto>[] = useMemo(
    () => [
      { key: "fullName", title: t("pages.employees.table.fullName") },
      {
        key: "role",
        title: t("pages.employees.table.role"),
        render: (row) => row.role ?? "—",
      },
      {
        key: "status",
        title: t("pages.employees.table.status"),
        render: (row) => (
          <StatusChip
            status={STATUS_TO_CHIP[row.status]}
            label={t(`pages.employees.status.${row.status}`)}
          />
        ),
      },
      {
        key: "badges",
        title: t("pages.employees.table.badges"),
        align: "right",
        render: (row) => row.badges.filter((badge) => badge.revokedAt === null).length,
      },
      {
        key: "actions",
        title: t("pages.employees.table.actions"),
        align: "right",
        render: (row) => (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button
              type="button"
              size="compact"
              variant="secondary"
              onClick={() => setFormState({ mode: "edit", employee: row })}
            >
              {t("pages.employees.edit")}
            </Button>
            {row.status === "active" && (
              <Button
                type="button"
                size="compact"
                variant="destructive"
                onClick={() => setArchiveTarget(row)}
              >
                {t("pages.employees.archive")}
              </Button>
            )}
          </div>
        ),
      },
    ],
    [t],
  );

  const editingEmployee = formState?.mode === "edit" ? formState.employee : undefined;
  const initialValues: EmployeeFormValues | undefined = editingEmployee
    ? { fullName: editingEmployee.fullName, role: editingEmployee.role ?? "" }
    : undefined;

  const handleSubmit = async (input: CreateEmployeeInput) => {
    const isEdit = formState?.mode === "edit";
    try {
      if (formState?.mode === "edit") {
        await updateMutation.mutateAsync({ id: formState.employee.id, input });
        toast("ok", t("pages.employees.toasts.updateSuccess"));
      } else {
        await createMutation.mutateAsync(input);
        toast("ok", t("pages.employees.toasts.createSuccess"));
      }
      setFormState(null);
    } catch (error) {
      const fallback = isEdit
        ? t("pages.employees.toasts.updateError")
        : t("pages.employees.toasts.createError");
      toast("error", error instanceof ApiRequestError ? error.message : fallback);
    }
  };

  const handleArchive = async () => {
    if (!archiveTarget) return;
    try {
      await archiveMutation.mutateAsync(archiveTarget.id);
      toast("ok", t("pages.employees.toasts.archiveSuccess"));
      setArchiveTarget(null);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.employees.toasts.archiveError"),
      );
    }
  };

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.employees.title")}
        actions={
          <Button type="button" onClick={() => setFormState({ mode: "create" })}>
            {t("pages.employees.addAction")}
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
          title={t("pages.employees.emptyTitle")}
          hint={t("pages.employees.emptyHint")}
          action={
            <Button type="button" onClick={() => setFormState({ mode: "create" })}>
              {t("pages.employees.addAction")}
            </Button>
          }
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}

      <EmployeeForm
        open={formState !== null}
        mode={formState?.mode ?? "create"}
        {...(editingEmployee ? { employee: editingEmployee } : {})}
        {...(initialValues ? { initialValues } : {})}
        submitting={createMutation.isPending || updateMutation.isPending}
        onSubmit={handleSubmit}
        onClose={() => setFormState(null)}
      />

      <Modal
        open={archiveTarget !== null}
        onClose={() => setArchiveTarget(null)}
        closeLabel={t("common.close")}
        title={t("pages.employees.archiveConfirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setArchiveTarget(null)}>
              {t("pages.employees.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={archiveMutation.isPending}
              onClick={() => void handleArchive()}
            >
              {t("pages.employees.archiveConfirmAction")}
            </Button>
          </>
        }
      >
        {archiveTarget && (
          <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
            {t("pages.employees.archiveConfirmBody", { name: archiveTarget.fullName })}
          </p>
        )}
      </Modal>
    </div>
  );
}

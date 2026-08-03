import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  EmptyState,
  Modal,
  PageHeader,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { StatusChipStatus, TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
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

const STATUS_TO_CHIP: Record<EmployeeStatus, StatusChipStatus> = {
  active: "ok",
  archived: "neutral",
};

function AuthorizedCreateEmployeeAction() {
  const { t } = useTranslation();
  const createMutation = useCreateEmployee();
  const [open, setOpen] = useState(false);

  const handleSubmit = async (input: CreateEmployeeInput) => {
    try {
      await createMutation.mutateAsync(input);
      toast("ok", t("pages.employees.toasts.createSuccess"));
      setOpen(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.employees.toasts.createError"),
      );
    }
  };

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t("pages.employees.addAction")}
      </Button>
      {open ? (
        <EmployeeForm
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

function AuthorizedEmployeeRowActions({ employee }: { employee: EmployeeDto }) {
  const { t } = useTranslation();
  const updateMutation = useUpdateEmployee();
  const archiveMutation = useArchiveEmployee();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const initialValues: EmployeeFormValues = {
    fullName: employee.fullName,
    role: employee.role ?? "",
  };

  const handleUpdate = async (input: CreateEmployeeInput) => {
    try {
      await updateMutation.mutateAsync({ id: employee.id, input });
      toast("ok", t("pages.employees.toasts.updateSuccess"));
      setEditing(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.employees.toasts.updateError"),
      );
    }
  };

  const handleArchive = async () => {
    try {
      await archiveMutation.mutateAsync(employee.id);
      toast("ok", t("pages.employees.toasts.archiveSuccess"));
      setArchiving(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.employees.toasts.archiveError"),
      );
    }
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button type="button" size="compact" variant="secondary" onClick={() => setEditing(true)}>
          {t("pages.employees.edit")}
        </Button>
        {employee.status === "active" ? (
          <Button
            type="button"
            size="compact"
            variant="destructive"
            onClick={() => setArchiving(true)}
          >
            {t("pages.employees.archive")}
          </Button>
        ) : null}
      </div>
      <EmployeeForm
        open={editing}
        mode="edit"
        employee={employee}
        initialValues={initialValues}
        submitting={updateMutation.isPending}
        onSubmit={handleUpdate}
        onClose={() => setEditing(false)}
      />
      <Modal
        open={archiving}
        onClose={() => setArchiving(false)}
        closeLabel={t("common.close")}
        title={t("pages.employees.archiveConfirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setArchiving(false)}>
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
        <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
          {t("pages.employees.archiveConfirmBody", { name: employee.fullName })}
        </p>
      </Modal>
    </>
  );
}

/** Admin employees CRUD screen -- Plan A Task 16 (list/create/edit/archive + badge issue/revoke). */
export function EmployeesPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const { data, isPending, isError } = useEmployees();

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
        render: (row) => (canWrite ? <AuthorizedEmployeeRowActions employee={row} /> : null),
      },
    ],
    [t, canWrite],
  );

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.employees.title")}
        actions={canWrite ? <AuthorizedCreateEmployeeAction /> : null}
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
          action={canWrite ? <AuthorizedCreateEmployeeAction /> : null}
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AdminPage,
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  FilterBar,
  PageHeader,
  RowActions,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { SelectOption, StatusChipStatus, TableColumn } from "@markiro/ui";

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
import "./employees.css";

type StatusFilter = "all" | EmployeeStatus;

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
  const [archiveError, setArchiveError] = useState<string | null>(null);
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
      setArchiveError(null);
      await archiveMutation.mutateAsync(employee.id);
      toast("ok", t("pages.employees.toasts.archiveSuccess"));
      setArchiving(false);
    } catch (error) {
      setArchiveError(
        error instanceof ApiRequestError
          ? error.message
          : t("pages.employees.archivePersistentError"),
      );
    }
  };

  return (
    <>
      <RowActions>
        <Button type="button" size="compact" variant="secondary" onClick={() => setEditing(true)}>
          {t("pages.employees.edit")}
        </Button>
        {employee.status === "active" ? (
          <Button
            type="button"
            size="compact"
            variant="destructive"
            onClick={() => {
              setArchiveError(null);
              setArchiving(true);
            }}
          >
            {t("pages.employees.archive")}
          </Button>
        ) : null}
      </RowActions>
      <EmployeeForm
        open={editing}
        mode="edit"
        employee={employee}
        initialValues={initialValues}
        submitting={updateMutation.isPending}
        onSubmit={handleUpdate}
        onClose={() => setEditing(false)}
      />
      <ConfirmDialog
        open={archiving}
        title={t("pages.employees.archiveConfirmTitle")}
        description={t("pages.employees.archiveConfirmBody", { name: employee.fullName })}
        entity={employee.fullName}
        error={archiveError}
        cancelLabel={t("pages.employees.cancel")}
        confirmLabel={t("pages.employees.archiveConfirmAction")}
        tone="destructive"
        busy={archiveMutation.isPending}
        onCancel={() => {
          if (archiveMutation.isPending) return;
          setArchiving(false);
          setArchiveError(null);
        }}
        onConfirm={() => void handleArchive()}
      />
    </>
  );
}

/** Admin employees CRUD screen -- Plan A Task 16 (list/create/edit/archive + badge issue/revoke). */
export function EmployeesPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const [status, setStatus] = useState<StatusFilter>("all");
  const query = useEmployees(status === "all" ? {} : { status });

  const items = query.data ?? [];
  const statusOptions: SelectOption<StatusFilter>[] = [
    { value: "all", label: t("pages.employees.filters.status.all") },
    { value: "active", label: t("pages.employees.filters.status.active") },
    { value: "archived", label: t("pages.employees.filters.status.archived") },
  ];

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
        render: (row) => (
          <span className="mk-employee-badge-count">
            {row.badges.filter((badge) => badge.revokedAt === null).length}
          </span>
        ),
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
    <AdminPage className="mk-employees-page" data-testid="employees-page">
      <PageHeader
        title={t("pages.employees.title")}
        actions={canWrite ? <AuthorizedCreateEmployeeAction /> : null}
      />

      <FilterBar
        label={t("pages.employees.filters.label")}
        resultSummary={
          !query.isPending && !query.isError
            ? t("pages.employees.resultCount", { count: items.length })
            : ""
        }
        {...(status !== "all"
          ? {
              resetLabel: t("pages.employees.filters.reset"),
              onReset: () => setStatus("all"),
            }
          : {})}
      >
        <Select
          className="mk-employees-filter--status"
          label={t("pages.employees.filters.statusLabel")}
          value={status}
          options={statusOptions}
          onValueChange={setStatus}
        />
      </FilterBar>

      {query.isPending ? (
        <div className="mk-employees-section-state">
          <Spinner label={t("common.loading")} />
        </div>
      ) : query.isError ? (
        <div className="mk-employees-section-state">
          <Alert tone="error">{t("common.loadError")}</Alert>
          <div>
            <Button type="button" variant="secondary" onClick={() => void query.refetch()}>
              {t("pages.employees.retry")}
            </Button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title={
            status === "all"
              ? t("pages.employees.emptyTitle")
              : t("pages.employees.filteredEmptyTitle")
          }
          hint={
            status === "all"
              ? t("pages.employees.emptyHint")
              : t("pages.employees.filteredEmptyHint")
          }
          action={status === "all" ? canWrite ? <AuthorizedCreateEmployeeAction /> : null : null}
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}
    </AdminPage>
  );
}

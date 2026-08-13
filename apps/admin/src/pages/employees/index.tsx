import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useNavigate } from "react-router";

import {
  AdminPage,
  Alert,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  FilterBar,
  PageHeader,
  Input,
  RadioGroup,
  RowActions,
  Select,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { SelectOption, StatusChipStatus, TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import {
  useArchiveEmployee,
  useBulkEmployeePickupLimits,
  useBulkEmployeePickupWriteoff,
  useEmployees,
  type EmployeeDto,
  type EmployeePickupLimitMode,
  type EmployeeStatus,
} from "./api.js";
import type { EmployeesPanelContext, EmployeesPanelLocationState } from "./EmployeePanelRoute.js";
import "./employees.css";

type StatusFilter = "all" | EmployeeStatus;

const STATUS_TO_CHIP: Record<EmployeeStatus, StatusChipStatus> = {
  active: "ok",
  archived: "neutral",
};

const TABLE_SKELETON_COLUMNS = ["full-name", "role", "status", "badges", "actions"];
const TABLE_SKELETON_ROWS = ["first", "second", "third"];

export function limitBulkEmployeeSelection(employeeIds: string[]): Set<string> {
  return new Set(employeeIds.slice(0, 500));
}

function EmployeesTableSkeleton({ label }: { label: string }) {
  return (
    <div
      className="mk-employees-table-skeleton"
      role="status"
      aria-label={label}
      aria-live="polite"
      aria-busy="true"
    >
      <span className="mk-visually-hidden">{label}</span>
      <div className="mk-employees-table-skeleton__scroll" aria-hidden="true">
        <table>
          <thead>
            <tr>
              {TABLE_SKELETON_COLUMNS.map((column) => (
                <th key={column}>
                  <span />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TABLE_SKELETON_ROWS.map((row) => (
              <tr key={row}>
                {TABLE_SKELETON_COLUMNS.map((column) => (
                  <td key={column}>
                    <span />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AuthorizedCreateEmployeeAction() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Button
      type="button"
      onClick={() =>
        void navigate("new", {
          state: { employeesBackground: true } satisfies EmployeesPanelLocationState,
        })
      }
    >
      {t("pages.employees.addAction")}
    </Button>
  );
}

function AuthorizedEmployeeRowActions({ employee }: { employee: EmployeeDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const archiveMutation = useArchiveEmployee();
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

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
        <Button
          type="button"
          size="compact"
          variant="secondary"
          onClick={() =>
            void navigate(`${employee.id}/edit`, {
              state: { employeesBackground: true } satisfies EmployeesPanelLocationState,
            })
          }
        >
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
  const [employeesResolved, setEmployeesResolved] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLimitMode, setBulkLimitMode] = useState<EmployeePickupLimitMode>("limited");
  const [bulkDayLimit, setBulkDayLimit] = useState("12");
  const [bulkCanWriteoff, setBulkCanWriteoff] = useState(false);
  const [confirmation, setConfirmation] = useState<"limits" | "writeoff" | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const bulkLimits = useBulkEmployeePickupLimits();
  const bulkWriteoff = useBulkEmployeePickupWriteoff();
  const bulkDayLimitValid = /^[1-9]\d*$/.test(bulkDayLimit);

  useEffect(() => {
    if (query.data !== undefined) setEmployeesResolved(true);
  }, [query.data]);

  const items = query.data ?? [];
  const statusOptions: SelectOption<StatusFilter>[] = [
    { value: "all", label: t("pages.employees.filters.status.all") },
    { value: "active", label: t("pages.employees.filters.status.active") },
    { value: "archived", label: t("pages.employees.filters.status.archived") },
  ];

  const columns: TableColumn<EmployeeDto>[] = useMemo(
    () => [
      ...(bulkMode
        ? [
            {
              key: "select",
              title: "",
              width: 32,
              render: (row: EmployeeDto) => {
                const checked = selectedIds.has(row.id);
                return (
                  <Checkbox
                    label={t("pages.employees.bulk.selectEmployee", { name: row.fullName })}
                    checked={checked}
                    disabled={!checked && selectedIds.size >= 500}
                    onCheckedChange={() =>
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        if (next.has(row.id)) next.delete(row.id);
                        else if (next.size < 500) next.add(row.id);
                        return next;
                      })
                    }
                  />
                );
              },
            } satisfies TableColumn<EmployeeDto>,
          ]
        : []),
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
    [t, canWrite, bulkMode, selectedIds],
  );

  const confirmBulk = async () => {
    if (!confirmation || selectedIds.size === 0 || selectedIds.size > 500) return;
    try {
      setBulkError(null);
      if (confirmation === "limits") {
        await bulkLimits.mutateAsync({
          employeeIds: [...selectedIds],
          limitMode: bulkLimitMode,
          dayLimit: Number(bulkDayLimit),
        });
      } else {
        await bulkWriteoff.mutateAsync({
          employeeIds: [...selectedIds],
          canWriteoff: bulkCanWriteoff,
        });
      }
      setConfirmation(null);
      toast("ok", t("pages.employees.bulk.success"));
    } catch (cause) {
      setBulkError(
        cause instanceof ApiRequestError ? cause.message : t("pages.employees.bulk.error"),
      );
    }
  };

  return (
    <AdminPage className="mk-employees-page" data-testid="employees-page">
      <PageHeader
        title={t("pages.employees.title")}
        actions={
          canWrite ? (
            <div style={{ display: "flex", gap: 8 }}>
              <Button
                type="button"
                variant={bulkMode ? "secondary" : "primary"}
                onClick={() => {
                  setBulkMode((current) => !current);
                  setSelectedIds(new Set());
                }}
              >
                {bulkMode ? t("pages.employees.bulk.cancel") : t("pages.employees.bulk.openAction")}
              </Button>
              {!bulkMode ? <AuthorizedCreateEmployeeAction /> : null}
            </div>
          ) : null
        }
      />

      {bulkMode ? (
        <section className="mk-employees-bulk" aria-label={t("pages.employees.bulk.title")}>
          <span>{t("pages.employees.bulk.selectedCount", { count: selectedIds.size })}</span>
          <div>
            <Button
              type="button"
              size="compact"
              variant="secondary"
              onClick={() =>
                setSelectedIds(limitBulkEmployeeSelection(items.map((employee) => employee.id)))
              }
            >
              {t("pages.employees.bulk.selectFirst")}
            </Button>
          </div>
          {selectedIds.size >= 500 ? (
            <Alert tone="warn">{t("pages.employees.bulk.maxSelection")}</Alert>
          ) : null}
          <div className="mk-employees-bulk__actions">
            <div className="mk-employees-bulk__group">
              <RadioGroup
                label={t("pages.employees.bulk.limitModeLabel")}
                options={[
                  { value: "limited", label: t("pages.employees.pickupPolicy.limited") },
                  { value: "unlimited", label: t("pages.employees.pickupPolicy.unlimited") },
                ]}
                value={bulkLimitMode}
                onValueChange={(value) => setBulkLimitMode(value as EmployeePickupLimitMode)}
              />
              <Input
                label={t("pages.employees.pickupPolicy.dayLimitLabel")}
                value={bulkDayLimit}
                inputMode="numeric"
                {...(!bulkDayLimitValid
                  ? { error: t("pages.employees.pickupPolicy.dayLimitError") }
                  : {})}
                onChange={(event) => setBulkDayLimit(event.target.value)}
              />
              <Button
                type="button"
                disabled={selectedIds.size === 0 || !bulkDayLimitValid}
                onClick={() => setConfirmation("limits")}
              >
                {t("pages.employees.bulk.limitAction")}
              </Button>
            </div>
            <div className="mk-employees-bulk__group">
              <Checkbox
                label={t("pages.employees.bulk.canWriteoffLabel")}
                checked={bulkCanWriteoff}
                onCheckedChange={setBulkCanWriteoff}
              />
              <Button
                type="button"
                disabled={selectedIds.size === 0}
                onClick={() => setConfirmation("writeoff")}
              >
                {t("pages.employees.bulk.writeoffAction")}
              </Button>
            </div>
          </div>
        </section>
      ) : null}

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
        <EmployeesTableSkeleton label={t("common.loading")} />
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
              ? canWrite
                ? t("pages.employees.emptyHint")
                : t("pages.employees.emptyReadOnlyHint")
              : t("pages.employees.filteredEmptyHint")
          }
          action={status === "all" ? canWrite ? <AuthorizedCreateEmployeeAction /> : null : null}
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}

      <Outlet
        context={
          {
            employees: items,
            employeesPending: query.isPending,
            employeesError: query.isError,
            employeesResolved,
            retryPanelData: async () => {
              await query.refetch();
            },
          } satisfies EmployeesPanelContext
        }
      />
      <ConfirmDialog
        open={confirmation !== null}
        title={t(
          confirmation === "limits"
            ? "pages.employees.bulk.limitConfirmTitle"
            : "pages.employees.bulk.writeoffConfirmTitle",
        )}
        description={t(
          confirmation === "limits"
            ? "pages.employees.bulk.limitConfirmBody"
            : "pages.employees.bulk.writeoffConfirmBody",
          { count: selectedIds.size },
        )}
        error={bulkError}
        cancelLabel={t("pages.employees.cancel")}
        confirmLabel={t(
          confirmation === "limits"
            ? "pages.employees.bulk.limitConfirmAction"
            : "pages.employees.bulk.writeoffConfirmAction",
        )}
        busy={bulkLimits.isPending || bulkWriteoff.isPending}
        onCancel={() => {
          if (bulkLimits.isPending || bulkWriteoff.isPending) return;
          setConfirmation(null);
          setBulkError(null);
        }}
        onConfirm={() => void confirmBulk()}
      />
    </AdminPage>
  );
}

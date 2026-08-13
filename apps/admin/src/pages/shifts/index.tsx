import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useNavigate } from "react-router";

import {
  AdminPage,
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DatePicker,
  EmptyState,
  FilterBar,
  Input,
  PageHeader,
  RowActions,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { BadgeTone, SelectOption, StatusChipStatus, TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useProducts } from "../catalog/api.js";
import { useCounterparties } from "../counterparties/api.js";
import { useLabelTemplates } from "../labels/api.js";
import {
  useCloseShift,
  useDeleteShift,
  useLines,
  useShifts,
  type ShiftDto,
  type ShiftStatus,
} from "./api.js";
import { ShiftExportsDialog } from "./ShiftExportsDialog.js";
import type { ShiftsPanelContext, ShiftsPanelLocationState } from "./ShiftPanelRoute.js";
import "./shifts.css";

type StatusFilter = "all" | ShiftStatus;

const STATUS_TO_CHIP: Record<ShiftStatus, StatusChipStatus> = {
  planned: "info",
  active: "ok",
  closed: "neutral",
};

const MODE_TO_BADGE_TONE: Record<ShiftDto["mode"], BadgeTone> = {
  validation: "neutral",
  aggregation: "accent",
};

function AuthorizedCreateShiftAction() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Button
      type="button"
      onClick={() =>
        void navigate("new", {
          state: { shiftsBackground: true } satisfies ShiftsPanelLocationState,
        })
      }
    >
      {t("pages.shifts.addAction")}
    </Button>
  );
}

function AuthorizedPlannedShiftActions({ shift }: { shift: ShiftDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const deleteMutation = useDeleteShift();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    try {
      setDeleteError(null);
      await deleteMutation.mutateAsync(shift.id);
      toast("ok", t("pages.shifts.toasts.deleteSuccess"));
      setDeleting(false);
    } catch (error) {
      setDeleteError(
        error instanceof ApiRequestError ? error.message : t("pages.shifts.toasts.deleteError"),
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
            void navigate(`${shift.id}/edit`, {
              state: { shiftsBackground: true } satisfies ShiftsPanelLocationState,
            })
          }
        >
          {t("pages.shifts.edit")}
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
          {t("pages.shifts.delete")}
        </Button>
      </RowActions>
      <ConfirmDialog
        open={deleting}
        title={t("pages.shifts.deleteConfirmTitle")}
        description={
          <>
            <p>{t("pages.shifts.deleteConfirmBody", { name: shift.productName ?? "" })}</p>
            {deleteError ? <Alert tone="error">{deleteError}</Alert> : null}
          </>
        }
        entity={shift.productName ?? shift.id}
        cancelLabel={t("pages.shifts.cancel")}
        confirmLabel={t("pages.shifts.deleteConfirmAction")}
        tone="destructive"
        busy={deleteMutation.isPending}
        onCancel={() => setDeleting(false)}
        onConfirm={() => void handleDelete()}
      />
    </>
  );
}

function AuthorizedCloseShiftAction({ shift }: { shift: ShiftDto }) {
  const { t } = useTranslation();
  const closeMutation = useCloseShift();
  const [open, setOpen] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [closeError, setCloseError] = useState<string | null>(null);

  const handleCloseShift = async () => {
    try {
      setCloseError(null);
      await closeMutation.mutateAsync({ id: shift.id, reason: closeReason.trim() });
      toast("ok", t("pages.shifts.toasts.closeSuccess"));
      setOpen(false);
      setCloseReason("");
    } catch (error) {
      setCloseError(
        error instanceof ApiRequestError ? error.message : t("pages.shifts.toasts.closeError"),
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
          onClick={() => {
            setCloseError(null);
            setOpen(true);
          }}
        >
          {t("pages.shifts.close")}
        </Button>
      </RowActions>
      <ConfirmDialog
        open={open}
        title={t("pages.shifts.closeModal.title")}
        description={
          <>
            <Input
              label={t("pages.shifts.closeModal.reasonLabel")}
              value={closeReason}
              onChange={(event) => setCloseReason(event.target.value)}
            />
            {closeError ? <Alert tone="error">{closeError}</Alert> : null}
          </>
        }
        entity={shift.productName ?? shift.id}
        cancelLabel={t("pages.shifts.closeModal.cancel")}
        confirmLabel={t("pages.shifts.closeModal.submit")}
        tone="destructive"
        busy={closeMutation.isPending}
        confirmDisabled={closeReason.trim().length < 3}
        onCancel={() => {
          if (closeMutation.isPending) return;
          setOpen(false);
          setCloseReason("");
          setCloseError(null);
        }}
        onConfirm={() => void handleCloseShift()}
      />
    </>
  );
}

function ShiftExportAction({ shift }: { shift: ShiftDto }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <RowActions>
        <Button type="button" size="compact" variant="secondary" onClick={() => setOpen(true)}>
          {t("pages.shifts.exports.action")}
        </Button>
      </RowActions>
      {open ? (
        <ShiftExportsDialog shift={shift} open onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/** Admin shift-planning screen -- Plan 03 Task 13 (list/create/edit/delete/close). */
export function ShiftsPage() {
  const { t, i18n } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const shiftsQuery = useShifts({
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(fromDate ? { from: fromDate } : {}),
    ...(toDate ? { to: toDate } : {}),
  });
  const productsQuery = useProducts();
  const linesQuery = useLines();
  const counterpartiesQuery = useCounterparties();
  const labelTemplatesQuery = useLabelTemplates();

  const items = shiftsQuery.data ?? [];
  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);
  const lines = useMemo(() => linesQuery.data ?? [], [linesQuery.data]);
  const counterparties = useMemo(() => counterpartiesQuery.data ?? [], [counterpartiesQuery.data]);
  const labelTemplates = useMemo(() => labelTemplatesQuery.data ?? [], [labelTemplatesQuery.data]);
  const filtersActive = statusFilter !== "all" || Boolean(fromDate) || Boolean(toDate);

  const statusFilterOptions: SelectOption<StatusFilter>[] = [
    { value: "all", label: t("pages.shifts.filters.status.all") },
    { value: "planned", label: t("pages.shifts.filters.status.planned") },
    { value: "active", label: t("pages.shifts.filters.status.active") },
    { value: "closed", label: t("pages.shifts.filters.status.closed") },
  ];

  const columns: TableColumn<ShiftDto>[] = useMemo(
    () => [
      {
        key: "plannedDate",
        title: t("pages.shifts.table.plannedDate"),
        render: (row) => row.plannedDate ?? "—",
      },
      {
        key: "productName",
        title: t("pages.shifts.table.product"),
        render: (row) => (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span>{row.productName ?? "—"}</span>
            {row.counterpartyName && (
              <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
                {t("pages.shifts.forCounterparty", { name: row.counterpartyName })}
              </span>
            )}
          </div>
        ),
      },
      {
        key: "lineName",
        title: t("pages.shifts.table.line"),
        render: (row) => row.lineName ?? "—",
      },
      {
        key: "mode",
        title: t("pages.shifts.table.mode"),
        render: (row) => (
          <Badge tone={MODE_TO_BADGE_TONE[row.mode]}>{t(`pages.shifts.mode.${row.mode}`)}</Badge>
        ),
      },
      {
        key: "plannedQty",
        title: t("pages.shifts.table.plannedQty"),
        align: "right",
        mono: true,
        render: (row) => row.plannedQty ?? "—",
      },
      {
        key: "status",
        title: t("pages.shifts.table.status"),
        render: (row) => (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <StatusChip
              status={STATUS_TO_CHIP[row.status]}
              label={t(`pages.shifts.status.${row.status}`)}
              {...(row.status === "closed" && row.closeReason ? { title: row.closeReason } : {})}
            />
            {row.status === "closed" && row.closeReason && (
              <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
                {row.closeReason}
              </span>
            )}
            {row.lateDataAt && <Badge tone="warn">{t("pages.shifts.table.lateData")}</Badge>}
          </div>
        ),
      },
      {
        key: "actions",
        title: t("pages.shifts.table.actions"),
        align: "right",
        render: (row) =>
          row.status === "closed" ? (
            <ShiftExportAction shift={row} />
          ) : canWrite ? (
            row.status === "planned" ? (
              <AuthorizedPlannedShiftActions shift={row} />
            ) : row.status === "active" ? (
              <AuthorizedCloseShiftAction shift={row} />
            ) : null
          ) : null,
      },
    ],
    [t, canWrite],
  );

  return (
    <AdminPage className="mk-shifts-page" data-testid="shifts-page">
      <PageHeader
        title={t("pages.shifts.title")}
        actions={canWrite ? <AuthorizedCreateShiftAction /> : null}
      />

      <FilterBar
        label={t("pages.shifts.filters.label")}
        resultSummary={
          !shiftsQuery.isPending && !shiftsQuery.isError
            ? t("pages.shifts.resultCount", { count: items.length })
            : ""
        }
        {...(filtersActive
          ? {
              resetLabel: t("pages.shifts.filters.reset"),
              onReset: () => {
                setStatusFilter("all");
                setFromDate("");
                setToDate("");
              },
            }
          : {})}
      >
        <div className="mk-shifts-filter mk-shifts-filter--status">
          <Select
            label={t("pages.shifts.filters.statusLabel")}
            options={statusFilterOptions}
            value={statusFilter}
            onValueChange={setStatusFilter}
          />
        </div>
        <div className="mk-shifts-filter mk-shifts-filter--date">
          <DatePicker
            label={t("pages.shifts.filters.fromLabel")}
            placeholder={t("common.datePicker.placeholder")}
            clearLabel={t("common.datePicker.clear")}
            calendarLabel={t("common.datePicker.calendar")}
            previousMonthLabel={t("common.datePicker.previousMonth")}
            nextMonthLabel={t("common.datePicker.nextMonth")}
            locale={i18n.language}
            {...(fromDate ? { value: fromDate } : {})}
            onValueChange={(value) => setFromDate(value ?? "")}
          />
        </div>
        <div className="mk-shifts-filter mk-shifts-filter--date">
          <DatePicker
            label={t("pages.shifts.filters.toLabel")}
            placeholder={t("common.datePicker.placeholder")}
            clearLabel={t("common.datePicker.clear")}
            calendarLabel={t("common.datePicker.calendar")}
            previousMonthLabel={t("common.datePicker.previousMonth")}
            nextMonthLabel={t("common.datePicker.nextMonth")}
            locale={i18n.language}
            {...(toDate ? { value: toDate } : {})}
            onValueChange={(value) => setToDate(value ?? "")}
          />
        </div>
      </FilterBar>

      {shiftsQuery.isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : shiftsQuery.isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("pages.shifts.emptyTitle")}
          hint={t("pages.shifts.emptyHint")}
          action={canWrite ? <AuthorizedCreateShiftAction /> : null}
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}
      <Outlet
        context={
          {
            shifts: items,
            products,
            lines,
            counterparties,
            labelTemplates,
            panelPending:
              shiftsQuery.isPending ||
              productsQuery.isPending ||
              linesQuery.isPending ||
              counterpartiesQuery.isPending ||
              labelTemplatesQuery.isPending,
            panelError:
              shiftsQuery.isError ||
              productsQuery.isError ||
              linesQuery.isError ||
              counterpartiesQuery.isError ||
              labelTemplatesQuery.isError,
            retryPanelData: async () => {
              await Promise.all([
                shiftsQuery.refetch(),
                productsQuery.refetch(),
                linesQuery.refetch(),
                counterpartiesQuery.refetch(),
                labelTemplatesQuery.refetch(),
              ]);
            },
          } satisfies ShiftsPanelContext
        }
      />
    </AdminPage>
  );
}

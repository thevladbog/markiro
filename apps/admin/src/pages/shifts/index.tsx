import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useNavigate } from "react-router";

import {
  AdminPage,
  Alert,
  Badge,
  Button,
  DatePicker,
  EmptyState,
  FilterBar,
  PageHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { BadgeTone, SelectOption, StatusChipStatus, TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { formatDate } from "../../lib/datetime.js";
import { useProducts } from "../catalog/api.js";
import { useCounterparties } from "../counterparties/api.js";
import { useLabelTemplates } from "../labels/api.js";
import {
  useLines,
  useShiftPlanningConfig,
  useShifts,
  type ShiftDto,
  type ShiftStatus,
} from "./api.js";
import { localCalendarDate } from "./date.js";
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

function ShiftDetailsAction({ shift }: { shift: ShiftDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Button
      type="button"
      size="compact"
      variant="secondary"
      onClick={() =>
        void navigate(shift.id, {
          state: { shiftsBackground: true } satisfies ShiftsPanelLocationState,
        })
      }
    >
      {t("pages.shifts.details.action")}
    </Button>
  );
}

/** Admin shift-planning screen -- Plan 03 Task 13 (list/create/edit/delete/close). */
export function ShiftsPage() {
  const { t, i18n } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [productionFromDate, setProductionFromDate] = useState("");
  const [productionToDate, setProductionToDate] = useState("");

  const shiftsQuery = useShifts({
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(fromDate ? { from: fromDate } : {}),
    ...(toDate ? { to: toDate } : {}),
    ...(productionFromDate ? { productionFrom: productionFromDate } : {}),
    ...(productionToDate ? { productionTo: productionToDate } : {}),
  });
  // "all" keeps an archived product's name resolvable when editing an old
  // shift; the ShiftForm combobox disables archived options for creation.
  const productsQuery = useProducts({ archived: "all" });
  const linesQuery = useLines();
  const counterpartiesQuery = useCounterparties();
  const labelTemplatesQuery = useLabelTemplates();
  const planningConfigQuery = useShiftPlanningConfig();

  const items = shiftsQuery.data ?? [];
  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);
  const lines = useMemo(() => linesQuery.data ?? [], [linesQuery.data]);
  const counterparties = useMemo(() => counterpartiesQuery.data ?? [], [counterpartiesQuery.data]);
  const labelTemplates = useMemo(() => labelTemplatesQuery.data ?? [], [labelTemplatesQuery.data]);
  const filtersActive =
    statusFilter !== "all" ||
    Boolean(fromDate) ||
    Boolean(toDate) ||
    Boolean(productionFromDate) ||
    Boolean(productionToDate);

  const statusFilterOptions: SelectOption<StatusFilter>[] = [
    { value: "all", label: t("pages.shifts.filters.status.all") },
    { value: "planned", label: t("pages.shifts.filters.status.planned") },
    { value: "active", label: t("pages.shifts.filters.status.active") },
    { value: "closed", label: t("pages.shifts.filters.status.closed") },
  ];

  const columns: TableColumn<ShiftDto>[] = useMemo(
    () => [
      {
        key: "shift",
        title: t("pages.shifts.table.shift"),
        width: "18%",
        wrap: true,
        render: (row) => {
          const plannedDate = row.plannedDate ?? localCalendarDate(row.openedAt);
          const productionDate = row.productionDate ?? row.plannedDate;
          return (
            <div className="mk-shifts-table__stack">
              <strong className="font-mono">{row.number}</strong>
              <span className="mk-shifts-table__date">
                <span>{t("pages.shifts.table.plannedDateShort")}:</span>
                <time>{plannedDate ? formatDate(plannedDate, i18n.language) : "—"}</time>
              </span>
              <span className="mk-shifts-table__date">
                <span>{t("pages.shifts.table.productionDateShort")}:</span>
                <time>{productionDate ? formatDate(productionDate, i18n.language) : "—"}</time>
              </span>
            </div>
          );
        },
      },
      {
        key: "productName",
        title: t("pages.shifts.table.product"),
        width: "32%",
        wrap: true,
        render: (row) => (
          <div className="mk-shifts-table__stack mk-shifts-table__product">
            <span>{row.productName ?? "—"}</span>
            {row.counterpartyName && (
              <span>{t("pages.shifts.forCounterparty", { name: row.counterpartyName })}</span>
            )}
          </div>
        ),
      },
      {
        key: "production",
        title: t("pages.shifts.table.production"),
        width: "20%",
        wrap: true,
        render: (row) => (
          <div className="mk-shifts-table__stack">
            <span>{row.lineName ?? "—"}</span>
            <Badge tone={MODE_TO_BADGE_TONE[row.mode]}>{t(`pages.shifts.mode.${row.mode}`)}</Badge>
          </div>
        ),
      },
      {
        key: "planStatus",
        title: t("pages.shifts.table.planStatus"),
        width: "20%",
        wrap: true,
        render: (row) => (
          <div className="mk-shifts-table__stack">
            <strong className="font-mono">{row.plannedQty ?? "—"}</strong>
            <span>{t("pages.shifts.table.plannedQty")}</span>
            <StatusChip
              status={STATUS_TO_CHIP[row.status]}
              label={t(`pages.shifts.status.${row.status}`)}
              {...(row.status === "closed" && row.closeReason ? { title: row.closeReason } : {})}
            />
            {row.status === "closed" && row.closeReason && <span>{row.closeReason}</span>}
            {row.lateDataAt && <Badge tone="warn">{t("pages.shifts.table.lateData")}</Badge>}
          </div>
        ),
      },
      {
        key: "actions",
        title: t("pages.shifts.table.actions"),
        width: "128px",
        align: "right",
        render: (row) => <ShiftDetailsAction shift={row} />,
      },
    ],
    [t, i18n.language],
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
                setProductionFromDate("");
                setProductionToDate("");
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
        <div className="mk-shifts-filter mk-shifts-filter--date">
          <DatePicker
            label={t("pages.shifts.filters.productionFromLabel")}
            placeholder={t("common.datePicker.placeholder")}
            clearLabel={t("common.datePicker.clear")}
            calendarLabel={t("common.datePicker.calendar")}
            previousMonthLabel={t("common.datePicker.previousMonth")}
            nextMonthLabel={t("common.datePicker.nextMonth")}
            locale={i18n.language}
            {...(productionFromDate ? { value: productionFromDate } : {})}
            onValueChange={(value) => setProductionFromDate(value ?? "")}
          />
        </div>
        <div className="mk-shifts-filter mk-shifts-filter--date">
          <DatePicker
            label={t("pages.shifts.filters.productionToLabel")}
            placeholder={t("common.datePicker.placeholder")}
            clearLabel={t("common.datePicker.clear")}
            calendarLabel={t("common.datePicker.calendar")}
            previousMonthLabel={t("common.datePicker.previousMonth")}
            nextMonthLabel={t("common.datePicker.nextMonth")}
            locale={i18n.language}
            {...(productionToDate ? { value: productionToDate } : {})}
            onValueChange={(value) => setProductionToDate(value ?? "")}
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
        <Table className="mk-shifts-table" columns={columns} rows={items} />
      )}
      <Outlet
        context={
          {
            shifts: items,
            products,
            lines,
            counterparties,
            labelTemplates,
            defaultBoxLabelTemplateId: planningConfigQuery.data?.defaultBoxLabelTemplateId ?? null,
            panelPending:
              shiftsQuery.isPending ||
              productsQuery.isPending ||
              linesQuery.isPending ||
              counterpartiesQuery.isPending ||
              labelTemplatesQuery.isPending ||
              planningConfigQuery.isPending,
            panelError:
              shiftsQuery.isError ||
              productsQuery.isError ||
              linesQuery.isError ||
              counterpartiesQuery.isError ||
              labelTemplatesQuery.isError ||
              planningConfigQuery.isError,
            retryPanelData: async () => {
              await Promise.all([
                shiftsQuery.refetch(),
                productsQuery.refetch(),
                linesQuery.refetch(),
                counterpartiesQuery.refetch(),
                labelTemplatesQuery.refetch(),
                planningConfigQuery.refetch(),
              ]);
            },
          } satisfies ShiftsPanelContext
        }
      />
    </AdminPage>
  );
}

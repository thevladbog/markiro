import { isShiftCloseReasonCode } from "@markiro/domain";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";

import {
  Alert,
  Badge,
  Button,
  Input,
  PageHeader,
  Select,
  StatusChip,
  type BadgeTone,
  type TableColumn,
  type TagPhase,
} from "@markiro/ui";

import type { ShiftPeriod } from "../../host/api.js";
import type { OfficeShift, ShiftMode, ShiftStatus } from "../../host/protocol.js";
import { shiftProductTitle } from "../../lib/shift-product.js";
import { useCan } from "../access.js";
import { searchableSelect } from "../select-search.js";
import { useTemplates } from "../catalog-queries.js";
import { DemoBadge } from "../demo/DemoBadge.js";
import { isDemoShift } from "../demo/demo.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficeIcon } from "../OfficeIcon.js";
import { listViewState } from "../list/list-state.js";
import { DateRange, ListCard, ListFilters } from "../list/ListCard.js";
import { ListEmpty, ListError, ListNothing, ListSkeleton } from "../list/ListStates.js";
import { RowActionBar, type RowMenuItem } from "../list/RowActionBar.js";
import { SortToggle } from "../list/SortToggle.js";
import { StateFilter } from "../list/StateFilter.js";
import { PagedTable } from "../paging/PagedTable.js";
import { activeFirstByName } from "../records.js";
import { civilToday } from "../../lib/civil-date.js";
import {
  beyondPeriod,
  civilDateLabel,
  findShifts,
  openBlocker,
  periodState,
  recordLabel,
  sortShifts,
  totalShifts,
  type PeriodState,
  type ShiftSortDir,
  type ShiftSortKey,
  type ShiftStatusFilter,
} from "./shift-list.js";
import { shiftCardPath } from "./shift-card.js";
import { ShiftDrawer } from "./ShiftDrawer.js";
import { CloseShiftDialog } from "./CloseShiftDialog.js";
import { CloseReasonDialog } from "./CloseReasonDialog.js";
import { DeleteShiftDialog } from "./DeleteShiftDialog.js";
import { ShiftCreateDrawer } from "./ShiftEditor.js";
import { ShiftPlanDialog } from "./ShiftPlanDialog.js";
import { ShiftTotalsDialog } from "./ShiftTotalsDialog.js";
import { ShiftSourceLinks } from "./CloudShifts.js";
import { ShiftMarks } from "./ShiftMarks.js";
import { isSharedShift } from "./participation.js";
import { shiftOutput } from "./shift-text.js";

/**
 * The export dialog comes with the domain's renderers, the source rules and the
 * check of every format: a chunk of its own, read when «Выгрузка» is first pressed.
 */
const ExportDialog = lazy(() =>
  import("../exports/ExportDialog.js").then((module) => ({ default: module.ExportDialog })),
);

/** A status in its phase, after the cloud's `SHIFT_STATUS_TO_PHASE`. */
const STATUS_PHASE = {
  planned: "planned",
  active: "active",
  closed: "done",
} as const satisfies Record<ShiftStatus, TagPhase>;

/** A mode's category tone, the cloud's `SHIFT_MODE_TO_TONE`: one mode, one colour in both products. */
const MODE_TONE = {
  validation: "violet",
  aggregation: "teal",
} as const satisfies Record<ShiftMode, BadgeTone>;

const STATUS_FILTERS: readonly ShiftStatusFilter[] = ["all", "planned", "active", "closed"];

/** Units with the thousands apart by a no-break space, as Russian writes counts: «1 200». */
const UNITS = new Intl.NumberFormat("ru");

type ShiftsDialog =
  | { kind: "create" }
  | { kind: "plan"; shift: OfficeShift }
  | { kind: "delete"; shift: OfficeShift }
  | { kind: "close"; shift: OfficeShift }
  | { kind: "reason"; shift: OfficeShift }
  | { kind: "totals"; shift: OfficeShift }
  | { kind: "export"; shift: OfficeShift };

/**
 * Shifts (stage 2a spec §5.6), in the section «Производство». The host sends
 * the planned and active shifts and the closed ones of the last 31 days, or
 * every shift of a chosen period, and with either every shift closed without
 * its reason (`beyondPeriod`); the filters, the search and the pages work
 * here. A shift names its product, line and counterparty by id, and the page
 * names them from its own lists; a list that does not load leaves the shifts
 * in place, named by the first characters of their ids.
 */
export function ShiftsPage() {
  const { t } = useTranslation();
  const canPlan = useCan("planShifts");
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  // The shift whose drawer is open is the link's `?shift=`, so a card can be linked to and the
  // list behind it keeps its filters, its sort and its page.
  const openShiftId = params.get("shift");
  const [sort, setSort] = useState<{ key: ShiftSortKey; dir: ShiftSortDir } | null>(null);
  const [dialog, setDialog] = useState<ShiftsDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeId = useId();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // The period of shift dates («Дата смены», beta 3): asked of the host beside the production one.
  const [plannedFrom, setPlannedFrom] = useState("");
  const [plannedTo, setPlannedTo] = useState("");
  const [status, setStatus] = useState<ShiftStatusFilter>("all");
  const [lineId, setLineId] = useState("");
  const [search, setSearch] = useState("");
  const period = periodState(from, to);
  const plannedPeriod = periodState(plannedFrom, plannedTo);
  // The periods last asked for change only to ready ones or back to none (set while
  // rendering, React's way to follow a value from an earlier render), so while either
  // period is incomplete or wrong the list stays the one it was.
  const [asked, setAsked] = useState<ShiftPeriod | null>(null);
  const usable = (state: PeriodState) => state.kind === "ready" || state.kind === "none";
  if (usable(period) && usable(plannedPeriod)) {
    const wanted: ShiftPeriod = {
      ...(period.kind === "ready" ? { from: period.from, to: period.to } : {}),
      ...(plannedPeriod.kind === "ready"
        ? { plannedFrom: plannedPeriod.from, plannedTo: plannedPeriod.to }
        : {}),
    };
    const none = Object.keys(wanted).length === 0;
    const same =
      asked === null
        ? none
        : asked.from === wanted.from &&
          asked.to === wanted.to &&
          asked.plannedFrom === wanted.plannedFrom &&
          asked.plannedTo === wanted.plannedTo;
    if (!same) setAsked(none ? null : wanted);
  }
  // The filters stay once the list has loaded, though a new period is read again behind them: a
  // filter bar that vanished under the user's hand would also lose what they were typing.
  const [filtersShown, setFiltersShown] = useState(false);
  const shifts = useOfficeQuery(officeKeys.shiftList(asked), (api, token) =>
    asked === null ? api.listShifts(token) : api.listShifts(token, asked),
  );
  if (shifts.isSuccess && !filtersShown) setFiltersShown(true);
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
  );
  const templates = useTemplates();
  const lookups = [products, lines, counterparties, templates];

  const open = (next: ShiftsDialog) => {
    setNotice(null);
    setDialog(next);
  };
  /** After a write: every list of shifts is read again, whatever its period. */
  const readAgain = () => void queryClient.invalidateQueries({ queryKey: officeKeys.shifts });
  const saved = (message: string) => {
    setDialog(null);
    setNotice(message);
    readAgain();
  };
  const reload = () => {
    setDialog(null);
    readAgain();
  };

  // After a write the dialog is gone and the button that opened it may be too (a deleted or
  // closed shift's row): the notice takes the focus, so it is read and the keyboard is not lost.
  useEffect(() => {
    if (notice !== null) document.getElementById(noticeId)?.focus();
  }, [notice, noticeId]);

  const productName = (shift: OfficeShift) =>
    recordLabel("product", products.data, shift.productId, t);
  /** The product as the list names it in its first line: the full name, marked when archived. */
  const fullProductName = (shift: OfficeShift) => {
    const product = products.data?.find((each) => each.id === shift.productId);
    if (product === undefined) return productName(shift);
    return product.archived
      ? t("office.common.archivedName", { name: product.name })
      : product.name;
  };
  /** The name the labels carry, for the second line, when it says more than the first. */
  const printTitle = (shift: OfficeShift) => {
    const product = products.data?.find((each) => each.id === shift.productId);
    if (product === undefined) return null;
    const title = shiftProductTitle(product);
    return title === product.name ? null : title;
  };
  // What the search reads: the product's own names (full and print), not the id-start or the archive mark the list
  // shows in its place.
  const searchName = (shift: OfficeShift) => {
    const product = products.data?.find((each) => each.id === shift.productId);
    return product === undefined ? "" : `${product.name}\n${shiftProductTitle(product)}`;
  };
  const filtersOn =
    from !== "" ||
    to !== "" ||
    plannedFrom !== "" ||
    plannedTo !== "" ||
    status !== "all" ||
    lineId !== "" ||
    search.trim() !== "";
  const resetFilters = () => {
    setFrom("");
    setTo("");
    setPlannedFrom("");
    setPlannedTo("");
    setStatus("all");
    setLineId("");
    setSearch("");
  };
  const periodMessage = (state: PeriodState) =>
    state.kind === "reversed"
      ? t("office.shifts.period.reversed")
      : state.kind === "too_long"
        ? t("office.shifts.period.tooLong")
        : undefined;
  const periodError = periodMessage(period);
  const plannedPeriodError = periodMessage(plannedPeriod);
  // The shifts the filters keep, in the host's order; none while the list is not loaded.
  const filtered = shifts.isSuccess
    ? findShifts(shifts.data, { status, lineId, search }, searchName)
    : [];
  const found =
    sort === null
      ? filtered
      : sortShifts(filtered, sort.key, sort.dir, {
          line: (shift) => lines.data?.find((each) => each.id === shift.lineId)?.name ?? "",
          // The column sorts by what it shows: the print name, else the name.
          product: (shift) =>
            shiftProductTitle(products.data?.find((each) => each.id === shift.productId)),
        });
  // The host adds every shift owing a close reason whatever the period (spec §12.9): it is listed
  // and filtered like any, but the totals stay the period's and a note says why it is there.
  const hostToday = civilToday("UTC");
  const beyond = filtered.filter((shift) => beyondPeriod(shift, asked, hostToday));
  const totals = totalShifts(filtered.filter((shift) => !beyond.includes(shift)));
  const onSort = (key: string) => {
    setSort((previous) => ({
      key: key as ShiftSortKey,
      dir: previous?.key === key && previous.dir === "asc" ? "desc" : "asc",
    }));
  };
  const closeDrawer = () =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("shift");
        next.delete("tab");
        next.delete("box");
        return next;
      },
      { replace: true },
    );

  const sortToggle = (key: ShiftSortKey, label: string, ariaLabel: string) => (
    <SortToggle
      label={label}
      ariaLabel={ariaLabel}
      active={sort?.key === key}
      dir={sort?.dir ?? "asc"}
      onToggle={() => onSort(key)}
    />
  );

  const columns: TableColumn<OfficeShift>[] = [
    {
      key: "number",
      sortable: true,
      title: t("office.shifts.table.number"),
      mono: true,
      // The number opens the shift's card (plan О-Ф).
      render: (shift) => (
        <span className="shift-cell">
          <Link
            to={shiftCardPath(shift.id)}
            aria-label={t("office.shifts.cardNamed", { number: shift.number })}
          >
            {shift.number}
          </Link>
          {isDemoShift(shift, products.data) && <DemoBadge />}
        </span>
      ),
    },
    {
      // The product and, under it, the name its labels carry and the counterparty it is made for.
      key: "product",
      sortable: true,
      title: t("office.shifts.table.productAndPrint"),
      wrap: true,
      minWidth: 220,
      render: (shift) => {
        const print = printTitle(shift);
        return (
          <span className="shift-cell">
            <span className="shift-cell__name">{fullProductName(shift)}</span>
            {(print !== null || shift.counterpartyId !== null) && (
              <span className="shift-cell__quiet shift-cell__sub">
                {print !== null && (
                  <span>{t("office.products.printNameShort", { name: print })}</span>
                )}
                {print !== null && shift.counterpartyId !== null && (
                  <span aria-hidden="true"> · </span>
                )}
                {shift.counterpartyId !== null && (
                  <span>
                    {t("office.shifts.forCounterparty", {
                      name: recordLabel(
                        "counterparty",
                        counterparties.data,
                        shift.counterpartyId,
                        t,
                      ),
                    })}
                  </span>
                )}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: "line",
      sortable: true,
      title: t("office.shifts.table.line"),
      wrap: true,
      minWidth: 110,
      render: (shift) => recordLabel("line", lines.data, shift.lineId, t),
    },
    {
      // Both dates, one over the other: the production date and the shift's own (beta 3).
      key: "dates",
      title: (
        <span className="office-th-sorts">
          <span>{t("office.shifts.table.dates")}</span>
          {sortToggle(
            "productionDate",
            t("office.shifts.table.productionDateShort"),
            t("office.shifts.sortBy", { name: t("office.shifts.table.productionDate") }),
          )}
          {sortToggle(
            "plannedDate",
            t("office.shifts.table.plannedDateShort"),
            t("office.shifts.sortBy", { name: t("office.shifts.table.plannedDate") }),
          )}
        </span>
      ),
      mono: true,
      wrap: true,
      minWidth: 150,
      render: (shift) => (
        <span className="shift-cell">
          <span>
            <span className="shift-cell__quiet">{t("office.shifts.dateTags.production")} </span>
            {civilDateLabel(shift.productionDate)}
          </span>
          <span>
            <span className="shift-cell__quiet">{t("office.shifts.dateTags.shift")} </span>
            {civilDateLabel(shift.plannedDate)}
          </span>
        </span>
      ),
    },
    {
      key: "status",
      sortable: true,
      title: t("office.shifts.table.statusAndMode"),
      wrap: true,
      minWidth: 200,
      render: (shift) => {
        const blocker = openBlocker(shift, products.data, templates.data);
        return (
          <span className="shift-cell">
            <StatusChip
              phase={STATUS_PHASE[shift.status]}
              label={t(`office.shifts.statuses.${shift.status}`)}
            />
            <Badge tone={MODE_TONE[shift.mode]}>{t(`office.shifts.modes.${shift.mode}`)}</Badge>
            {blocker !== null && (
              // A sentence, not a chip: a long warning in a chip is a tall box in a narrow column.
              <span className="shift-cell__warn">
                <span aria-hidden="true">!</span>
                <span>{t(`office.shifts.blockers.${blocker}`)}</span>
              </span>
            )}
            {shift.lateDataAt !== null && (
              <StatusChip phase="attention" label={t("office.shifts.lateData")} />
            )}
            <ShiftMarks shift={shift} />
            {shift.closeReasonText !== null && (
              <span className="shift-cell__quiet">
                {t("office.shifts.closedByOffice", { reason: shift.closeReasonText })}
              </span>
            )}
            {shift.closeReasonCode !== null && (
              <span className="shift-cell__quiet">
                {t("office.shifts.closeReason", {
                  // A code a newer host adds is shown as it is.
                  reason: isShiftCloseReasonCode(shift.closeReasonCode)
                    ? t(`office.shifts.closeReasons.${shift.closeReasonCode}`)
                    : shift.closeReasonCode,
                })}
              </span>
            )}
          </span>
        );
      },
    },
    {
      // What the shift put in closed boxes, as the cloud's list shows it, and under it the plan; a planned
      // shift has no output yet.
      key: "output",
      sortable: true,
      title: (
        <span className="office-th-sorts">
          <span>{t("office.shifts.table.output")}</span>
          {sortToggle(
            "plannedQty",
            t("office.shifts.table.plannedQtyShort"),
            t("office.shifts.sortBy", { name: t("office.shifts.table.plannedQty") }),
          )}
        </span>
      ),
      mono: true,
      align: "right",
      minWidth: 130,
      render: (shift) => (
        <span className="shift-cell shift-cell--end">
          <span>{shiftOutput(shift, t)}</span>
          <span className="shift-cell__quiet">
            {t("office.shifts.planLine", {
              plan:
                shift.plannedQty === null
                  ? t("office.common.none")
                  : UNITS.format(shift.plannedQty),
            })}
          </span>
        </span>
      ),
    },
    // Every role reads a shift's figures; the writes are `planShifts`.
    {
      key: "actions",
      stickyEnd: true,
      title: t("office.shifts.table.actions"),
      render: (shift) => {
        const named = { number: shift.number };
        const items: RowMenuItem[] = [];
        if (canPlan && shift.status === "active") {
          items.push({
            key: "plan",
            label: t("office.shifts.plan"),
            ariaLabel: t("office.shifts.planNamed", named),
            icon: "sliders",
            onSelect: () => open({ kind: "plan", shift }),
          });
        }
        // Every role exports (the cloud's `OPERATIONS_READ`, plan ЧЗ); a shift to come has nothing yet.
        if (shift.status !== "planned") {
          items.push({
            key: "export",
            label: t("office.shifts.export"),
            ariaLabel: t("office.shifts.exportNamed", named),
            icon: "download",
            onSelect: () => open({ kind: "export", shift }),
          });
        }
        if (canPlan && shift.status === "active") {
          // A shift several devices entered is closed whole: the office says so.
          const whole = isSharedShift(shift);
          items.push({
            key: "close",
            label: t(whole ? "office.shifts.closeAll" : "office.shifts.close"),
            ariaLabel: t(whole ? "office.shifts.closeAllNamed" : "office.shifts.closeNamed", named),
            icon: "stop",
            destructive: true,
            onSelect: () => open({ kind: "close", shift }),
          });
        }
        // A shared shift its devices closed without the reason the plan's gap needed (spec §12.9).
        if (canPlan && shift.status === "closed" && shift.closeReasonMissing === true) {
          items.push({
            key: "reason",
            label: t("office.shifts.supplyReason"),
            ariaLabel: t("office.shifts.supplyReasonNamed", named),
            icon: "pencil",
            onSelect: () => open({ kind: "reason", shift }),
          });
        }
        if (canPlan && shift.status === "planned") {
          items.push({
            key: "delete",
            label: t("office.shifts.delete"),
            ariaLabel: t("office.shifts.deleteNamed", named),
            icon: "trash",
            destructive: true,
            onSelect: () => open({ kind: "delete", shift }),
          });
        }
        return (
          <RowActionBar
            actions={[
              shift.status !== "planned"
                ? {
                    key: "totals",
                    label: t("office.shifts.totalsNamed", named),
                    icon: "list",
                    onSelect: () => open({ kind: "totals", shift }),
                  }
                : {
                    // A planned shift's fields are its card's: «Открыть» shows them, and «Изменить»
                    // there turns them into the form.
                    key: "open",
                    label: t("office.shifts.openNamed", named),
                    icon: "eye",
                    onSelect: () => setParams({ shift: shift.id }),
                  },
            ]}
            {...(items.length === 0
              ? {}
              : { menu: { label: t("office.common.rowActions", { name: shift.number }), items } })}
          />
        );
      },
    },
  ];

  const view = listViewState({
    pending: shifts.isPending,
    failed: shifts.isError,
    total: shifts.data?.length ?? 0,
    found: found.length,
  });
  const state =
    view === "loading" ? (
      <ListSkeleton />
    ) : view === "error" ? (
      <ListError
        error={shifts.error}
        onRetry={() => {
          void shifts.refetch();
          // One click recovers the names too when they failed as well.
          for (const lookup of lookups) if (lookup.isError) void lookup.refetch();
        }}
      />
    ) : view === "empty" ? (
      <ListEmpty
        icon="calendarCheck"
        title={t("office.shifts.empty")}
        hint={t("office.shifts.emptyHint")}
        {...(canPlan
          ? {
              action: (
                <Button
                  icon={<OfficeIcon name="plus" size={20} />}
                  onClick={() => open({ kind: "create" })}
                >
                  {t("office.shifts.add")}
                </Button>
              ),
            }
          : {})}
      />
    ) : view === "nothing" ? (
      <ListNothing title={t("office.shifts.nothingFound")} onReset={resetFilters} />
    ) : null;
  const periodNote =
    period.kind === "partial" || plannedPeriod.kind === "partial"
      ? t("office.shifts.period.partial")
      : asked === null
        ? t("office.shifts.period.recent")
        : asked.from !== undefined && asked.plannedFrom !== undefined
          ? t("office.shifts.period.shownBoth", {
              from: civilDateLabel(asked.from),
              to: civilDateLabel(asked.to ?? asked.from),
              plannedFrom: civilDateLabel(asked.plannedFrom),
              plannedTo: civilDateLabel(asked.plannedTo ?? asked.plannedFrom),
            })
          : asked.plannedFrom !== undefined
            ? t("office.shifts.period.shownPlanned", {
                from: civilDateLabel(asked.plannedFrom),
                to: civilDateLabel(asked.plannedTo ?? asked.plannedFrom),
              })
            : t("office.shifts.period.shown", {
                from: civilDateLabel(asked.from ?? ""),
                to: civilDateLabel(asked.to ?? ""),
              });

  const content = (
    <ListCard>
      {filtersShown && (
        <ListFilters
          label={t("office.shifts.filters")}
          resultSummary={
            shifts.isSuccess
              ? t("office.shifts.found", { shown: found.length, total: shifts.data.length })
              : ""
          }
          onReset={filtersOn ? resetFilters : undefined}
        >
          <Input
            label={t("office.shifts.search")}
            placeholder={t("office.shifts.searchHint")}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
          <StateFilter
            label={t("office.shifts.statusFilter")}
            options={STATUS_FILTERS.map((value) => ({
              value,
              label: t(`office.shifts.statusFilters.${value}`),
            }))}
            value={status}
            onChange={setStatus}
          />
          <Select
            {...searchableSelect(t)}
            label={t("office.shifts.lineFilter")}
            options={[
              { value: "", label: t("office.shifts.allLines") },
              ...activeFirstByName(lines.data ?? []).map((line) => ({
                value: line.id,
                label: line.archived
                  ? t("office.common.archivedName", { name: line.name })
                  : line.name,
              })),
            ]}
            value={lineId}
            onValueChange={(value) => {
              setLineId(value);
            }}
          />
          <DateRange
            label={t("office.shifts.period.productionLabel")}
            fromLabel={t("office.shifts.period.from")}
            toLabel={t("office.shifts.period.to")}
            from={from}
            to={to}
            onFrom={setFrom}
            onTo={setTo}
            error={periodError}
          />
          <DateRange
            label={t("office.shifts.period.plannedLabel")}
            fromLabel={t("office.shifts.period.plannedFrom")}
            toLabel={t("office.shifts.period.plannedTo")}
            from={plannedFrom}
            to={plannedTo}
            onFrom={setPlannedFrom}
            onTo={setPlannedTo}
            error={plannedPeriodError}
          />
        </ListFilters>
      )}
      {filtersShown && (
        <div className="office-list-notes">
          <p className="office-list-note" aria-live="polite">
            {periodNote}
          </p>
          {beyond.length > 0 && (
            <p className="office-list-note" aria-live="polite">
              {t("office.shifts.period.reasonMissingBeyond", { number: beyond.length })}
            </p>
          )}
          {shifts.isSuccess && (
            // What the filters keep, however many pages: the figures of the period.
            <p className="office-list-note shift-totals" aria-live="polite">
              {t("office.shifts.totalsRow.line", {
                shifts: UNITS.format(totals.shifts),
                units: UNITS.format(totals.units),
                boxes: UNITS.format(totals.boxes),
                pallets: UNITS.format(totals.pallets),
              })}
            </p>
          )}
        </div>
      )}
      <PagedTable
        tableId="shifts"
        pagerLabel={t("office.shifts.pager")}
        resetKey={JSON.stringify([from, to, plannedFrom, plannedTo, status, lineId, search, sort])}
        columns={columns}
        sortKey={sort?.key ?? ""}
        sortDir={sort?.dir ?? "asc"}
        onSort={onSort}
        onRowClick={(shift) => setParams({ shift: shift.id })}
        rows={found}
        getRowKey={(shift) => shift.id}
        empty={state}
        scrollLabel={t("office.shifts.title")}
      />
    </ListCard>
  );

  return (
    <>
      <PageHeader
        title={t("office.shifts.title")}
        description={t("office.shifts.subtitle")}
        actions={
          canPlan ? (
            <Button onClick={() => open({ kind: "create" })}>{t("office.shifts.add")}</Button>
          ) : null
        }
      />
      <ShiftSourceLinks />
      {notice && (
        <Alert tone="ok" id={noticeId} tabIndex={-1}>
          {notice}
        </Alert>
      )}
      {/* About the names and the marks: with no list on screen the shifts' error stands alone. */}
      {shifts.isSuccess && lookups.some((lookup) => lookup.isError) && (
        <Alert
          tone="warn"
          action={
            <Button
              variant="secondary"
              size="compact"
              onClick={() => {
                for (const lookup of lookups) if (lookup.isError) void lookup.refetch();
              }}
            >
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.shifts.lookupsFailed")}
        </Alert>
      )}
      {content}
      {openShiftId !== null && openShiftId !== "" && (
        <ShiftDrawer key={openShiftId} id={openShiftId} onClose={closeDrawer} />
      )}
      {canPlan && dialog?.kind === "create" && (
        <ShiftCreateDrawer
          onClose={() => setDialog(null)}
          onSaved={(shift) => saved(t("office.shifts.created", { number: shift.number }))}
          onReload={reload}
          onOutdated={readAgain}
        />
      )}
      {canPlan && dialog?.kind === "delete" && (
        <DeleteShiftDialog
          shift={dialog.shift}
          productName={productName(dialog.shift)}
          onClose={() => setDialog(null)}
          onDeleted={() => saved(t("office.shifts.deleted", { number: dialog.shift.number }))}
          onReload={reload}
          onOutdated={readAgain}
        />
      )}
      {canPlan && dialog?.kind === "close" && (
        <CloseShiftDialog
          shift={dialog.shift}
          onClose={() => setDialog(null)}
          onClosed={(shift) => saved(t("office.shifts.closed", { number: shift.number }))}
          onReload={reload}
          onOutdated={readAgain}
        />
      )}
      {canPlan && dialog?.kind === "reason" && (
        <CloseReasonDialog
          shift={dialog.shift}
          onClose={() => setDialog(null)}
          onSaved={(shift) => saved(t("office.shifts.reasonSaved", { number: shift.number }))}
          onReload={reload}
          onOutdated={readAgain}
        />
      )}
      {dialog?.kind === "totals" && (
        <ShiftTotalsDialog shift={dialog.shift} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "export" && (
        <Suspense fallback={null}>
          <ExportDialog
            shift={dialog.shift}
            demo={isDemoShift(dialog.shift, products.data)}
            onClose={() => setDialog(null)}
          />
        </Suspense>
      )}
      {canPlan && dialog?.kind === "plan" && (
        <ShiftPlanDialog
          shift={dialog.shift}
          onClose={() => setDialog(null)}
          onSaved={() => saved(t("office.common.saved"))}
          onReload={reload}
          onOutdated={readAgain}
        />
      )}
    </>
  );
}

import { isShiftCloseReasonCode } from "@markiro/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  DatePicker,
  FilterBar,
  Input,
  PageHeader,
  RowActions,
  Select,
  StatusChip,
  Table,
  type BadgeTone,
  type TableColumn,
  type TagPhase,
} from "@markiro/ui";

import type { OfficeShift, ShiftMode, ShiftStatus } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { useTemplates } from "../catalog-queries.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName } from "../records.js";
import {
  civilDateLabel,
  findShifts,
  openBlocker,
  periodState,
  recordLabel,
  SHIFT_PAGE_SIZE,
  type ShiftStatusFilter,
} from "./shift-list.js";
import { CloseShiftDialog } from "./CloseShiftDialog.js";
import { DeleteShiftDialog } from "./DeleteShiftDialog.js";
import { ShiftDialog } from "./ShiftDialog.js";
import { ShiftPlanDialog } from "./ShiftPlanDialog.js";
import { ShiftTotalsDialog } from "./ShiftTotalsDialog.js";
import { datePickerTexts } from "./shift-text.js";

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
  | { kind: "edit"; shift: OfficeShift }
  | { kind: "plan"; shift: OfficeShift }
  | { kind: "delete"; shift: OfficeShift }
  | { kind: "close"; shift: OfficeShift }
  | { kind: "totals"; shift: OfficeShift };

/**
 * Shifts (stage 2a spec §5.6), in the section «Производство». The host sends
 * the planned and active shifts and the closed ones of the last 31 days, or
 * every shift of a chosen period; the filters, the search and the pages work
 * here. A shift names its product, line and counterparty by id, and the page
 * names them from its own lists; a list that does not load leaves the shifts
 * in place, named by the first characters of their ids.
 */
export function ShiftsPage() {
  const { t } = useTranslation();
  const canPlan = useCan("planShifts");
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<ShiftsDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeId = useId();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState<ShiftStatusFilter>("all");
  const [lineId, setLineId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const period = periodState(from, to);
  // The period last asked for changes only to a ready period or back to none
  // (set while rendering, React's way to follow a value from an earlier render),
  // so while the period is incomplete or wrong the list stays the one it was.
  const [asked, setAsked] = useState<{ from: string; to: string } | null>(null);
  if (period.kind === "ready" && (asked?.from !== period.from || asked.to !== period.to)) {
    setAsked({ from: period.from, to: period.to });
  } else if (period.kind === "none" && asked !== null) {
    setAsked(null);
  }
  const shifts = useOfficeQuery(officeKeys.shiftList(asked), (api, token) =>
    asked === null ? api.listShifts(token) : api.listShifts(token, asked),
  );
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
  // What the search reads: the product's own name, not the id-start or the archive mark the list
  // shows in its place.
  const searchName = (shift: OfficeShift) =>
    products.data?.find((each) => each.id === shift.productId)?.name ?? "";
  const filtersOn =
    from !== "" || to !== "" || status !== "all" || lineId !== "" || search.trim() !== "";
  const resetFilters = () => {
    setFrom("");
    setTo("");
    setStatus("all");
    setLineId("");
    setSearch("");
    setPage(1);
  };
  const periodError =
    period.kind === "reversed"
      ? t("office.shifts.period.reversed")
      : period.kind === "too_long"
        ? t("office.shifts.period.tooLong")
        : undefined;
  // The shifts the filters keep, in the host's order; none while the list is not loaded.
  const found = shifts.isSuccess
    ? findShifts(shifts.data, { status, lineId, search }, searchName)
    : [];

  const columns: TableColumn<OfficeShift>[] = [
    {
      key: "number",
      title: t("office.shifts.table.number"),
      mono: true,
      render: (shift) => shift.number,
    },
    {
      key: "productionDate",
      title: t("office.shifts.table.productionDate"),
      mono: true,
      render: (shift) => civilDateLabel(shift.productionDate),
    },
    {
      key: "line",
      title: t("office.shifts.table.line"),
      wrap: true,
      render: (shift) => recordLabel("line", lines.data, shift.lineId, t),
    },
    {
      key: "product",
      title: t("office.shifts.table.product"),
      wrap: true,
      render: (shift) => (
        <span className="shift-cell">
          <span>{productName(shift)}</span>
          {shift.counterpartyId !== null && (
            <span className="shift-cell__quiet">
              {t("office.shifts.forCounterparty", {
                name: recordLabel("counterparty", counterparties.data, shift.counterpartyId, t),
              })}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "mode",
      title: t("office.shifts.table.mode"),
      render: (shift) => (
        <Badge tone={MODE_TONE[shift.mode]}>{t(`office.shifts.modes.${shift.mode}`)}</Badge>
      ),
    },
    {
      key: "plannedQty",
      title: t("office.shifts.table.plannedQty"),
      mono: true,
      align: "right",
      render: (shift) =>
        shift.plannedQty === null ? t("office.common.none") : UNITS.format(shift.plannedQty),
    },
    {
      key: "status",
      title: t("office.shifts.table.status"),
      wrap: true,
      render: (shift) => {
        const blocker = openBlocker(shift, products.data, templates.data);
        return (
          <span className="shift-cell">
            <StatusChip
              phase={STATUS_PHASE[shift.status]}
              label={t(`office.shifts.statuses.${shift.status}`)}
            />
            {blocker !== null && (
              <StatusChip phase="attention" wrap label={t(`office.shifts.blockers.${blocker}`)} />
            )}
            {shift.lateDataAt !== null && (
              <StatusChip phase="attention" label={t("office.shifts.lateData")} />
            )}
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
      // What the shift put in closed boxes, as the cloud's list shows it; a planned shift has none.
      // After the status, so the columns before it keep their places.
      key: "output",
      title: t("office.shifts.table.output"),
      mono: true,
      align: "right",
      render: (shift) =>
        shift.status === "planned"
          ? t("office.common.none")
          : t("office.shifts.output", {
              units: UNITS.format(shift.totals.unitsInClosedBoxes),
              boxes: UNITS.format(shift.totals.closedBoxes),
            }),
    },
    // Every role reads a shift's figures; the writes are `planShifts`.
    {
      key: "actions",
      title: t("office.shifts.table.actions"),
      render: (shift) => (
        <RowActions>
          {shift.status !== "planned" && (
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shifts.totalsNamed", { number: shift.number })}
              onClick={() => open({ kind: "totals", shift })}
            >
              {t("office.shifts.totalsAction")}
            </Button>
          )}
          {canPlan && shift.status === "planned" && (
            <>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.editNamed", { number: shift.number })}
                onClick={() => open({ kind: "edit", shift })}
              >
                {t("office.shifts.edit")}
              </Button>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.deleteNamed", { number: shift.number })}
                onClick={() => open({ kind: "delete", shift })}
              >
                {t("office.shifts.delete")}
              </Button>
            </>
          )}
          {canPlan && shift.status === "active" && (
            <>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.planNamed", { number: shift.number })}
                onClick={() => open({ kind: "plan", shift })}
              >
                {t("office.shifts.plan")}
              </Button>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.closeNamed", { number: shift.number })}
                onClick={() => open({ kind: "close", shift })}
              >
                {t("office.shifts.close")}
              </Button>
            </>
          )}
        </RowActions>
      ),
    },
  ];

  const content = () => {
    if (shifts.isPending) return <PageLoading />;
    if (shifts.isError) {
      return (
        <LoadError
          error={shifts.error}
          onRetry={() => {
            void shifts.refetch();
            // One click recovers the names too when they failed as well.
            for (const lookup of lookups) if (lookup.isError) void lookup.refetch();
          }}
        />
      );
    }
    const pageCount = Math.max(1, Math.ceil(found.length / SHIFT_PAGE_SIZE));
    // A shorter list never shows an empty page.
    const shown = Math.min(page, pageCount);
    return (
      <Card>
        <Table
          columns={columns}
          rows={found.slice((shown - 1) * SHIFT_PAGE_SIZE, shown * SHIFT_PAGE_SIZE)}
          getRowKey={(shift) => shift.id}
          empty={t(shifts.data.length === 0 ? "office.shifts.empty" : "office.shifts.nothingFound")}
          scrollLabel={t("office.shifts.title")}
        />
        {pageCount > 1 && (
          <OfficePager
            label={t("office.shifts.pager")}
            page={shown}
            pageCount={pageCount}
            onPage={setPage}
          />
        )}
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.shifts.title")}
        actions={
          canPlan ? (
            <Button onClick={() => open({ kind: "create" })}>{t("office.shifts.add")}</Button>
          ) : null
        }
      />
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
      <FilterBar
        label={t("office.shifts.filters")}
        resultSummary={
          shifts.isSuccess
            ? t("office.shifts.found", {
                shown: found.length,
                total: shifts.data.length,
              })
            : ""
        }
        {...(filtersOn ? { resetLabel: t("office.shifts.reset"), onReset: resetFilters } : {})}
      >
        <Input
          label={t("office.shifts.search")}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
        <Select
          native
          label={t("office.shifts.statusFilter")}
          options={STATUS_FILTERS.map((value) => ({
            value,
            label: t(`office.shifts.statusFilters.${value}`),
          }))}
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
        <Select
          native
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
            setPage(1);
          }}
        />
        <DatePicker
          label={t("office.shifts.period.from")}
          {...datePickerTexts(t)}
          {...(from === "" ? {} : { value: from })}
          onValueChange={(value) => {
            setFrom(value ?? "");
            setPage(1);
          }}
        />
        <DatePicker
          label={t("office.shifts.period.to")}
          {...datePickerTexts(t)}
          {...(to === "" ? {} : { value: to })}
          {...(periodError === undefined ? {} : { error: periodError })}
          onValueChange={(value) => {
            setTo(value ?? "");
            setPage(1);
          }}
        />
      </FilterBar>
      <p className="office-note" aria-live="polite">
        {period.kind === "partial"
          ? t("office.shifts.period.partial")
          : asked === null
            ? t("office.shifts.period.recent")
            : t("office.shifts.period.shown", {
                from: civilDateLabel(asked.from),
                to: civilDateLabel(asked.to),
              })}
      </p>
      {content()}
      {canPlan && (dialog?.kind === "create" || dialog?.kind === "edit") && (
        <ShiftDialog
          shift={dialog.kind === "edit" ? dialog.shift : null}
          onClose={() => setDialog(null)}
          onSaved={(shift) =>
            saved(
              dialog.kind === "create"
                ? t("office.shifts.created", { number: shift.number })
                : t("office.common.saved"),
            )
          }
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
      {dialog?.kind === "totals" && (
        <ShiftTotalsDialog shift={dialog.shift} onClose={() => setDialog(null)} />
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

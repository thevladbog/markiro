import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatSsccHri } from "@markiro/domain";
import { Alert, Badge, EmptyState, PageHeader, Select, Spinner, Table } from "@markiro/ui";
import type { SelectOption, TableColumn } from "@markiro/ui";

import { formatCreatedAt, formatDate } from "../../lib/datetime.js";
import { useEmployees } from "../employees/api.js";
import { useShifts, type ShiftDto } from "../shifts/api.js";
import { useBoxes, type BoxDto } from "./api.js";

/**
 * Cabinet-only per-shift box list (Task 14): unlike `/conflicts`, `GET
 * /boxes` has no "all shifts" server query to fall back to -- a box list
 * only ever makes sense scoped to one shift -- so the shift filter here has
 * no "all" option, and the page auto-selects the most recently created shift
 * once `GET /shifts` resolves, rather than starting on an empty state a
 * manager would have to clear first.
 *
 * `contentsChangedAfterClose` (see `apps/api/src/modules/boxes/dto.ts`) is
 * the only way a manager learns a closed, taped-and-labelled box is short an
 * item -- it cannot be corrected, only noted -- so it renders as a warning
 * badge rather than a silent column.
 */
export function BoxesPage() {
  const { t, i18n } = useTranslation();

  const [shiftFilter, setShiftFilter] = useState<string>("");

  const { data: shiftsData } = useShifts();
  const shifts = shiftsData ?? [];

  // Newest-first is `GET /shifts`'s ordering (see shiftFilterOptions below);
  // shifts[0] here is oldest, so the LAST entry is the newest -- the shift a
  // manager most likely wants to see boxes for on first load.
  useEffect(() => {
    if (shiftFilter === "" && shifts.length > 0) {
      setShiftFilter(shifts[shifts.length - 1]!.id);
    }
  }, [shiftFilter, shifts]);

  const { data, isPending, isError } = useBoxes(shiftFilter || undefined);
  const { data: employeesData } = useEmployees();
  const employees = employeesData ?? [];

  const items = data ?? [];

  const employeesById = useMemo(
    () => new Map(employees.map((employee) => [employee.id, employee])),
    [employees],
  );

  // Same reversal as the conflicts page's shift filter: `GET /shifts`
  // returns oldest-first, but a manager opening this page wants the shift
  // they are currently working at the top of the dropdown.
  const shiftFilterOptions: SelectOption[] = useMemo(
    () =>
      [...shifts]
        .reverse()
        .map((shift) => ({ value: shift.id, label: shiftLabel(shift, i18n.language) })),
    [shifts, i18n.language],
  );

  const columns: TableColumn<BoxDto>[] = useMemo(
    () => [
      {
        key: "sscc",
        title: t("pages.boxes.table.sscc"),
        mono: true,
        render: (row) => (row.sscc ? formatSsccHri(row.sscc) : "—"),
      },
      {
        key: "lineName",
        title: t("pages.boxes.table.line"),
        render: (row) => row.lineName ?? "—",
      },
      {
        key: "operatorId",
        title: t("pages.boxes.table.operator"),
        render: (row) => {
          if (!row.operatorId) return "—";
          const employee = employeesById.get(row.operatorId);
          return employee ? employee.fullName : row.operatorId;
        },
      },
      {
        key: "itemCount",
        title: t("pages.boxes.table.itemCount"),
        align: "right",
        render: (row) => row.itemCount,
      },
      {
        key: "closedAt",
        title: t("pages.boxes.table.closedAt"),
        render: (row) => (row.closedAt ? formatCreatedAt(row.closedAt, i18n.language) : "—"),
      },
      {
        key: "status",
        title: t("pages.boxes.table.status"),
        render: (row) =>
          row.contentsChangedAfterClose ? (
            <Badge tone="warn">{t("pages.boxes.contentsChangedAfterClose")}</Badge>
          ) : null,
      },
    ],
    [t, i18n.language, employeesById],
  );

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.boxes.title")} />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div style={{ width: "min(100%, 440px)" }}>
          <Select
            label={t("pages.boxes.filters.shiftLabel")}
            options={shiftFilterOptions}
            value={shiftFilter}
            onValueChange={setShiftFilter}
            searchable
            searchLabel={t("pages.boxes.filters.searchLabel")}
          />
        </div>
      </div>

      {!shiftFilter ? (
        <EmptyState title={t("pages.boxes.selectShift")} />
      ) : isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState title={t("pages.boxes.empty")} />
      ) : (
        <Table columns={columns} rows={items} />
      )}
    </div>
  );
}

/** Short, human-identifiable label for a shift filter option -- mirrors conflicts/index.tsx's. */
function shiftLabel(shift: ShiftDto, language: string): string {
  const date = shift.plannedDate ? formatDate(shift.plannedDate, language) : null;
  if (date && shift.productName) return `${date} — ${shift.productName}`;
  return shift.productName ?? date ?? shift.id;
}

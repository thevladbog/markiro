import type { TFunction } from "i18next";

import type {
  CounterpartyRecord,
  LabelTemplateSummary,
  OfficeLine,
  OfficeProduct,
  OfficeShift,
  ShiftStatus,
} from "../../host/protocol.js";
import { civilDaysBetween, isCivilDate } from "../../lib/civil-date.js";
import { templateFitsSlot } from "../../lib/template-eligibility.js";

/** What the status filter keeps. */
export type ShiftStatusFilter = "all" | ShiftStatus;

/** The longest period the list asks the host for, in days with both ends. */
export const MAX_PERIOD_DAYS = 366;

/** A civil date as the list writes it: `08.10.2026`. */
export function civilDateLabel(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day ?? ""}.${month ?? ""}.${year ?? ""}`;
}

/** The kinds of record a shift names by id. */
type NamedKind = "product" | "line" | "counterparty";

/**
 * How the list names a record a shift points to: its name, marked when it is
 * archived; while its list is not loaded, or when the list lacks it, the first
 * eight characters of its id.
 */
export function recordLabel(
  kind: NamedKind,
  records: readonly (OfficeProduct | OfficeLine | CounterpartyRecord)[] | undefined,
  id: string,
  t: TFunction,
): string {
  const record = records?.find((each) => each.id === id);
  if (record === undefined) return t(`office.shifts.unknown.${kind}`, { id: id.slice(0, 8) });
  return record.archived ? t("office.common.archivedName", { name: record.name }) : record.name;
}

/** Why a planned shift will not open on a station (`shift.open` refuses it). */
export type OpenBlocker =
  | "product_archived"
  | "product_draft"
  | "template_unfit"
  | "pallet_template_unfit"
  | "duplicate_template_unfit";

/**
 * Why a planned shift would be refused when a station opens it, by the lists
 * the office read: its product archived or a draft (`product_inactive`), its
 * box template switched off, narrowed or no longer of the product's group
 * (`template_not_fit`), its pallet template so too (`pallet_template_not_fit`,
 * plan О-Ф), the template of the duplicate it prints so too
 * (`duplicate_template_not_fit`, plan РЕЖ part B), in the host's order.
 * `null` when it opens, or while a list it needs is not loaded or lacks the
 * record: then nothing is claimed.
 */
export function openBlocker(
  shift: Pick<
    OfficeShift,
    "status" | "productId" | "boxTemplateId" | "palletTemplateId" | "validationPrint"
  >,
  products: readonly OfficeProduct[] | undefined,
  templates: readonly LabelTemplateSummary[] | undefined,
): OpenBlocker | null {
  if (shift.status !== "planned") return null;
  const product = products?.find((each) => each.id === shift.productId);
  if (product === undefined) return null;
  if (product.archived) return "product_archived";
  if (product.status !== "active") return "product_draft";
  const template = templates?.find((each) => each.id === shift.boxTemplateId);
  if (template === undefined) return null;
  const fits = templateFitsSlot(template, {
    purpose: "box",
    chzProductGroupCode: product.chzProductGroupCode,
  });
  if (!fits) return "template_unfit";
  const pallet = templates?.find((each) => each.id === shift.palletTemplateId);
  if (
    pallet !== undefined &&
    !templateFitsSlot(pallet, {
      purpose: "pallet",
      chzProductGroupCode: product.chzProductGroupCode,
    })
  ) {
    return "pallet_template_unfit";
  }
  const print = shift.validationPrint;
  if (print?.mode !== "duplicate_dm") return null;
  const duplicate = templates?.find((each) => each.id === print.templateId);
  if (duplicate === undefined) return null;
  const duplicateFits = templateFitsSlot(duplicate, {
    purpose: "product_duplicate",
    chzProductGroupCode: product.chzProductGroupCode,
  });
  return duplicateFits ? null : "duplicate_template_unfit";
}

/** What the filters of the list hold. */
export interface ShiftFilters {
  status: ShiftStatusFilter;
  /** `""` for every line. */
  lineId: string;
  search: string;
}

/**
 * The shifts the filters keep, in the host's order: the status, the line, and
 * a search for the text in the number or the product's name, without case.
 * `productName` is the product's own name for the search: not the start of
 * its id or a mark that the list shows when the name is missing or archived.
 */
export function findShifts(
  shifts: readonly OfficeShift[],
  filters: ShiftFilters,
  productName: (shift: OfficeShift) => string,
): OfficeShift[] {
  const text = filters.search.trim().toLocaleLowerCase("ru");
  return shifts.filter(
    (shift) =>
      (filters.status === "all" || shift.status === filters.status) &&
      (filters.lineId === "" || shift.lineId === filters.lineId) &&
      (text === "" ||
        shift.number.toLocaleLowerCase("ru").includes(text) ||
        productName(shift).toLocaleLowerCase("ru").includes(text)),
  );
}

/** A period the list can ask for, or why it cannot. */
export type PeriodState =
  | { kind: "none" }
  | { kind: "partial" }
  | { kind: "reversed" }
  | { kind: "too_long" }
  | { kind: "ready"; from: string; to: string };

/**
 * The period of production dates the two date fields give: none while both
 * are empty (the host's own list), `partial` while one is empty, `reversed`
 * when it ends before it starts, `too_long` beyond `MAX_PERIOD_DAYS` days
 * with both ends, otherwise ready to send.
 */
export function periodState(from: string, to: string): PeriodState {
  if (from === "" && to === "") return { kind: "none" };
  if (!isCivilDate(from) || !isCivilDate(to)) return { kind: "partial" };
  const days = civilDaysBetween(from, to);
  if (days < 0) return { kind: "reversed" };
  if (days + 1 > MAX_PERIOD_DAYS) return { kind: "too_long" };
  return { kind: "ready", from, to };
}

/** The columns of the list the office sorts by; the others (mode, marks, actions) have no order worth keeping. */
export type ShiftSortKey =
  | "number"
  | "productionDate"
  | "plannedDate"
  | "line"
  | "product"
  | "plannedQty"
  | "status"
  | "output";
export type ShiftSortDir = "asc" | "desc";

const STATUS_ORDER: Record<ShiftStatus, number> = { planned: 0, active: 1, closed: 2 };

/** What a shift output (boxes aside): a validation shift's accepted codes, else the codes in closed boxes. */
export function shiftUnits(shift: Pick<OfficeShift, "mode" | "totals">): number {
  return shift.mode === "validation" ? shift.totals.acceptedUnits : shift.totals.unitsInClosedBoxes;
}

/**
 * The shifts in the order of a column: a copy, stable (equal keys keep the host's order).
 * `names` gives the line's and the product's own names; numbers compare as numbers
 * («OCT26-010» after «OCT26-004»), a missing plan sorts last in both directions.
 */
export function sortShifts(
  shifts: readonly OfficeShift[],
  key: ShiftSortKey,
  dir: ShiftSortDir,
  names: { line: (shift: OfficeShift) => string; product: (shift: OfficeShift) => string },
): OfficeShift[] {
  const sign = dir === "asc" ? 1 : -1;
  const text = (a: string, b: string) => a.localeCompare(b, "ru", { numeric: true });
  const number = (a: number, b: number) => a - b;
  const compare = (a: OfficeShift, b: OfficeShift): number => {
    switch (key) {
      case "number":
        return sign * text(a.number, b.number);
      case "productionDate":
        return sign * text(a.productionDate, b.productionDate);
      case "plannedDate":
        return sign * text(a.plannedDate, b.plannedDate);
      case "line":
        return sign * text(names.line(a), names.line(b));
      case "product":
        return sign * text(names.product(a), names.product(b));
      case "status":
        return sign * number(STATUS_ORDER[a.status], STATUS_ORDER[b.status]);
      case "output":
        return sign * number(shiftUnits(a), shiftUnits(b));
      case "plannedQty": {
        // A shift without a plan goes last whichever way the column runs.
        if (a.plannedQty === null || b.plannedQty === null) {
          return a.plannedQty === b.plannedQty ? 0 : a.plannedQty === null ? 1 : -1;
        }
        return sign * number(a.plannedQty, b.plannedQty);
      }
    }
  };
  return shifts
    .map((shift, index) => ({ shift, index }))
    .sort((a, b) => compare(a.shift, b.shift) || a.index - b.index)
    .map(({ shift }) => shift);
}

/** The totals row of the list: what the shifts it keeps put in closed boxes and on closed pallets. */
export interface ShiftListTotals {
  shifts: number;
  units: number;
  boxes: number;
  pallets: number;
}

export function totalShifts(shifts: readonly OfficeShift[]): ShiftListTotals {
  const sum: ShiftListTotals = { shifts: shifts.length, units: 0, boxes: 0, pallets: 0 };
  for (const shift of shifts) {
    if (shift.status === "planned") continue;
    sum.units += shiftUnits(shift);
    sum.boxes += shift.totals.closedBoxes;
    sum.pallets += shift.totals.closedPallets;
  }
  return sum;
}

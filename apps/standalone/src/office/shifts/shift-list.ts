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

/** Rows on one page of the list. */
export const SHIFT_PAGE_SIZE = 25;

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
export type OpenBlocker = "product_archived" | "product_draft" | "template_unfit";

/**
 * Why a planned shift would be refused when a station opens it, by the lists
 * the office read: its product archived or a draft (`product_inactive`), its
 * box template switched off, narrowed or no longer of the product's group
 * (`template_not_fit`). `null` when it opens, or while a list it needs is not
 * loaded or lacks the record: then nothing is claimed.
 */
export function openBlocker(
  shift: Pick<OfficeShift, "status" | "productId" | "boxTemplateId">,
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
  return fits ? null : "template_unfit";
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
 * `productName` names a shift's product as the list shows it.
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

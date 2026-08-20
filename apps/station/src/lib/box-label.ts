import type { LabelField } from "@markiro/domain";

export interface BoxLabelInput {
  sscc: string;
  itemCount: number;
  productName: string;
  gtin14: string;
  egaisCode: string | null;
  shelfLifeDays: number | null;
  operatorName: string | null;
  counterpartyName: string | null;
  closedAt: string;
  /** `AUG26-003/S`; null when the mirror predates the shift-number sync. */
  shiftNumber: string | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * The LOCAL calendar date of a stored UTC instant, as `YYYY-MM-DD`.
 *
 * Project rule: storage keeps every timestamp in UTC, devices and web show
 * LOCAL dates. A box label is read by a human standing next to the station,
 * so the day it prints is the station's own day — `Date`'s local getters
 * resolve that against the device's configured timezone (`process.env.TZ`
 * under Node, the OS zone on a real station).
 *
 * Returns "" for anything `Date` cannot parse: a label must never fail to
 * print because of a date.
 */
export function localIsoDate(instant: string): string {
  const when = new Date(instant);
  if (Number.isNaN(when.getTime())) return "";
  return `${pad(when.getFullYear(), 4)}-${pad(when.getMonth() + 1, 2)}-${pad(when.getDate(), 2)}`;
}

/**
 * Plain calendar-day addition on a `YYYY-MM-DD` string — no timezone is
 * involved at any point.
 *
 * The arithmetic runs in UTC deliberately: UTC has no DST, so "+184 days"
 * is always exactly 184 midnights and a daylight-saving transition inside
 * the window can never shift the printed day by one. Doing the same with
 * local-time `Date` math would.
 *
 * Returns "" for a malformed or non-existent date (e.g. `2025-02-30`).
 */
export function addCalendarDays(isoDate: string, days: number): string {
  const parts = ISO_DATE.exec(isoDate);
  if (!parts) return "";
  const [, year, month, day] = parts;
  const base = new Date(0);
  base.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(base.getTime())) return "";
  // Reject dates that do not exist and silently rolled over (2025-02-30).
  if (base.getUTCMonth() !== Number(month) - 1 || base.getUTCDate() !== Number(day)) return "";
  base.setUTCDate(base.getUTCDate() + days);
  if (Number.isNaN(base.getTime())) return "";
  return `${pad(base.getUTCFullYear(), 4)}-${pad(base.getUTCMonth() + 1, 2)}-${pad(base.getUTCDate(), 2)}`;
}

/**
 * «Годен до» = production date (the box's LOCAL close date) + the product's
 * shelf life in days, formatted exactly like the `date` field (YYYY-MM-DD).
 *
 * Composed from the two pure pieces above: instant → local day, then a
 * calendar-day addition that no timezone can perturb.
 */
export function expiryIsoDate(closedAt: string, shelfLifeDays: number | null): string {
  if (shelfLifeDays === null || !Number.isInteger(shelfLifeDays) || shelfLifeDays <= 0) return "";
  return addCalendarDays(localIsoDate(closedAt), shelfLifeDays);
}

/**
 * The field record a box label is rendered from.
 *
 * `sscc` is the BARE 18 digits. The application identifier `(00)` is added
 * by the emitter and nowhere else: storing or transporting it would get an
 * export to «Честный знак» rejected.
 *
 * `date`/`expiry` are the human-readable LOCAL calendar dates of the box's
 * close instant. `input.closedAt` itself stays the stored UTC ISO instant —
 * only the rendering is local, and no machine-readable export reads these
 * two fields.
 */
export function boxLabelFields(input: BoxLabelInput): Record<LabelField, string> {
  return {
    "product.name": input.productName,
    "product.gtin": input.gtin14,
    "product.egais": input.egaisCode ?? "",
    "km.code": "",
    sscc: input.sscc,
    "shift.no": input.shiftNumber ?? "",
    date: localIsoDate(input.closedAt),
    expiry: expiryIsoDate(input.closedAt, input.shelfLifeDays),
    qty: String(input.itemCount),
    operator: input.operatorName ?? "",
    "counterparty.name": input.counterpartyName ?? "",
  };
}

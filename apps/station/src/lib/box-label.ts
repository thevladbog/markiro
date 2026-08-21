import { formatLabelDate, type LabelField } from "@markiro/domain";

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
  productionDate: string | null;
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
  const yearNumber = Number(year);
  if (yearNumber < 1 || yearNumber > 9999) return "";
  const base = new Date(0);
  base.setUTCFullYear(yearNumber, Number(month) - 1, Number(day));
  if (Number.isNaN(base.getTime())) return "";
  // Reject dates that do not exist and silently rolled over (2025-02-30).
  if (base.getUTCMonth() !== Number(month) - 1 || base.getUTCDate() !== Number(day)) return "";
  base.setUTCDate(base.getUTCDate() + days);
  if (Number.isNaN(base.getTime())) return "";
  if (base.getUTCFullYear() < 1 || base.getUTCFullYear() > 9999) return "";
  return `${pad(base.getUTCFullYear(), 4)}-${pad(base.getUTCMonth() + 1, 2)}-${pad(base.getUTCDate(), 2)}`;
}

/**
 * The declared production date when present; otherwise the box's LOCAL
 * calendar close date. An invalid declared date returns "" rather than
 * falling back and hiding corrupt mirrored data.
 */
export function effectiveProductionIsoDate(
  closedAt: string,
  productionDate: string | null,
): string {
  if (productionDate !== null) return addCalendarDays(productionDate, 0);
  return localIsoDate(closedAt);
}

/**
 * «Годен до» = the effective production date + the product's shelf life in
 * days, as a `YYYY-MM-DD` calendar date.
 *
 * The effective date is either a validated declared day or instant → local
 * day, followed by a calendar-day addition that no timezone can perturb. It
 * stays ISO on purpose — this is the ARITHMETIC layer, and `boxLabelFields`
 * below is the one place that turns it into the printed `дд.мм.гггг`.
 */
export function expiryIsoDate(
  closedAt: string,
  shelfLifeDays: number | null,
  productionDate: string | null = null,
): string {
  if (shelfLifeDays === null || !Number.isInteger(shelfLifeDays) || shelfLifeDays <= 0) return "";
  return addCalendarDays(effectiveProductionIsoDate(closedAt, productionDate), shelfLifeDays);
}

/**
 * The field record a box label is rendered from.
 *
 * `sscc` is the BARE 18 digits. The application identifier `(00)` is added
 * by the emitter and nowhere else: storing or transporting it would get an
 * export to «Честный знак» rejected.
 *
 * `date`/`expiry` are the human-readable effective production date and its
 * shelf-life expiry, in the printed `дд.мм.гггг` form — this is the BOUNDARY
 * where `@markiro/domain`'s `formatLabelDate` is applied, and the admin
 * preview's `sampleLabelData()` applies the same function to its own samples
 * so the two can never disagree. Everything upstream (`localIsoDate`,
 * `addCalendarDays`, `expiryIsoDate`) stays on `YYYY-MM-DD` because that is
 * what the calendar arithmetic needs, and `input.closedAt` itself stays the
 * stored UTC ISO instant — only the rendering is local and reformatted, and
 * no machine-readable export reads these two fields.
 */
export function boxLabelFields(input: BoxLabelInput): Record<LabelField, string> {
  const effectiveDate = effectiveProductionIsoDate(input.closedAt, input.productionDate);
  const effectiveExpiry =
    input.shelfLifeDays !== null && Number.isInteger(input.shelfLifeDays) && input.shelfLifeDays > 0
      ? addCalendarDays(effectiveDate, input.shelfLifeDays)
      : "";

  return {
    "product.name": input.productName,
    "product.gtin": input.gtin14,
    "product.egais": input.egaisCode ?? "",
    "km.code": "",
    sscc: input.sscc,
    "shift.no": input.shiftNumber ?? "",
    date: formatLabelDate(effectiveDate),
    expiry: formatLabelDate(effectiveExpiry),
    qty: String(input.itemCount),
    operator: input.operatorName ?? "",
    "counterparty.name": input.counterpartyName ?? "",
  };
}

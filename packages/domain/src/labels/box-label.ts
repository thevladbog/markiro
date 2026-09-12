import { formatLabelDate } from "./date.js";
import type { LabelField } from "./model.js";
import { addCalendarDays, shelfLifeExpiryDate } from "./shelf-life.js";

export interface BoxLabelInput {
  sscc: string;
  itemCount: number;
  productName: string;
  /** The catalog's short print name; null falls back to `productName`. */
  productPrintName: string | null;
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

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * The LOCAL calendar date of a stored UTC instant, as `YYYY-MM-DD`.
 *
 * Project rule: storage keeps every timestamp in UTC, devices and web show
 * LOCAL dates. A box label is read by a human standing next to the device that
 * printed it, so the day it prints is that device's own day — `Date`'s local
 * getters resolve that against the configured timezone (`process.env.TZ` under
 * Node, the OS zone on a real station or handheld).
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
 * «Годен до» is the last usable day, inclusive: effective production date
 * + (shelf life in days - 1), as a `YYYY-MM-DD` calendar date.
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
  return shelfLifeExpiryDate(effectiveProductionIsoDate(closedAt, productionDate), shelfLifeDays);
}

/**
 * The field record a box label is rendered from.
 *
 * Lives here rather than in an app because more than one device computes it:
 * the station and the handheld both close boxes, and one label rule owned by
 * two apps is exactly what the root `AGENTS.md` forbids.
 *
 * `sscc` is the BARE 18 digits. The application identifier `(00)` is added
 * by the emitter and nowhere else: storing or transporting it would get an
 * export to «Честный знак» rejected.
 *
 * `date`/`expiry` are the human-readable effective production date and its
 * shelf-life expiry, in the printed `дд.мм.гггг` form — this is the BOUNDARY
 * where `formatLabelDate` is applied, and the admin preview's
 * `sampleLabelData()` applies the same function to its own samples so the two
 * can never disagree. Everything upstream (`localIsoDate`, `addCalendarDays`,
 * `expiryIsoDate`) stays on `YYYY-MM-DD` because that is what the calendar
 * arithmetic needs, and `input.closedAt` itself stays the stored UTC ISO
 * instant — only the rendering is local and reformatted, and no
 * machine-readable export reads these two fields.
 */
export function boxLabelFields(input: BoxLabelInput): Record<LabelField, string> {
  const effectiveDate = effectiveProductionIsoDate(input.closedAt, input.productionDate);
  const effectiveExpiry = shelfLifeExpiryDate(effectiveDate, input.shelfLifeDays);

  return {
    "product.name": input.productName,
    "product.printName": input.productPrintName ?? input.productName,
    "product.gtin": input.gtin14,
    "product.egais": input.egaisCode ?? "",
    "km.code": "",
    sscc: input.sscc,
    "shift.no": input.shiftNumber ?? "",
    date: formatLabelDate(effectiveDate),
    expiry: formatLabelDate(effectiveExpiry),
    qty: String(input.itemCount),
    // A box holds units, not boxes. Empty rather than "0": a zero would print
    // as «0 кор.» on any template that binds the field.
    "qty.boxes": "",
    operator: input.operatorName ?? "",
    "counterparty.name": input.counterpartyName ?? "",
  };
}

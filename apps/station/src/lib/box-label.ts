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

/**
 * «Годен до» = production date (the box's close date) + the product's shelf
 * life in days, formatted exactly like the `date` field (YYYY-MM-DD). UTC
 * date math on the date part only — the label carries no time component, so
 * local timezones must not shift the printed day.
 */
export function expiryIsoDate(closedAt: string, shelfLifeDays: number | null): string {
  if (shelfLifeDays === null || !Number.isInteger(shelfLifeDays) || shelfLifeDays <= 0) return "";
  const base = new Date(`${closedAt.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return "";
  base.setUTCDate(base.getUTCDate() + shelfLifeDays);
  return base.toISOString().slice(0, 10);
}

/**
 * The field record a box label is rendered from.
 *
 * `sscc` is the BARE 18 digits. The application identifier `(00)` is added
 * by the emitter and nowhere else: storing or transporting it would get an
 * export to «Честный знак» rejected.
 */
export function boxLabelFields(input: BoxLabelInput): Record<LabelField, string> {
  return {
    "product.name": input.productName,
    "product.gtin": input.gtin14,
    "product.egais": input.egaisCode ?? "",
    "km.code": "",
    sscc: input.sscc,
    "shift.no": input.shiftNumber ?? "",
    date: input.closedAt.slice(0, 10),
    expiry: expiryIsoDate(input.closedAt, input.shelfLifeDays),
    qty: String(input.itemCount),
    operator: input.operatorName ?? "",
    "counterparty.name": input.counterpartyName ?? "",
  };
}

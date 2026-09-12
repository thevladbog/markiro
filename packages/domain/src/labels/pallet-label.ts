import { effectiveProductionIsoDate } from "./box-label.js";
import { formatLabelDate } from "./date.js";
import type { LabelField } from "./model.js";
import { shelfLifeExpiryDate } from "./shelf-life.js";

/**
 * The field record a pallet label is rendered from.
 *
 * Lives beside `box-label.ts` and shares its date rules for the reason that
 * file gives: the station and the handheld both close pallets, and one label
 * rule owned by two apps is exactly what the root `AGENTS.md` forbids.
 *
 * The only real difference from a box is that a pallet has two counts. `qty`
 * stays PRODUCT UNITS at every level and `qty.boxes` is the box count, so a
 * clerk counting boxes at goods-in never reads a units figure by mistake.
 */
export interface PalletLabelInput {
  /**
   * The BARE 18 digits. The `(00)` application identifier is added by the
   * emitter and nowhere else: storing or transporting it gets an export to
   * «Честный знак» rejected.
   */
  sscc: string;
  boxCount: number;
  /** Units across the pallet's boxes, excluding displaced and removed items. */
  itemCount: number;
  productName: string;
  /** The catalog's short print name; null falls back to `productName`. */
  productPrintName: string | null;
  gtin14: string;
  egaisCode: string | null;
  shelfLifeDays: number | null;
  operatorName: string | null;
  counterpartyName: string | null;
  /**
   * The pallet's OWN closure moment, persisted: a recovery print the next
   * morning reads it back and stamps the same two dates rather than that
   * morning's.
   */
  closedAt: string;
  productionDate: string | null;
  /** `AUG26-003/S`; null when the mirror predates the shift-number sync. */
  shiftNumber: string | null;
}

export function palletLabelFields(input: PalletLabelInput): Record<LabelField, string> {
  const effectiveDate = effectiveProductionIsoDate(input.closedAt, input.productionDate);
  const effectiveExpiry = shelfLifeExpiryDate(effectiveDate, input.shelfLifeDays);

  return {
    "product.name": input.productName,
    "product.printName": input.productPrintName ?? input.productName,
    "product.gtin": input.gtin14,
    "product.egais": input.egaisCode ?? "",
    // A pallet is not a unit and carries no marking code.
    "km.code": "",
    sscc: input.sscc,
    "shift.no": input.shiftNumber ?? "",
    date: formatLabelDate(effectiveDate),
    expiry: formatLabelDate(effectiveExpiry),
    qty: String(input.itemCount),
    "qty.boxes": String(input.boxCount),
    operator: input.operatorName ?? "",
    "counterparty.name": input.counterpartyName ?? "",
  };
}

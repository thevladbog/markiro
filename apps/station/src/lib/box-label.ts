import type { LabelField } from "@markiro/domain";

export interface BoxLabelInput {
  sscc: string;
  itemCount: number;
  productName: string;
  gtin14: string;
  operatorName: string | null;
  counterpartyName: string | null;
  closedAt: string;
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
    "product.egais": "",
    "km.code": "",
    sscc: input.sscc,
    "shift.no": "",
    date: input.closedAt.slice(0, 10),
    expiry: "",
    qty: String(input.itemCount),
    operator: input.operatorName ?? "",
    "counterparty.name": input.counterpartyName ?? "",
  };
}

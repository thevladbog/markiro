import { gtinMatchesPrefix, isEgaisApplicable } from "@markiro/domain";
import { z } from "zod";

import type { CounterpartyRecord, OfficeProduct } from "../../host/protocol.js";
import type { ProductInput } from "../../host/requests.js";
import {
  boxCapacityRule,
  egaisCodeRule,
  gtinRule,
  palletBoxCapacityRule,
  printNameRule,
  productGroupRule,
  productNameRule,
  shelfLifeDaysRule,
  toCount,
  toGroupCode,
  toGtin14,
  toOptionalText,
} from "../../lib/rules.js";
import { activeFirstByName } from "../records.js";

/**
 * A product as the form holds it: text as typed, and the group, the two
 * templates, the A4 sheet and the default counterparty as their selects hold
 * them (`""` for none). The EGAIS code is kept while the field is hidden (the
 * group may come back to 15) and sent only with group 15.
 */
export const productFieldsSchema = z.object({
  gtin14: gtinRule,
  name: productNameRule,
  printName: printNameRule,
  chzProductGroupCode: productGroupRule,
  boxCapacity: boxCapacityRule,
  palletBoxCapacity: palletBoxCapacityRule,
  shelfLifeDays: shelfLifeDaysRule,
  defaultBoxTemplateId: z.string(),
  defaultPalletTemplateId: z.string(),
  defaultPalletSheetId: z.string(),
  egaisCode: egaisCodeRule,
  defaultCounterpartyId: z.string(),
  archived: z.boolean(),
});
export type ProductFields = z.input<typeof productFieldsSchema>;

/** The host names a product's fields as the form does (`routes/products.rs`). */
export const PRODUCT_FIELDS = {
  gtin14: "gtin14",
  name: "name",
  printName: "printName",
  chzProductGroupCode: "chzProductGroupCode",
  boxCapacity: "boxCapacity",
  palletBoxCapacity: "palletBoxCapacity",
  shelfLifeDays: "shelfLifeDays",
  egaisCode: "egaisCode",
  defaultCounterpartyId: "defaultCounterpartyId",
} as const;

/** The EGAIS field shows only for ЧЗ group 15 (the cloud's `isEgaisApplicable`). */
export function showsEgais(groupCode: string): boolean {
  return isEgaisApplicable(toGroupCode(groupCode));
}

/** Another product in use has the GTIN (`products_active_gtin14`). */
export const PRODUCT_CONFLICTS = {
  gtin14: { field: "gtin14", message: "office.products.errors.gtinTaken" },
} as const;

/**
 * The template and sheet preferences: the host checks them before the
 * revision, so a form opened before its template or sheet was deleted is
 * refused on one of them, not as `stale_revision`. The dialog treats that as a
 * stale write (`writeFailure`).
 */
export const PRODUCT_STALE_FIELDS = [
  "defaultBoxTemplateId",
  "defaultPalletTemplateId",
  "defaultPalletSheetId",
] as const;

/** A number as the form holds it: blank for none. */
function numberText(value: number | null): string {
  return value === null ? "" : String(value);
}

/** The form's values for a product, or empty ones for a new product. */
export function productFields(product: OfficeProduct | null): ProductFields {
  return {
    gtin14: product?.gtin14 ?? "",
    name: product?.name ?? "",
    printName: product?.printName ?? "",
    chzProductGroupCode: numberText(product?.chzProductGroupCode ?? null),
    boxCapacity: numberText(product?.boxCapacity ?? null),
    palletBoxCapacity: numberText(product?.palletBoxCapacity ?? null),
    shelfLifeDays: numberText(product?.shelfLifeDays ?? null),
    defaultBoxTemplateId: product?.defaultBoxTemplateId ?? "",
    defaultPalletTemplateId: product?.defaultPalletTemplateId ?? "",
    defaultPalletSheetId: product?.defaultPalletSheetId ?? "",
    egaisCode: product?.egaisCode ?? "",
    defaultCounterpartyId: product?.defaultCounterpartyId ?? "",
    archived: product?.archived ?? false,
  };
}

/**
 * The host's product fields for values the form accepted: trimmed, the GTIN
 * as its 14 digits, `null` for a field left blank.
 */
export function toProductInput(values: ProductFields): ProductInput {
  return {
    gtin14: toGtin14(values.gtin14),
    name: values.name.trim(),
    printName: toOptionalText(values.printName),
    chzProductGroupCode: toGroupCode(values.chzProductGroupCode),
    boxCapacity: toCount(values.boxCapacity),
    palletBoxCapacity: toCount(values.palletBoxCapacity),
    shelfLifeDays: toCount(values.shelfLifeDays),
    defaultBoxTemplateId: values.defaultBoxTemplateId === "" ? null : values.defaultBoxTemplateId,
    defaultPalletTemplateId:
      values.defaultPalletTemplateId === "" ? null : values.defaultPalletTemplateId,
    defaultPalletSheetId: values.defaultPalletSheetId === "" ? null : values.defaultPalletSheetId,
    egaisCode: showsEgais(values.chzProductGroupCode) ? toOptionalText(values.egaisCode) : null,
    defaultCounterpartyId:
      values.defaultCounterpartyId === "" ? null : values.defaultCounterpartyId,
  };
}

/**
 * Whether a product with these values stays a draft: the host makes it
 * `active` only with a product group and both capacities.
 */
export function staysDraft(
  values: Pick<ProductFields, "chzProductGroupCode" | "boxCapacity" | "palletBoxCapacity">,
): boolean {
  return (
    values.chzProductGroupCode === "" ||
    values.boxCapacity.trim() === "" ||
    values.palletBoxCapacity.trim() === ""
  );
}

/** Whose GS1 prefix a GTIN has. */
export type GtinOwner =
  | { kind: "own" }
  | { kind: "counterparty"; counterparty: CounterpartyRecord }
  | { kind: "unknown" };

/**
 * Whose prefix a GTIN of 14 digits has: the organization's when one of its GS1
 * prefixes matches (`gtinMatchesPrefix`), else the first counterparty's that
 * matches, else nobody's. It answers like the cloud's `checkGtinOwner`, except
 * that counterparties go active first, by name (the host keeps no creation
 * time). It informs and never blocks a save.
 */
export function gtinOwner(
  gtin14: string,
  orgPrefixes: readonly string[],
  counterparties: readonly CounterpartyRecord[],
): GtinOwner {
  if (orgPrefixes.some((prefix) => gtinMatchesPrefix(gtin14, prefix))) return { kind: "own" };
  const counterparty = activeFirstByName(counterparties).find((each) =>
    each.gs1Prefixes.some((prefix) => gtinMatchesPrefix(gtin14, prefix)),
  );
  return counterparty === undefined ? { kind: "unknown" } : { kind: "counterparty", counterparty };
}

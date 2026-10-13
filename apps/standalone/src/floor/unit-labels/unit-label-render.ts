import {
  boxLabelFields,
  DomainError,
  parseDuplicateKm,
  type LabelTemplateSpec,
} from "@markiro/domain";

import type { LabelFields, LabelPrinter } from "../print/label-render.js";
import { renderLogoLabel, type ShiftRenderDeps } from "../print/shift-render.js";
import type { WorkShift } from "../shifts/shift-copies.js";

/** How a unit's label is rendered: `unitLabelRender` by default, a test's own otherwise. */
export type RenderUnitLabel = (
  spec: LabelTemplateSpec,
  fields: LabelFields,
  printer: LabelPrinter,
) => Promise<Uint8Array>;

/**
 * The fields of the Data Matrix duplicate of one accepted unit (plan РЕЖ part
 * B, Р12): the cloud station's `duplicateLabelFields`
 * (`apps/station/src/lib/product-labels/fields.ts`) from the shift's snapshot
 * — the product, the counterparty and the shift as they were frozen, never
 * today's catalog — the shift's number and production date, the moment the
 * unit was accepted (the effective production date and the expiry follow from
 * it, as a box's from its close) and the operator who accepted it: the box
 * label's fields of one unit (`qty = 1`, no SSCC) with the full canonical code
 * in `km.code`, its group separators and crypto tail kept. A code without its
 * crypto tail cannot be duplicated (`parseDuplicateKm`, `KM_REPRINT_INCOMPLETE`)
 * and a code of another product is not this shift's
 * (`PRODUCT_LABEL_CONTEXT_INVALID`): both reject with the domain's error.
 */
export function unitLabelFields(
  shift: WorkShift,
  raw: string,
  acceptedAt: string,
  operatorName: string | null,
): LabelFields {
  const km = parseDuplicateKm(raw);
  const { product, counterpartyName } = shift.snapshot;
  if (km.gtin14 !== product.gtin14) {
    throw new DomainError(
      "PRODUCT_LABEL_CONTEXT_INVALID",
      "Product does not match the scanned code",
    );
  }
  const base = boxLabelFields({
    sscc: "",
    itemCount: 1,
    productName: product.name,
    productPrintName: product.printName,
    gtin14: product.gtin14,
    egaisCode: null,
    shelfLifeDays: product.shelfLifeDays,
    operatorName,
    counterpartyName,
    closedAt: acceptedAt,
    productionDate: shift.copy.productionDate,
    shiftNumber: shift.copy.number,
  });
  return { ...base, "km.code": km.raw, qty: "1", sscc: "" };
}

/**
 * How the unit labels of `shift` are rendered: the shift labels' own rule
 * (`renderLogoLabel`: the organization logo the shift froze, else the bundled
 * Markiro logo, for a layout with an `organization_logo` box) and
 * `renderLabel`'s choice per printer — RAW bytes in the printer's language at
 * its resolution, the code drawn as the shared GS1 raster
 * (`kmDataMatrix: "raster"`, as the cloud's duplicate, the office's preview of
 * a product duplicate and the warehouse reprint of a unit draw it), or a
 * `mono-raster-v1` page for a printer through the Windows driver.
 */
export function unitLabelRender(shift: WorkShift, deps: ShiftRenderDeps = {}): RenderUnitLabel {
  return (spec, fields, printer) =>
    renderLogoLabel(
      spec,
      fields,
      printer,
      () => Promise.resolve(shift.snapshot.organization?.logo ?? null),
      deps,
      { kmDataMatrix: "raster" },
    );
}

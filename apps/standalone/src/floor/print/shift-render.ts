import type { MonoBitmap, RasterizeTextFn } from "@markiro/domain";

import { labelLogo, loadBundledMarkiroLogo, sheetLogoOf } from "../../labels/logo.js";
import { rasterizeSheetText, rasterizeText } from "../../labels/rasterizer.js";
import { renderSheetBytes } from "../../labels/sheet-render.js";
import type { WorkShift } from "../shifts/shift-copies.js";
import { renderLabel, type LabelFields } from "./label-render.js";
import type { RenderLabel } from "./print-jobs.js";

/**
 * The one line a label without its logo leaves (the cloud station's
 * `console.error("station: box label render failed")` style): fixed text, the
 * label prints with the box empty, and nothing of the shift or the logo is in it.
 */
export const LOGO_UNAVAILABLE_LINE = "station: label logo unavailable, printing without it";

/** What a shift's render may be given instead of the app's own; tests give their own. */
export interface ShiftRenderDeps {
  rasterize?: RasterizeTextFn;
  /** The logo of a label: the shift's own, else a fallback; the app's is `labelLogo`. */
  loadLogo?: (own: MonoBitmap | null) => Promise<MonoBitmap | null>;
  /** The bundled Markiro logo the app's `loadLogo` falls back to. */
  fallbackLogo?: () => Promise<MonoBitmap>;
  /** Where the diagnostic line goes; the console by default. */
  report?: (line: string) => void;
  /** The text of an A4 sheet; the app's strict one by default (plan А4). */
  sheetRasterize?: RasterizeTextFn;
  /** The bundled Markiro logo a sheet falls back to; the app's by default (plan А4). */
  loadMarkiro?: () => Promise<MonoBitmap>;
}

/** A count of a pallet label's fields; anything but digits is a label that does not belong. */
function count(text: string): number {
  if (!/^[0-9]+$/.test(text)) throw new Error("a pallet label's count is not a number");
  return Number(text);
}

/**
 * A pallet's A4 sheet (plan А4) from the shift's snapshot alone: the sheet,
 * the organization's name, INN and logo the shift froze — the bundled Markiro
 * logo when it froze none — and the pallet's own facts from its label fields
 * (`palletLabelFields`: the SSCC, the boxes and their units). The production
 * date is the shift's; the expiry is the domain's. A shift that froze no sheet
 * or no organization (opened by a host before plan А4) does not render: the
 * job stays `failed`, and the operator prints elsewhere from the recovery.
 */
export async function renderShiftSheet(
  shift: WorkShift,
  fields: LabelFields,
  deps: ShiftRenderDeps = {},
): Promise<Uint8Array> {
  const { palletSheet, organization, product } = shift.snapshot;
  if (palletSheet === null || organization === null) {
    throw new Error("the shift froze no A4 sheet");
  }
  const own = organization.logo;
  const bitmap = own ?? (await (deps.loadMarkiro ?? loadBundledMarkiroLogo)());
  return renderSheetBytes(
    palletSheet.spec,
    {
      sscc: fields.sscc,
      productPrintName: fields["product.printName"],
      gtin14: product.gtin14,
      egaisCode: null,
      productionDate: shift.copy.productionDate,
      shelfLifeDays: product.shelfLifeDays,
      boxCount: count(fields["qty.boxes"]),
      itemCount: count(fields.qty),
      shiftNumber: fields["shift.no"] === "" ? null : fields["shift.no"],
      organizationName: organization.name,
      organizationInn: organization.inn,
      logo: sheetLogoOf(bitmap, own === null ? "markiro" : "organization"),
    },
    deps.sheetRasterize ?? rasterizeSheetText,
  );
}

/**
 * How the labels of `shift` are rendered (plan А4, #703): from the shift's
 * snapshot alone, as every label of the shift. A layout with an
 * `organization_logo` box prints the organization logo the shift froze, else
 * the bundled Markiro logo, else leaves the box empty; a layout without one
 * loads no logo. A logo that cannot be had never stops a label: the box is
 * empty and one diagnostic line says so (`LOGO_UNAVAILABLE_LINE`).
 */
export function shiftLabelRender(shift: WorkShift, deps: ShiftRenderDeps = {}): RenderLabel {
  const rasterize = deps.rasterize ?? rasterizeText;
  const report = deps.report ?? ((line: string) => console.error(line));
  const loadLogo =
    deps.loadLogo ??
    ((own: MonoBitmap | null) =>
      labelLogo(own, deps.fallbackLogo, () => {
        report(LOGO_UNAVAILABLE_LINE);
      }));
  return async (spec, fields, printer) => {
    // «Лист А4» (plan А4): the pallet's sheet from the snapshot, not the thermal label.
    if (printer.paper === "a4") return renderShiftSheet(shift, fields, deps);
    let logo: MonoBitmap | null = null;
    if (spec.elements.some((element) => element.kind === "organization_logo")) {
      try {
        logo = await loadLogo(shift.snapshot.organization?.logo ?? null);
      } catch {
        report(LOGO_UNAVAILABLE_LINE);
      }
    }
    return renderLabel(spec, fields, printer, rasterize, logo);
  };
}

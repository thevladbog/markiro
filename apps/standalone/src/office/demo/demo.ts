import type { OfficeProduct, OfficeShift } from "../../host/protocol.js";

/**
 * The wizard's demo data (spec 2026-10-21): a shift is a demo shift when its product is the demo
 * product. The office leaves demo shifts out of the day's figures, the chart, the line cards and
 * the first steps, and marks them «Демо» wherever it lists them.
 */
export function demoProductIds(products: readonly OfficeProduct[] | undefined): Set<string> {
  return new Set((products ?? []).filter((product) => product.demo === true).map((p) => p.id));
}

export function isDemoShift(
  shift: Pick<OfficeShift, "productId">,
  products: readonly OfficeProduct[] | undefined,
): boolean {
  return (products ?? []).some(
    (product) => product.id === shift.productId && product.demo === true,
  );
}

/** The shifts that are not demo shifts, in their order. */
export function withoutDemo<T extends Pick<OfficeShift, "productId">>(
  shifts: readonly T[],
  products: readonly OfficeProduct[] | undefined,
): T[] {
  const demo = demoProductIds(products);
  return shifts.filter((shift) => !demo.has(shift.productId));
}

/**
 * Whether an export format is a document for ГИС МТ (decision Д1): a demo shift goes into none,
 * as the host refuses; its TXT and CSV files may be saved, named `DEMO_…`.
 */
export function isGismtFormat(formatId: string): boolean {
  return formatId.includes("_xml_gismt_");
}

/** The name a demo shift's export file is saved under. */
export const DEMO_FILE_PREFIX = "DEMO_";

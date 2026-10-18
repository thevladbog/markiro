/** What a product's print name and full name look like to the shift screens. */
export interface ShiftProductNames {
  name: string;
  printName?: string | null | undefined;
}

/**
 * The product's title wherever a SHIFT shows it: the «наименование для печати»,
 * and the full name only when the print name is empty or blank. `fallbackName`
 * is the name the shift itself carries, for a product the screen cannot find.
 * Display only: labels, exports and the protocol keep their own fields.
 */
export function shiftProductTitle(
  product: ShiftProductNames | null | undefined,
  fallbackName = "",
): string {
  const print = product?.printName?.trim();
  if (print) return print;
  const name = product?.name ?? "";
  return name.trim() ? name : fallbackName;
}

/**
 * The status bar's shift label. The work screen's band already names the
 * product, so a numbered shift is named by its number alone; that width is
 * what keeps the line name from truncating on a 1024 px terminal.
 */
export function headerShiftLabel(
  context: { number: string | null; productName: string } | null,
  shiftId: string | null,
): string | null {
  if (shiftId === null) return null;
  if (!context) return shiftId;
  return context.number ? context.number : context.productName;
}

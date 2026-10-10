/** A civil date `YYYY-MM-DD` as the floor shows it: `ДД.ММ.ГГГГ`, never through a clock. */
export function formatCivilDate(date: string): string {
  const [year, month, day] = date.split("-");
  return year === undefined || month === undefined || day === undefined
    ? date
    : `${day}.${month}.${year}`;
}

const QUANTITY = new Intl.NumberFormat("ru-RU");

/** A count of units as the floor shows it, with the Russian thousands separator. */
export function formatQuantity(quantity: number): string {
  return QUANTITY.format(quantity);
}
